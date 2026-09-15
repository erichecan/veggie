# 销售/采购数据分析扩展 — 任务台账

计划见 `DEV-PLAN.md`。这里是唯一进度真相，每周期从这里读起，不凭记忆。

（注：本文件首次写入时误把全部任务标成 [x]，20260915 当场发现并订正为真实状态，之后严格照实更新。）

## 状态图例
- [ ] 未开始　[~] 进行中　[x] 已完成　[!] 卡住/需决策

## 任务清单

### 后端 lib 层
- [x] T1 复用而非新建：扩展 `lib/analytics/pivot.ts`（DIMENSION_DEFS 加 quarter/year）+ `/api/analytics/margin/route.ts`（customerId/productId 支持逗号分隔多值→`= ANY`，新增 vat/avgPrice 字段）。放弃另建 sales-analysis/pivot 路由——margin 路由已完全覆盖需求1/2/3，改动纯增量不破坏现有 margin 页面调用方。`tsc --noEmit` 全绿。
- [x] T2 新建 `lib/analytics/sales-detail.ts`：独立实现，支持 customerIds[]/productIds[] 多值过滤。curl 实测：宽时间范围2000行截断(truncated:true)正常；2客户×2产品组合过滤精确收窄到7行
- [x] T3 新建 `lib/analytics/stock-trend.ts`：StockMove 历史重建 on-hand + forecast=历史实际出货量。**手工核对通过**：RTE Avocado CASE 唯一一条 StockMove(2026-07-17 ADJUSTMENT +260.344)，API 在 bucketEnd=07-13 前后的 on-hand 从 0 跳到 260.344，与直接查 StockMove 反推手算完全一致

### 后端 API 层
- [x] T4 （已并入 T1，不再单独建路由）
- [x] T5 `GET /api/analytics/sales-analysis/detail`（需求4）curl 实测通过
- [x] T6 `GET /api/analytics/procurement-analysis/pivot`（需求5/7）curl 实测：groupBy=product/supplier 均正常，supplierId 单选过滤后金额与该供应商在 groupBy=supplier 结果里的金额对得上(8033.2)
- [x] T7 `GET /api/analytics/procurement-analysis/stock-trend`（需求6）curl 实测：无 productIds 正确 400，超10个产品正确 400，week 粒度返回正常
- [x] T8 新路由登记 `lib/rbac/route-map.ts`（sales-analysis/detail 复用 analytics.margin.read；procurement-analysis/* 复用 analytics.purchase_detail.read）；无 token 全部 401 已验证

### 前端
- [ ] T9 `components/boss/analytics-shared.tsx` 新增 `MultiSelectDropdown` 共享组件
- [ ] T10 `sales-analysis/page.tsx` 改造：ViewType 简化为 list/week/detail（砍掉 pie/bar）；加自定义时间区间+粒度下拉(周/月/季/年)；加产品/客户多选；list 视图改接服务端透视接口(margin route)
- [ ] T11 新建 `procurement-analysis/page.tsx`：交互范式照抄 sales-analysis；供应商单选+产品多选+时间区间粒度；视图含采购明细+库存趋势
- [ ] T12 `boss/layout.tsx` 挂 procurement-analysis 导航入口（sales-analysis 已有）

### 验证与收尾
- [ ] T13 `npm run build` / `tsc --noEmit` 全绿
- [ ] T14 curl 逐条测试新路由的鉴权与返回 shape
- [ ] T15 浏览器实测（Playwright）：筛选组合(时间粒度×多选产品×多选客户)不崩、数字与生产库抽查一致、导航可点击进入
- [ ] T16 提交 + 部署 + 生产验证
- [ ] T17 出 DEV-REPORT.md

## 设计要点（供下一周期直接读，不用重新推导）
- 无 schema 变更，全部基于现有表/视图运行时聚合
- forecast 口径：历史实际出货量近似，非真预测算法（已跟用户确认）
- pie/bar 图表视图已砍掉，不迁移
- margin/vat/qty/price 全部走扩展后的 `/api/analytics/margin`：groupBy=day|week|month|quarter|year|product|customer|category|salesUser，filter customerId/productId 支持逗号多值
- 明细清单(需求4)、库存趋势(需求6)、采购透视(需求5/7) 各自新建独立 lib 文件+路由，不复用/不改动 AI 问数(`lib/analytics-chat/`)的共享类型，避免动一个稳定功能的四域共用代码
- StockMove 历史重建公式：`onHand(桶尾时点 t) = Product.qtyOnHand(当前) - SUM(StockMove.qty WHERE productId=P AND movedAt > t)`
