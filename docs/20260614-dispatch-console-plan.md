# 配送调度中心（dispatch-console）开发计划

> 日期：2026-06-14
> 原型：`preview/20260613-batch-console.html`（已多轮确认）
> 范围（已确认）：**地基 + 托盘**；自动分批留下一期。导航**新增控制台入口，旧页保留**。
> 技术栈：沿用项目级（Next.js App Router + Prisma + PostgreSQL + Tailwind），客户端组件 + `apiGet/apiPost` + `withAuth`。

## 一、目标

把四个独立页面合并为单页 tab 控制台，并新增"托盘编排"：

| Tab | 复用/新增 | 数据来源 |
|-----|-----------|----------|
| 📦 批次管理 | waves API + **新增托盘** | `/api/waves`、`/api/waves/[id]/assign`、**新增 `/api/waves/[id]/pallets`** |
| 🧑‍✈️ 司机调度 | 新汇总视图 | `/api/trips` + `/api/orders` 聚合（每司机几家/几单/金额） |
| 🗺️ 行程管理 | 复用 trips + batch-analysis | `/api/trips`、`/api/batch-analysis`、`/api/distance-matrix` |
| ⚙️ 司机配置 | 复用 driver-slots | `/api/driver-slots` |

## 二、数据模型变更（Prisma）

新增 `Pallet`，挂在 `PickingWave` 下；托盘=自由拼货容器，可跨餐馆混装，有卸货顺序。

```prisma
model Pallet {
  id        String      @id @default(cuid())
  waveId    String
  wave      PickingWave @relation(fields: [waveId], references: [id], onDelete: Cascade)
  seq       Int         // 卸货/装车顺序：1 最先卸（车门口）
  label     String?     // 可选自定义名
  items     Json        @default("[]")
  // items: [{ orderId, restaurantId, restaurantName, productId, productName, qty, uomName }]
  createdAt DateTime    @default(now())
  updatedAt DateTime    @updatedAt
  @@unique([waveId, seq])
  @@index([waveId])
}
```

`PickingWave` 增加 `pallets Pallet[]` 反向关系。迁移名：`add_pallet`。

> 设计取舍：托盘内容用 `items` Json（与 Order.items / Wave.zones 既有风格一致，避免再建 PalletLine 表）。"待分盘池" = 波次全部订单明细 − 已入盘明细，由接口计算，不落表。

## 三、API 路由清单

| 方法 | 路由 | 作用 |
|------|------|------|
| GET | `/api/waves/[id]/pallets` | 返回该波次的托盘列表 + 待分盘池（按 items 差集算） |
| PUT | `/api/waves/[id]/pallets` | **整体保存**托盘编排（body: `{ pallets: [{seq, label, items}] }`），事务重建 |
| GET | `/api/waves/[id]/pick-sheet` | 按托盘分组的拣货单打印数据（一张=一个司机批次） |
| GET | `/api/dispatch/driver-summary?date=` | 司机调度汇总（每司机：餐馆数/订单数/品项数/金额/状态） |

全部 `withAuth` 包裹；写操作（PUT）限 OPERATOR 角色。

## 四、页面与组件

新增路由 `app/[locale]/classic/operator/dispatch-console/page.tsx`（client）。

```
dispatch-console/
  page.tsx                    # tab 框架 + 全局日期/看板
  _components/
    BatchTab.tsx              # 司机泳道(上午/下午两行) + 待分配竖条 + 托盘缩略
    PalletEditor.tsx          # 托盘编排弹窗：待分盘池 + 托盘 + 盘间互拖 + 删/加盘
    PickSheetModal.tsx        # 打印拣货单（按批次，分托盘列项）
    DriverDispatchTab.tsx     # 司机调度汇总表
    TripsTab.tsx              # 行程管理（复用 trips + 地图）
    DriverConfigTab.tsx       # 司机配置（复用 driver-slots）
```

导航：`operator/layout.tsx` 业务流程组加「配送调度中心」→ `/classic/operator/dispatch-console`；旧入口（拣货波次/配送单/司机配置）保留不动。

## 五、大改三评估

- **架构**：新页面是聚合层，调用既有 API，不动旧页面 → 旧流程零风险。托盘是 PickingWave 的子资源，边界清晰；托盘编排整体保存（非细粒度 PATCH）降低并发冲突面。
- **质量**：托盘 items 复用既有 Json 明细结构，不重复造轮子；拖拽沿用项目现有 HTML5 DnD 风格；地图复用 batch-analysis 的 Leaflet。司机调度汇总避免 N+1：一次拉 trips/orders 内存聚合。
- **性能**：批次管理一次拉「当日波次 + CONFIRMED 订单 + 客户 slim」（现有 waves 页已是此模式）；托盘 items 内联无额外查询；driver-summary 单查询内存聚合。300 单时泳道按上午/下午分行横滚，DOM 量可控。

## 六、执行顺序（逐步提交）

1. schema + 迁移（Pallet）→ `prisma generate`
2. 托盘 API（pallets GET/PUT、pick-sheet）+ driver-summary
3. dispatch-console 框架 + 司机配置 tab（最简，先打通）
4. 批次管理 tab：泳道 + 待分配 + 托盘缩略
5. 托盘编排弹窗 + 盘间互拖 + 打印拣货单
6. 司机调度汇总 tab
7. 行程管理 tab（trips + 地图）
8. 导航接入 + 端到端验证（造托盘数据、`db:validate` 不回归）

## 七、风险点

- 现有四个页面是 500–600 行大组件，直接抽取风险高 → 批次管理/调度汇总**新写**贴合原型，行程/配置尽量薄封装复用现有逻辑。
- `PickingWave` 有 `@@unique([waveDate, driverSlotId])`，托盘挂 wave 不受影响。
- 托盘明细与 `OrderLine.deliveredQty` 暂不联动（交货回写仍由 Trip 负责）；托盘只服务拣货/装车，不改既有库存/交货语义。
