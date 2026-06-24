# 设计：销售单交货批次 ↔ 调度中心 双向同步（单一存储 = wave）

日期：2026-06-23
状态：待评审

## 背景与问题

"订单归哪个司机/批次"目前存在**两份独立真相**，互相漂移：

- `Order.driverSlotId` + `Order.deliveryBatch`（销售单列表编辑时写入）
- `PickingWave.orderIds`（配送调度中心拖拽时写入）

两个入口各写各的、互不同步，导致用户感知到的不一致：

1. **"待分配订单" vs "销售单列表"内容不同**：待分配（`BatchTab`）以 wave 为准（订单是否在任一 wave.orderIds 里），且只取 `CONFIRMED`、再按当天 wave 过滤；销售单列表是多状态全量订单。两者过滤口径不同，是设计差异，非 bug。
2. **delivery batch 与调度中心不同步**：销售单编辑只写 `Order` 字段、不碰 wave；调度中心拖拽只写 wave、不碰 `Order`。

## 目标

实现**真正的双向**：销售单列表和调度中心两个入口都能分配司机批次，且任一处改动，对方立刻看到——**且永不漂移**。

## 关键洞察：双向 ≠ 维护两份数据对账

漂移的根源不是"双向"，而是"**两份独立存储**"。只要两个入口写的是**同一份数据**，双向就天然不漂移。

因此本设计的核心原则：

> **单一存储 = `PickingWave`。两个入口（调度中心拖拽、销售单列表选司机）都写进同一个 wave。`Order.driverSlotId/deliveryBatch` 不再作为独立真相，显示一律从订单所属的 wave 派生。**

### 为什么存储放 wave 而不是订单（调研结论）

- **业务时序悖论**：流程是"先入批拣货 → 确认出发时才填 `deliveryDate`"。CONFIRMED 订单普遍 `deliveryDate=null`（`lib/print/dispatch-loader.ts:110-132` 专门为此写了兜底）。所以不能把订单归属建立在 `deliveryDate` 上。
- **wave 已是事实上的单一归属源**：`PickingWave` 有 `@@unique([waveDate, driverSlotId])`，`assign` 时会把订单从其他 wave 剔除（`assign/route.ts:33-46`），"一张订单至多属于一个 wave"现在就成立。
- **拣货/托盘/确认出发/缺货预警全部已读 `wave.orderIds`**，它就是现成的"同一个地方"。
- `PickingWave.zones` 是纯展示快照，不承载拣货勾选状态，可安全重算。

### 司机来源对齐调度中心

调度中心的司机选项真正来源是**司机批次配置 `DriverSlot`**（`generate-daily` 按 slot 为当天建 wave）。销售单列表也必须用 `DriverSlot` 作为下拉来源——这样司机永远齐全，不依赖某天是否已生成 wave。

## 行为定义

**销售单列表交货批次列**（可编辑下拉）：
- 下拉选项 = 全部未归档的 `DriverSlot`（与司机配置页同源），显示如 `1 am BAO`。
- **选某司机批次** → 目标 wave = `(waveDate, driverSlotId)`，其中 `waveDate = 订单的 deliveryDate ?? 今天(UTC)`；该 wave 不存在则按 `generate-daily` 同款字段自动创建；再把该订单并入 wave（并自动从其原 wave 剔除）。
- **清空** → 从该订单当前所属 wave 移除。
- **显示** → 读订单所属 wave 的 `driverName`（未分配显示空）。

**调度中心**：拖拽逻辑完全不变。

两个入口都落到同一个 `(waveDate, slot)` wave，因此一致、不漂移。

## 改动点（精确清单）

### 1. 抽共享逻辑 `lib/wave-zones.ts`（DRY）
`assign/route.ts:70-149` 的 `buildZonesByRestaurant` 与 `unassign/route.ts:41-120` 的 `buildZonesForOrders` 是几乎逐字重复。抽到 `lib/wave-zones.ts` 导出 `buildZonesByRestaurant(orderIds)`，三处（assign、unassign、新接口）共用。

### 2. 新增 `app/api/orders/[id]/batch/route.ts`（PUT）
统一处理销售单列表的分配/清空。鉴权用现有 `withAuth`。

