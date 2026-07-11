# DEV-PLAN — 「批次」概念重定义（司机批次号 = 托盘号，非独立车次）

> 更新日期：2026-07-09（v3，最终版，已通过交互原型逐项确认，进入执行）
> 前序文档：
> - v1（已发布 waves 数据安全漏洞修复）归档至 `docs/20260709-dev-plan-dispatched-wave-guard.md`
> - v2（第一版重定义提案，模型判断有误，已被 v3 推翻）归档至 `docs/20260709-dev-plan-batch-redesign-v2.md`
> - 交互原型（点击验证过）：`/private/tmp/.../20260709-batch-redesign-prototype.html`，已发布为 Artifact 逐轮确认

---

## 1. 问题确认（不变，沿用 v2）

BAO 一个上午只有**一辆车**，「1 am BAO」「3 am BAO」「4 am BAO」里的 1/3/4 是这一辆车上**第几个托盘**，不是三趟独立的车。系统把"司机+批次号"的每种组合当成完全独立、可独立发车、可独立算账的单位——这个假设错误贯穿波次/行程/提成三层。

## 2. v2 → v3 的关键修正（本轮和你逐条对齐出来的）

v2 曾提议收窄 `DriverSlot` 唯一键（去掉 batchNum），把托盘号迁到孤儿 `Pallet` 模型。**这个方向被推翻**，原因：

1. **`DriverSlot`（含 batchNum）不是错的，是被下游误用了。** 司机配置页里"1 am BAO / 2 am BAO"是预先配好的固定组合，销售单列表、订单详情页、调度台都从这份配置里选/摆，托盘号本来就该长期存在、可增删——只是不该被下游当成独立车次。
2. **销售单列表已有的行内指派交互完全不用动**：`orders/page.tsx` 编辑模式下点"批次"格子 → `DriverSlotCombobox` 可搜索下拉（选项 `"{batchNum} {timeOfDay} {driverName}"`）→ 本地暂存(●) → 批量「保存」→ `PUT /api/orders/[id]/batch`。这套机制的数据源就是 `DriverSlot`，`DriverSlot` 不改，这条链路零改动。
3. **真正要动的是 `PickingWave` 的分组粒度**：现在 `@@unique([waveDate, driverSlotId])` 把"1 am BAO"和"3 am BAO"分成两个独立波次，各自独立生成 `Trip`、独立算提成。应该改成按「司机+时段」聚合——不管配了几个托盘，同一司机同一时段的所有订单汇总进**一个**波次。
4. **孤儿 `Pallet` 模型不需要接入**——`DriverSlot.batchNum` 本身就是托盘号，调度台内部按它分组显示即可，不必再挂一层从未被前端使用过的 `Pallet`/`pick-sheet` API。

## 3. 最终模型

