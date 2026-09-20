# 采购分析：供应商 × 下单月份 · 执行台账

> 需求来源：用户 20260920 发来客户现网 Odoo 12 的 Purchase Analysis 截图，
> 要求「参考现在的 sales analysis 的模式做一个采购分析」，并指明三点差异：
> **时间维度放到横向、按月、供应商放左侧**，且「采购分析先只到月」。
> 追加一条：「**新版的交互和展示样式要和 sales analysis 一致才行**」。
>
> 两次拍板：
> 1. 做在**现有的「采购分析」页** `boss/reports/purchasing`，不新建独立页；
> 2. 月份列口径取 **下单日期 `order_date`**（与 Odoo 截图的 `Order Date is after ...` 一致）；
> 3. 「和 sales analysis 一致」指的是 **`boss/sales-analysis`（销售钻取那套紫色圆角视觉）**，
>    不是 `boss/reports/sales`。仓库里这两个页面英文标题都叫 "Sales Analysis"，
>    是用户在两张截图之间选定的。

## 开工前查到的现状（决定了方案）

1. 导航 20260920 已被裁到只剩两个分析页：**销售分析** = `boss/sales-analysis`，
   **采购分析** = `boss/reports/purchasing`。两页并排，视觉却是两套（紫色圆角 vs shadcn 方角）。
2. `boss/reports/purchasing` 原本是通用透视表（ReportingProvider + PivotTable），
   骨架与 Odoo 截图同构，**但列分组一挂日期维度就出错**：后端返回的列名是
   `order_date_month`（`sql-builder.ts` 的 `DATE_TRUNC` 别名），而 `PivotTable.tsx`
   的透视分支读 `row['order_date']` → `undefined` → 所有月份塌成同一个空列 key，
   且 `rowMap.set(colKey, …)` 是**覆盖**不是累加，只剩最后一个月的数字。
   本地实测：Connacht Produce 全量 €5401.73，加上月份列后显示 €4.63（8 月那笔）。
   行维度那侧有 `rowFieldAlias()` 做别名换算，透视分支漏用了它。
3. 另有 `boss/procurement-analysis`（「采购进货分析」，已撤出导航）与
   `boss/purchase-analysis`（从未挂过导航的孤儿页）。本轮都没动。

## 交付单元

- [x] **T1 新页面：供应商行 × 月列，视觉对齐销售分析**
      新增 `app/[locale]/classic/boss/reports/purchasing/SupplierMonthMatrix.tsx`，
      重写 `page.tsx`。照抄 `boss/sales-analysis` 的视觉语言：紫色 `#875A7B` 胶囊工具条、
      圆角白卡 `rounded-xl border shadow-sm`、`thead bg-gray-50`、`+` 展开、
      总计行置顶、「显示更多月」、「⬇ 下载 CSV」。
      数据仍走已有的 `/api/reports/purchasing`，**没有新开接口**（新路由要登记
      `route-map.ts`，也会多一条迟早跑偏的口径）。
      证据：截图 docs/shots/20260920-purchase-analysis-new.png；
      总计行 €6735.20 + €18328.37 + €2831.75 = €27895.32 与最右合计一致
      依赖：无

- [x] **T2 修透视表日期维度别名 bug（旁路修复）**
      `components/reporting/PivotTable.tsx` 的 `pivotData` 行/列 key 与 label
      一律经 `rowFieldAlias(dim)` 取值。新页面不走这条渲染路径，但
      `boss/reports/sales` / `boss/reports/logistics` 还在用它，直链可达，
      放着就是两张会静默给错数的报表。
      证据：`npm run test:reports-pivot` 新增断言 ④ 全绿（见下）
      依赖：无

- [x] **T3 日期标签格式化**
      新增 `lib/reports/date-label.ts`（`bucketLabel` / `bucketLabelShort` /
      `allSameYear` / `bucketKey`），交叉表列头、扁平表行值、下钻子行共用。
      原来列头直接印 `2026-08-01T00:00:00.000Z`。
      ⛔ 一律按 UTC 取年月日：用本地时区的话，都柏林夏令时下
      `2026-08-01T00:00:00Z` 会被读成 7 月 31 日，整列月份标签往前串一个月而数字是对的。
      证据：`tests/reports-date-label.test.ts` 6 例全过，含 Europe/Dublin 与
      Pacific/Auckland 两侧时区的显式断言
      依赖：无

- [x] **T4 列顺序固定为时间升序**
      新页面按 `'YYYY-MM'` 升序排列月份列，合计列恒在最右；
      `PivotTable` 的 `colKeys` 也补了排序。不排的话列序取决于数据到达顺序 ——
      第一家供应商恰好缺 8 月，整张表就变成 9、8、10。
      证据：截图列序 5 月 / 6 月 / 7 月 / 合计
      依赖：T2

- [x] **T5 均价口径：金额 ÷ 数量（加权）**
      在单元格 / 行合计 / 列合计 / 总计四层都是这么算的，恒等式处处成立。
      不用 `AVG(unit_cost)`：那是采购行单价的算术平均，进了透视表的合计格
      只能把若干个平均数再加起来，是个假数。
      ⚠️ **与 Odoo 口径不同**：Odoo 的 Average Price 正是算术平均，
      同一格数字会不一样（截图里 Aldi 合计 2.66 是算术平均；我们会给 53.66÷47.5=1.13）。
      这是有意选择，已写进代码注释与完成报告。
      证据：总计行 €27895.32 ÷ 1143 = €24.41，与屏幕一致
      依赖：T1

