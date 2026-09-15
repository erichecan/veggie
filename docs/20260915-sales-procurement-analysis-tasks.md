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
- [x] T9 `components/boss/analytics-shared.tsx` 新增 `SearchSelectDropdown` 共享组件(服务端debounce搜索,单选/多选通用) + `searchProductOptions`/`searchCustomerOptions`/`searchSupplierOptions` 三个 fetchOptions 实现
- [x] T10 `sales-analysis/page.tsx` 改造：ViewType 简化为 list/week/detail（砍掉 pie/bar）；加自定义时间区间+维度(时间/产品/客户)+粒度下拉(周/月/季/年)；加产品/客户多选；list 视图改接服务端 `/api/analytics/margin`；**顺带修复**：时间维度按 key 升序重排(否则跟 margin 路由的毛利降序混在一起没法当时间序列看)
- [x] T11 新建 `procurement-analysis/page.tsx`：交互范式照抄 sales-analysis；供应商单选(需求5)+产品多选(需求6/7)+时间区间粒度(周/月，需求6)；视图含进货情况(按产品/按供应商切换)+库存趋势
- [x] T12 `boss/layout.tsx` 挂 procurement-analysis 导航入口（sales-analysis 已有）

### 验证与收尾
- [x] T13 `npm run build` 全绿(仅 1 次 "Compiled successfully")，`tsc --noEmit` 全程无报错
- [x] T14 curl 逐条测试新路由：鉴权(无 token 401)+多值过滤(单/双客户金额验证)+边界(无productIds 400、超10个产品 400)全过
- [x] T15 **浏览器实测(Playwright，本地开发库 boss 测试账号，localhost:3211)全部通过**：
  - sales-analysis：list 视图三维度(时间/产品/客户)+四粒度(周/月/季/年，抽测季)数字真实且時間维度已排序；产品多选筛选后数字与手算吻合(112=39+39+34)；detail 明细清单保留筛选状态，逐行date/customer/product/price/qty/amount 全对；week 视图(未改动)仍正常
  - procurement-analysis：进货情况按产品/按供应商分组均正确；supplierId 单选筛选后 Lucky Bistro 合计€8033.20 与之前 curl 独立验证的数字完全一致；库存趋势 on-hand 从0跳到260.344、周出货量39/39/34，与 StockMove 手工核对结果完全一致；月粒度切换后总量守恒(56+56=112)
  - 全程浏览器控制台/dev server 日志均无应用产生的报错(唯一1条401是测试脚本自己用错token key导致，非应用bug)
- [x] T16 两批提交(后端 7e4fe8d / 前端 20e35ba)已推送，GitHub Actions deploy-droplet 均 completed success；SSH 核实容器镜像 tag = 最新 commit，状态 healthy；首页/health/新页面路由(307未登录跳转) 全部 curl 验证过
- [x] T17 DEV-REPORT.md 已出

## 设计要点（供下一周期直接读，不用重新推导）
- 无 schema 变更，全部基于现有表/视图运行时聚合
- forecast 口径：历史实际出货量近似，非真预测算法（已跟用户确认）
- pie/bar 图表视图已砍掉，不迁移
- margin/vat/qty/price 全部走扩展后的 `/api/analytics/margin`：groupBy=day|week|month|quarter|year|product|customer|category|salesUser，filter customerId/productId 支持逗号多值
- 明细清单(需求4)、库存趋势(需求6)、采购透视(需求5/7) 各自新建独立 lib 文件+路由，不复用/不改动 AI 问数(`lib/analytics-chat/`)的共享类型，避免动一个稳定功能的四域共用代码
- StockMove 历史重建公式：`onHand(桶尾时点 t) = Product.qtyOnHand(当前) - SUM(StockMove.qty WHERE productId=P AND movedAt > t)`