| 层级 | 改不改 | 说明 |
|---|---|---|
| `DriverSlot`（含 batchNum） | **不改 schema**，管理面维持现状 | 司机配置页可增删；删除一个有订单挂着的 DriverSlot 时，这些订单的 `driverSlotId` 要清空、订单退回"待分配"——原型里"删除托盘→订单回待分配"就是这条规则的可视化 |
| `PickingWave` | **改**：分组键从 `[waveDate, driverSlotId]` 改为 `[waveDate, driverName, timeOfDay]` | 新增 `timeOfDay String?` 字段（`driverName` 已有，照抄同样的"快照字段"模式）；`orderIds` 汇总同一司机同一时段下所有 DriverSlot 名下的订单 |
| `Trip` / 提成 | **不改代码**，随波次粒度自动修正 | 一个波次一趟车一笔提成，`lib/trip-from-wave.ts`、`lib/commission.ts` 现有的 1:1-per-wave 逻辑不用碰 |
| `Order.driverSlotId` | **不当 SSOT**（本来就是；仓库已有 P0-1 结论：`Order.driverSlotId`/`deliveryBatch` 是废弃字段，"这单归哪辆车"只认 `PickingWave.orderIds[]`） | 波次合并后这条 SSOT 规则不变，`wave.orderIds` 继续是唯一真相，下游（打印/拣货单/提成）零改动 |
| `Pallet`（原孤儿模型，重新启用） | **接入**，不新建表 | 波次内部"这单在第几个托盘"这层信息，波次分离没了之后必须有地方记，`Pallet.waveId + seq + items` 正好是这个粒度；`assignOrderToWave` 在写 `wave.orderIds` 的同时，按 `driverSlot.batchNum` 自动找/建对应 `Pallet` 并把该订单整单的商品行塞进去（一期不支持拆单到多托盘，整单进一个 Pallet） |
| 调度台 `BatchTab.tsx` | **改**：卡片粒度从"每个 DriverSlot 一张"改成"每个（司机+时段）波次一张" | 卡片内部按该波次下的 `Pallet` 列表渲染托盘 lane（`pallet.items` 里的 orderId 反查是哪些订单）；出发/完成/拣货锁等状态和按钮全部挂在波次（整张卡片）上，不挂在托盘上——避免"某个托盘单独出发"这种不合逻辑状态 |
| `DriverDispatchTab.tsx` | **改**：页脚"共 X 个批次 · X 趟"的批次数不再等同于车次数，按波次数统计 | |

## 4. 已用交互原型逐项验证过的规则（作为实现验收标准）

1. 一张司机卡片 = 一个（司机, 时段）波次；卡片头统计"N 单 · N 个托盘（一趟车）"。
2. 卡片有「📦 订单视图」（平铺只读总览）/「🗂 托盘视图」（可操作）切换；实际改派只在托盘视图里发生。
3. 拖拽语义：拖进同司机的另一个托盘 = 纯重新码放；拖进别的司机的托盘 = 真正改派（车也变）；拖回左侧待分配 = 从这辆车移出，订单退回"未指派"状态（对应 `driverSlotId = null`）。
4. **不存在"分配给司机但未指定托盘"的中间态**——订单要么在具体某个托盘，要么在待分配池，没有第三态。
5. 托盘可以在调度台里直接新增/删除；删除一个非空托盘，里面的订单自动退回待分配池（对应把这些订单的 `driverSlotId` 清空）。
6. 销售单列表页的行内指派（点批次格子→可搜索下拉→暂存●→批量保存）和调度台拖拽是**同一份数据的两个写入口**，互相同步，UI 和交互都不需要改，只是它们共同依赖的波次聚合逻辑要修对。

## 5. 影响范围清单

| 文件 | 改动 |
|---|---|
| `prisma/schema.prisma` | `PickingWave` 加 `timeOfDay` 字段，唯一键改为 `[waveDate, driverName, timeOfDay]`；`driverSlotId` 降级为非唯一性字段（合并波次后不再代表单一 DriverSlot，仅留兼容）；写正式 migration |
| `lib/wave-assign.ts` | `assignOrderToWave` 改成按（driverName, timeOfDay）找/建波次；额外调用新增的 `assignOrderToPallet(waveId, orderId, batchNum)`，自动找/建 `Pallet{waveId, seq: batchNum}` 并把订单整单商品行写入；`removeOrderFromAllWaves` 同步清理该订单在所有 `Pallet.items` 里的行 |
| `app/api/waves/[id]/assign,unassign/route.ts` | 逻辑基本不变（反正现在同司机同时段只有一个波次），需要跟着新的波次查找方式回归测试 |
| `app/api/driver-slots/route.ts` + 新增 `DELETE` | 司机配置页/调度台共用同一套 DriverSlot 增删：删除一个 DriverSlot 时，级联删除其在当前波次下对应的 `Pallet`，该 Pallet 里的订单整单退出 `wave.orderIds`（回待分配），保证两个入口（销售单下拉框可选项、调度台托盘 lane）永远同步 |
| `BatchTab.tsx` | 卡片粒度改造：改为按波次渲染，卡片内部按该波次下的 `Pallet` 列表渲染托盘 lane；「+新增托盘」= 建新 DriverSlot（batchNum = 当前最大值+1）；「✕删除托盘」= 走上面的级联删除 |
| `DriverDispatchTab.tsx` | 页脚统计口径改为"按波次数"，不再等同批次数 |
| `orders/page.tsx`、`orders/[id]/page.tsx`、`quotations/[id]/page.tsx` | **不改**——指派交互和数据源都不变 |
| `lib/trip-from-wave.ts`、`lib/commission.ts` | **不改代码**，仅需针对新分组跑一遍回归验证 |