- [x] **T6 默认视角 = 打开即截图那个样子**
      默认最近 6 个月、三个度量全开、行按期间总金额倒序（老板先看花钱最多的）。
      时间窗口不设上限会让月份列一路铺到 Odoo 导入的历史数据，横向滚不完。
      度量可单独开关（对应 Odoo 的 Measures 下拉），至少保留一个。
      证据：浏览器实测关「数量」→ 表头剩金额/均价；只剩一个时再点拦住；
      恢复后顺序规范化为 金额/数量/均价
      依赖：T1

- [x] **T7 展开到商品**
      点供应商行展开该供应商的商品行，同样按月列。子请求把这一行锁成筛选条件，
      因此「商品行各列之和 == 供应商行对应列」天然成立。
      证据：Connacht 5 月 1009.20+283.00+538.50+93.75 = 1924.45 == 父行；
      6 月 1482+1155 = 2637 == 父行；7 月 345.60+490.05 = 835.65 == 父行
      依赖：T1

- [x] **T8 结果截断必须说出来**
      新页面 `limit` 5000，且 `rows.length < total` 时表头挂黄条，明确说
      「各列小计因此不完整，最右合计仍是全量」。
      顺带发现并修掉一个**既有 bug**：`buildDrillRequest` 把下钻子请求的 `limit`
      写死 200。销售报表按月下钻到商品，那个月有 454 个商品，取回前 200 个，
      子行加起来 €26294.85 而父行 €65486.93，差 60%，界面上毫无提示。
      改法：`DRILL_LIMIT = 2000` + 把 `total` 接进 drill 状态，
      截断时在子行区渲染「共 N 行，只显示前 M 行 —— 下面的明细加起来不等于上面那一行」。
      证据：探针「③ 时间维度下钻不丢末日」由 ❌ 转 ✅（子 €65486.93 == 父 €65486.93）
      依赖：T1

- [x] **T9 顺手修的两处小失真**
      · `PURCHASING_DIMENSIONS.po_status` 只列了 4 个状态，漏掉 SENT / TO_APPROVE / LOCKED
        （schema 里有 7 个非 CANCELLED 状态）。筛选面板因此筛不到这三种单，
        而界面上看不出少了选项。已补齐 + 加断言守住。
      · 导航英文标签是 "Purchasing Report"，页面标题是 "Purchase Analysis"，改成一致。
      · `reports/layout.tsx` 的 tab 条只剩一个标签（sales/logistics 已撤出导航），
        一个标签的 tab 条是噪音，且顶在页面上方破坏与销售分析的视觉一致 —— 整条移除，
        外壳退化成透传，两个页面直链仍可达。
      证据：探针「④ 采购单状态选项覆盖库里实际出现的所有状态」通过
      依赖：无

- [x] **T10 收口验证**
      · `npx tsc --noEmit` → 0 错
      · `npx eslint` 改动文件 → 0 error（1 个既有 warning 在未触碰的 FilterPanel.tsx）
      · `npm test` → 926 例，922 过，2 失败**均非本次引入**（见下）
      · `npm run build` → 通过
      · `npm run test:reports-pivot` → 23 例，21 过，0 失败，2 未获验证
      · 浏览器实测：中/英双语、展开、度量开关、显示更多月、空状态、首列钉住

## 已知不可用 / 未验证

| 项 | 状态 | 说明 |
|---|---|---|
| `tests/analytics-pivot.test.ts` 的「DIMENSION_DEFS 覆盖 9 个维度」 | ❌ 失败 | **不是本次引入**。另一个会话正在改 `lib/analytics/pivot.ts`（给销售分析加 `driver` 维度），测试里的期望值没跟着改。本轮未触碰该文件。 |
| `tests/pricing-override.test.ts` 的 2 条 | ❌ 失败 / ⏭ 跳过 | 环境问题：本机开发库里没有 ABCT 客户这个夹具。与本次改动无关。 |
| 探针「角色可见性 SALES / DRIVER」 | ⚠️ 未验证 | 探针用的销售/司机账号是 `.env.test` 的种子账号（见 `scripts/audit/_seed-credentials.ts`），本机开发库里没有这两个用户。要验证需切到 `.env.test` 库跑。 |
| 生产数据下的列宽 | ⚠️ 未验证 | 本机开发库只有 9 家供应商、3 个月。生产有上百家供应商，6 个月 × 3 度量 = 21 列，必然横向滚动。首列已钉住，但真实宽度没在生产数据上看过。 |
| 与 Odoo 的均价数字对不上 | ⚠️ 设计如此 | 见 T5。需要客户确认接受加权均价，或改回算术平均（改回的话合计格只能留空）。 |

## 边界（本轮不做）

- 不新建独立采购分析页（用户已选「改造现有页」）
- 不动 `boss/procurement-analysis`、`boss/purchase-analysis`
- 不做周/日粒度（用户明确「先只到月」）
- 不改三张 SQL 视图（`veggie_*_report`），不碰 schema
- 不碰 `boss/sales-analysis/*`、`lib/analytics/pivot.ts`、`app/api/analytics/margin/route.ts`
  —— 另一个会话正在改，避免互相覆盖
