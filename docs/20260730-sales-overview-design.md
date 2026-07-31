# 销售统计四项指标统一视图 — 设计文档

日期：2026-07-30

## 背景

产品文档审计发现"销售统计（日销售额/关键商品销量/客单价/缺货率）"四项指标功能都已存在，但分散在两三个不同页面：

- 日销售额：`boss/page.tsx` 首页 KPI 卡 + `sales-report`
- 关键商品销量：无统一概念，最接近的是 `SalesStats.tsx`"按商品"视图，以及未被引用的孤儿组件 `DashboardRankings`
- 客单价：只在 `boss/analytics/customers` 页面 ABC 表格里当一列
- 缺货率：`boss/page.tsx` KPI 卡 + `boss/analytics/procurement`"缺货×采购联动" tab + 波次详情页

要求把四项指标"补全相关功能"，合并出一个可用的统一视图。

## 目标用户与范围（brainstorming 结论）

两条独立改动线，都是**纯新增，不动任何现有展示逻辑**：

- **A. 新页面**：`boss/analytics/sales-overview`，老板视角看四项指标趋势，加入现有"数据分析中心"（`boss/analytics/*`）导航体系
- **B. SalesStats.tsx 增强**：调度日销页面新增"客单价""缺货率"两张只读汇总卡片

不收敛/不下线原有入口（`boss/page.tsx` 的两个 KPI 卡、`customers` 页面的客单价列都保留原样）。

## 口径确定

- **关键商品**：无需人工维护名单，按所选日期范围内 `subtotal` 汇总后自动取 Top 10，每次按范围重新计算排名。
- **客单价**：与 `customers` 路由同一公式（`salesExTax / orderCount`），按天计算即得到趋势序列，复用 `computeDayMetrics` 同源数据，不重新发明公式。
- **缺货率**：与 `/api/analytics/shortage` 现有公式完全一致（`OrderDiscrepancy` 非取消行数 / 落在 `SALES_COUNTED_STATUSES` 的订单行数，按 `deliveryDate` 口径）。

## 页面 A：`boss/analytics/sales-overview`

- 路由：`app/[locale]/classic/boss/analytics/sales-overview/page.tsx`，作为 analytics 导航第 8 个入口
- 顶部复用 `components/boss/analytics-shared.tsx` 的 `DateRangeBar`（7/30/90 天 + 自定义），默认最近 7 天
- 内容四块：
  1. 日销售额趋势——折线图，按天，ex-tax / inc-tax 两条线
  2. 客单价趋势——折线图，按天 = 当日销售额 / 当日订单数
  3. 缺货率趋势——折线图，复用 shortage 路由已有的按天序列
  4. 关键商品 Top10——表格，按所选范围内 subtotal 汇总重新排名（非趋势）
- 权限：沿用现有 analytics 鉴权 `withAuth(req, handler, ['BOSS','OPERATOR','FINANCE'])`

## 新 API：`/api/analytics/sales-overview`

一次请求返回：

```
{
  dailySeries: [{ date, salesExTax, salesIncTax, orderCount, aov }],
  shortage: { series: [...], summary: {...} },
  topProducts: [{ productName, subtotal, qty }]
}
```

- `dailySeries`：按日期范围逐日调用 `computeDayMetrics`（或已有 snapshot 缓存），取 `salesExTax/salesIncTax/orderCount`，`aov` 为派生字段（`salesExTax / orderCount`，`orderCount` 为 0 时记为 0）
- `shortage`：**唯一涉及改动现有代码的地方**——将 `/api/analytics/shortage` 路由内"缺货率计算"逻辑抽取为共享函数（放到 `lib/analytics/` 下），两个路由都调用同一份实现，避免出现两份公式各自维护、后续跑偏。抽取本身不改变现有 `/api/analytics/shortage` 路由的行为和返回格式。
- `topProducts`：新查询，`GROUP BY productName`，过滤 `Order.status IN SALES_COUNTED_STATUSES`，按 `Order.confirmationDate` 落在所选范围内，按 `SUM(subtotal)` 降序取前 10

## SalesStats.tsx 新增卡片

- 位置：现有"筛选后合计"区域旁新增两张卡片：客单价、缺货率
- 数据来源：只跟页面当前**日期**联动，不跟客户/商品筛选联动；分别调用 `/api/analytics/customers`、`/api/analytics/shortage`，取其 `summary` 里的汇总值（不是列表数据）
- 卡片标注"全部客户/全部商品"字样，明确这两个数字是全局参考值，不随左侧筛选变化
- 不改动页面现有的客户端聚合表格逻辑

## 验证计划

- 新 API 路由：`curl` 验证未带 token 返回 401、正常请求返回 200、空数据范围不报错
- 新页面：`curl` 验证路由可访问、无 500，浏览器验证图表渲染、日期切换生效
- SalesStats 新卡片：手动切换日期验证数字随之变化，与 `customers`/`shortage` 页面同日期下的数字对照一致（口径核对）
- 抽取共享缺货率函数后，回归验证 `/api/analytics/shortage` 原有响应不变（procurement 页面"缺货×采购联动" tab 展示不受影响）

## 不在本次范围内

- 不新增"客户签收单"打印单据类型（属于打印中心的另一项缺口，本次不处理）
- 不新增缺货原因字段 / "转单"操作概念（属于缺货处理的另一项缺口，本次不处理）
- 不收敛/删除任何现有分散入口