## 6. 历史数据处理策略

**已发生的 Trip / 提成记录一律不动**——不回溯合并、不重算、不改写，理由同 v2：这些记录可能已经和司机对过账，事后拆散重组风险极高。

迁移脚本（沿用本仓库两段式：只读诊断 + `--apply`）：
1. 找出所有"同司机同时段"存在多个 `PickingWave`（即现在的 1/3/4 分裂）的分组
2. **未出发**（`dispatchedAt = null`）的波次：合并 `orderIds`，挑一条存活（优先挑已绑定 `userId` 的 DriverSlot 对应的那条），其余波次 `archived`/软删除
3. **已出发/已完成**的波次原样不动，包括它们已生成的 Trip——这部分"一辆车被拆成多笔提成"的历史事实保留，不纠正
4. 收尾报告：合并了多少组、影响多少订单

## 7. 执行状态（2026-07-10 更新）

第一期代码已全部写完并本地验证通过：

- ✅ `prisma/schema.prisma`：`PickingWave` 加 `timeOfDay`，唯一性约束改为应用层保证（同司机同时段未出发波次只能有一条），迁移 `20260709000000_wave_time_of_day` 已应用；存量 391 条波次已跑 `scripts/backfill-wave-timeofday.ts` 回填。
- ✅ `lib/wave-assign.ts`：`assignOrderToWave` 按司机+时段找/建波次，新增 `assignOrderToPallet`/`removeOrderFromPalletsInWave`/`putOrderIntoPallet`/`deletePalletForDriverSlot`，`getOrderWaveDisplayMap`/`getOrderWaveDriverSlotMap` 改为按托盘反查。
- ✅ `app/api/waves/[id]/assign,unassign`：新增 `driverSlotId` 参数联动 Pallet；`app/api/waves/route.ts`/`generate-daily`：按司机+时段建波次、返回 `pallets`。
- ✅ `app/api/driver-slots/[id]`：归档(DELETE/PUT archived:true)联动清空该托盘在未出发波次里的订单，退回待分配。
- ✅ `BatchTab.tsx` 重写为一卡片=一波次+托盘 lane（订单视图/托盘视图切换、拖拽改派、＋新增/✕删除托盘）；`DriverDispatchTab.tsx` 页脚统计改按波次数。
- ✅ 本地验证：`tsc --noEmit`/`eslint` 全绿；curl 端到端跑通「同司机不同托盘指派→合并进同一波次→各自落进对应 Pallet」「同波次托盘间重新码放」「删除托盘→订单退回待分配、Pallet/wave.orderIds 同步清理」，dev server 日志无报错。
- ✅ 只读诊断脚本 `scripts/diagnose-duplicate-driver-waves.ts` 已跑：历史遗留「同司机同时段多条未出发波次」共 **48 组 / 149 条波次 / 38 个不重复订单**（几乎全是 generate-daily 预建的空波次，真正带订单的分组不多）；另有 **2 组**已出发/已完成的历史重复波次，按方案原样不动。

## 8. 待你确认的下一步

只读诊断已经跑完，**合并未出发重复波次的 `--apply` 脚本还没写、也没执行**，需要你确认：

1. 48 组历史重复波次是否现在就合并（大多是空的，风险很低），还是挑一个你指定的时间点执行？
2. 确认后我再写两段式的 `--apply` 合并脚本（只动这 48 组里 `dispatchedAt IS NULL` 的波次，已出发/已完成的 2 组保留不动）。