```ts
// body: { driverSlotId: string | null }
// 1. 读订单，取 deliveryDate
// 2. driverSlotId 为 null → 找该订单当前所属 wave，从 orderIds 移除 + 重算 zones；返回
// 3. driverSlotId 非空：
//    - waveDate = order.deliveryDate ?? todayUTC()
//    - 找 wave: where { waveDate, driverSlotId }；无则创建（复用 generate-daily 字段：
//      name/waveNumber/waveType/driverName/driverSlotId/waveDate/orderIds:[]/zones:[]/status:PENDING）
//    - 从其他含该 order 的 wave 剔除（同 assign 的 otherWaves 逻辑）
//    - 把 order.id 并入目标 wave.orderIds + 重算 zones
//    - 事务包裹所有 wave 写入
// 4. writeLog 审计
```

注意：只写 wave，**不写** `Order.driverSlotId/deliveryBatch`（保持单一存储）。

### 3. 后端 `app/api/orders/route.ts`（GET 列表）派生显示
取得订单后，多查一次 wave 派生司机名：

```ts
const orderIds = orders.map(o => o.id)
const waves = await prisma.pickingWave.findMany({
  where: { orderIds: { hasSome: orderIds } },
  select: { orderIds: true, driverName: true, driverSlotId: true, dispatchedAt: true },
})
const waveByOrder = new Map<string, { driverName: string | null; driverSlotId: string | null }>()
for (const w of waves) for (const oid of w.orderIds) if (!waveByOrder.has(oid)) waveByOrder.set(oid, w)
const serialized = orders.map(o => ({
  ...serializeApi(o),
  deliveryBatchDisplay: waveByOrder.get(o.id)?.driverName ?? '',
  assignedDriverSlotId: waveByOrder.get(o.id)?.driverSlotId ?? null,
}))
```

### 4. 前端 `app/[locale]/classic/operator/orders/page.tsx`
- **删除**旧写法：`saveAllBatches()`（行225-233 写 `Order` 字段）、`draftBatches`（行59）。保留/复用 `driverSlots`（行44，下拉数据源）。
- **批次列**：下拉绑定 `o.assignedDriverSlotId`，选项来自 `driverSlots`。`onChange` → `apiPut('/api/orders/${id}/batch', { driverSlotId })` → 重新 `load()`。
- 显示态用后端 `o.deliveryBatchDisplay`。

### 5. 不改（边界，控制风险）
- `waves/[id]/assign`、`unassign`、`dispatch`、`generate-daily` 的对外行为不变（assign/unassign 仅内部改为 import 共享 `buildZones`）。
- 拣货 / 分货 / 托盘 / 缺货预警 / driver-summary —— 不动（继续读 wave.orderIds）。
- `BatchTab`「待分配」—— 不动（本就以 wave 为准）。
- schema —— 不动。`Order.driverSlotId/deliveryBatch` 保留原样但不再写入（遗留字段，本次不删不迁移，YAGNI）。

## 边界情况

- **订单不在任何 wave**：批次列空 = 未分配。
- **改选另一个司机**：新接口先并入目标 wave，剔除逻辑保证从旧 wave 移除，订单至多属一个 wave。
- **订单已确认出发(IN_DELIVERY)后改批次**：仍允许写 wave；不回改 `deliveryDate`（出发时已定）。（如需禁止，可在接口加状态校验——本期默认允许，与调度中心一致。）
- **存量脏数据订单命中多个 wave**：显示取首个（`dispatchedAt` 优先），不报错。
- **目标 wave 已 `dispatchedAt`（已出发）**：仍可并入（与调度中心当前行为一致）；如需禁止后续再加。

## 验证清单

- [ ] 调度中心拖订单给某司机 → 销售单列表该订单批次列显示该司机。
- [ ] 销售单列表下拉选某司机 → 调度中心当天该司机泳道出现该订单；"待分配"中消失。
- [ ] 销售单列表清空批次 → 调度中心移除、订单回到"待分配"、列表批次列变空。
- [ ] 两入口改同一订单，最终都一致（不漂移）。
- [ ] 订单 `deliveryDate` 为空时分配 → 落到当天 wave。
- [ ] 用未携带 token 请求 `/api/orders/[id]/batch` → 401。
- [ ] `npm run build` 通过，无类型错误。

## 不做（YAGNI）

- 不删除 `Order.driverSlotId/deliveryBatch`、不做数据迁移。
- 不引入 `Order.pickingWaveId` 外键、不重构 wave.orderIds 存储结构。
- 销售单列表不加独立日期选择器（日期跟随订单 `deliveryDate`，无则当天）。
