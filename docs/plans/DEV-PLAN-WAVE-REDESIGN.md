# 波次系统重新设计 — 开发计划

## 读取的文档与上下文

- 用户确认的业务模型（对话中获取）
- 现有代码：`prisma/schema.prisma`、`app/api/waves/`、`app/[locale]/classic/operator/waves/`
- 记忆文件：`project_wave_business_model.md`、`project_picker_removed.md`

## 核心变更：从"动态生成"到"固定模板 + 手动分配"

### 现状（需要改的）
- 运营勾选已确认订单 → 按商品区域自动聚合 → 创建波次
- 波次的 zones 是按产品分区自动生成
- 波次没有日期、波次编号、类型概念

### 目标
- 每天自动生成 5 个固定波次（对应 5 个 DriverSlot）
- Wave 2 = 大货（bulk），Wave 1/3/4/5 = 散货（loose）
- 运营手动拖拽已确认订单到对应波次
- 订单整体进入一个波次，不拆分
- zones 改为按订单（按餐馆）展示，不按产品分区

---

## 模块拆解

### 1. Schema 迁移（PickingWave 表）

新增字段：
```
waveDate       DateTime    — 波次所属日期（e.g. 2026-05-27）
waveNumber     Int         — 波次编号 1-5
waveType       String      — "bulk" | "loose"
driverSlotId   String?     — 关联 DriverSlot
driverName     String?     — 冗余司机名（方便显示）
```

保留字段：
- `id`, `name`, `orderIds`, `status`, `createdAt`
- `zones` — 保留但含义变为"按餐馆分组的拣货清单"（不再是产品分区）

移除字段：
- `assignedPickerId` — 拣货员概念已移除

索引新增：
- `@@unique([waveDate, waveNumber])` — 每天每个编号只有一个波次
- `@@index([waveDate])`
- `@@index([driverSlotId])`

### 2. API 改造

#### 2a. POST /api/waves/generate-daily
- 输入：`{ date: "2026-05-27" }`（可选，默认今天）
- 逻辑：查 DriverSlot（未归档），按 batchNum 排序，为每个 slot 创建一个波次
  - `waveNumber` = slot.batchNum
  - `waveType` = batchNum === 2 ? 'bulk' : 'loose'
  - `name` = `${date} Wave ${batchNum} ${slot.driverName}`
  - `driverSlotId` = slot.id
  - `driverName` = slot.driverName
- 幂等：如果当天已有波次则跳过已存在的
- 返回创建的波次列表

#### 2b. PUT /api/waves/[id]/assign
- 输入：`{ orderIds: string[] }`
- 逻辑：
  1. 验证订单状态为 CONFIRMED
  2. 检查订单是否已在其他波次（如果是，先从原波次移除）
  3. 将 orderIds 追加到波次的 orderIds
  4. 重新生成 zones（按餐馆分组汇总拣货清单）
  5. 记录操作日志
- 返回更新后的波次

#### 2c. PUT /api/waves/[id]/unassign
- 输入：`{ orderIds: string[] }`
- 逻辑：从波次移除指定订单，重新生成 zones

#### 2d. 修改现有 GET /api/waves
- 新增查询参数：`date`（按日期过滤当天波次）
- 返回波次时附带 driverName、waveType 信息

#### 2e. 修改现有 POST /api/waves
- 保留但改为内部使用（generate-daily 调用）
- 移除旧的"从 orderIds 自动聚合 zones"逻辑

### 3. UI 改造 — waves/page.tsx（主页面，最大改动）

#### 新布局
```
┌─────────────────────────────────────────────────────┐
│  控制面板：日期选择器 | [生成今日波次] 按钮           │
├────────────────────────┬────────────────────────────┤
│  左侧：待分配订单       │  右侧：今日5个波次卡片      │
│  ┌──────────────────┐  │  ┌────────────────────┐    │
│  │ ☐ SO-001 餐馆A   │  │  │ Wave 1 (散货)      │    │
│  │ ☐ SO-002 餐馆B   │  │  │ 司机：张三          │    │
│  │ ☐ SO-003 餐馆C   │  │  │ 已分配：3个订单     │    │
│  │   ...            │  │  │ [分配选中] [查看]   │    │
│  └──────────────────┘  │  ├────────────────────┤    │
│                        │  │ Wave 2 (大货) 🚛    │    │
│                        │  │ 司机：李四          │    │
│                        │  │ ...                │    │
│                        │  └────────────────────┘    │
└────────────────────────┴────────────────────────────┘
```

#### 交互流程
1. 页面加载时自动尝试生成今日波次（调 generate-daily）
2. 左侧显示 status=CONFIRMED 且未分配到任何波次的订单
3. 运营勾选订单 → 点击某个波次卡片的"分配选中"按钮
4. 也可以从波次卡片移除订单（取消分配）
5. 点击波次卡片的"查看"进入详情页

### 4. UI 改造 — waves/[id]/page.tsx（详情页）

- 移除 `assignedPickerId` 相关 UI
- 头部显示：波次编号、日期、类型(大货/散货)、司机名
- zones 按餐馆展示（不按产品分区）
- 保留：状态流转、打印拣货单、缺货检查
- 保留：一键完成功能

### 5. Seed 数据更新

- 创建 5 个标准 DriverSlot（如果不存在）
- 为近 3 天生成固定波次
- 为部分波次分配示例订单

### 6. Trip 创建流程调整

当波次所有订单拣货完成后，可从波次一键创建 Trip：
- `waveId` = 波次 ID
- `driverId` / `driverName` = 从波次的 DriverSlot 获取
- 现有 Trip 创建逻辑基本不变

---

## 预计风险点

1. **DB 迁移**：共享 Neon DB，不能用 `prisma migrate dev`，需手写 SQL
2. **数据兼容**：现有波次数据没有 waveDate/waveNumber，迁移时需设默认值
3. **拖拽 UX**：先用"勾选+点击分配"实现，后续可升级为真正的 drag-and-drop
4. **幂等生成**：需确保同一天多次调用 generate-daily 不会重复创建

---

## 影响文件清单

| 文件 | 变更类型 |
|------|----------|
| `prisma/schema.prisma` | 修改 PickingWave model |
| `prisma/migrations/xxx_wave_redesign/migration.sql` | 新增迁移 |
| `app/api/waves/route.ts` | 重构 POST、修改 GET |
| `app/api/waves/generate-daily/route.ts` | 新增 |
| `app/api/waves/[id]/route.ts` | 小改 |
| `app/api/waves/[id]/assign/route.ts` | 新增 |
| `app/api/waves/[id]/unassign/route.ts` | 新增 |
| `app/[locale]/classic/operator/waves/page.tsx` | 大改（重新设计布局） |
| `app/[locale]/classic/operator/waves/[id]/page.tsx` | 中改（移除 picker 引用） |
| `lib/types.ts` | 修改 PickingWave 接口 |
| `prisma/seed-waves.ts` | 重写 |

---

## 架构评估

- **边界清晰**：波次 ↔ DriverSlot 是 1:1 关系（每天），波次 ↔ 订单是 1:N，波次 ↔ Trip 是 1:1
- **无单点故障**：generate-daily 是幂等操作，页面加载自动触发 + 手动按钮双保险
- **向后兼容**：现有 Trip 创建逻辑不需要大改，waveId 关联保持不变

## 性能评估

- 每天最多 5 个波次 + ~50 个订单，无 N+1 风险
- 波次列表按日期过滤，`@@index([waveDate])` 保证查询性能
- 无需分页（每天固定 5 个波次）
