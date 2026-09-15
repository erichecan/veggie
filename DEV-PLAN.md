# DEV-PLAN：销售/采购数据分析扩展（7 条新需求）

## 读取的文档

无独立产品文档。需求来自对话中用户直接提出的 7 条口述需求（销售 4 条 + 采购 3 条），以及此前对现有 `sales-analysis`、`reports/*`、`analytics/margin`、`analytics/procurement` 等页面的代码核实结论（详见对话记录，不重复贴出）。

## 背景：现状缺口回顾

| 需求 | 现状 |
|---|---|
| 1. 时间维度(周/月/季/年)+多产品+多客户+qty/price/untaxed/vat/total/margin | 不满足：`sales-analysis` 无月/季/年、无多选筛选，margin 硬编码 0 |
| 2. 按产品+多客户+qty/price/total/untaxed/margin | 部分满足：`margin` 页面有真实 margin，但客户筛选是单选、无季/年 |
| 3. 按客户+qty/price/untaxed/total/margin | 部分满足：同上 |
| 4. 明细点货清单(日期/客户/产品/单价/数量/金额，1-3客户×1-2产品) | 不满足：字段在 AI 问数 detail SQL 里已具备，但只支持单客户单产品筛选，且是对话入口非表单 |
| 5. 按供应商查进货 | 部分满足：`reports/purchasing` 能查，但供应商是纯文本框手输，无下拉 |
| 6. 按产品看销售数量+on hand QTY+forecast QTY，按周/月展开趋势 | 不满足：forecast 只有"当前时刻"静态快照，无历史/趋势数据基础 |
| 7. 按产品查进货 | 部分满足：同需求5，缺产品下拉选择器 |

## 复用评估结论（已调研，不重复造轮子）

- **margin(毛利)计算**：`app/api/analytics/margin/route.ts` 里已有一条成熟 SQL（JOIN `v_lot_daily_cost` 批次加权成本，查不到退 `Product.standardPrice`），数据库端一次 `GROUP BY` 聚合出 qty/untaxed/total/cost/margin，133万行 OrderLine 已在生产验证过，**直接复用这套 SQL 模式**，不重写。
- **vat(税额)**：`total_inc_tax − revenue_ex` 或 `SUM(subtotal × taxRate换算)`，在同一条聚合 SQL 里加一列即可，改动量极小。
- **明细清单**：`lib/analytics-chat/domains/sales.ts` 的 `buildDetailSql()` 字段结构（date/customer/product/unit_price/qty/subtotal）与需求4完全对应，**抽取成共享函数**，同时给 AI 问数和新接口用；过滤条件从单值 `=` 改成 `= ANY($::text[])` 支持多选。
- **时间粒度**：`lib/analytics/pivot.ts` 的 `DIMENSION_DEFS` 现有 day/week/month，quarter/year 照抄 `date_trunc` 模式各加一条即可。`lib/reports/sql-builder.ts`（reports 透视表的后端引擎）本身是纯函数、跟 UI 无耦合，天然支持五档粒度，采购侧筛选/聚合骨架直接复用它，**只是不用 `components/reporting/` 那套 UI**。
- **on-hand 历史 + forecast 趋势**：`StockMove` 表记录带符号 qty，可以"时间旅行"重建任意历史时点的 on-hand（当前 qtyOnHand − 该日期之后所有 StockMove 累计和）；forecast 现有口径是静态快照、没有"未来"概念。**这部分需要新写，且有一个产品决策悬而未决，见下方风险点第1条**。

## 模块拆解

### 1. 后端 lib 层（可复用逻辑，不跟 UI 耦合）
- 扩展 `lib/analytics/pivot.ts`：`DIMENSION_DEFS` 加 quarter/year；度量加 vat；filter 支持 productIds[]/customerIds[] 多值（`= ANY`）
- 新建 `lib/analytics/sales-detail.ts`：从 `analytics-chat/domains/sales.ts` 抽取 `buildDetailSql`，改造成支持 1-3 客户 × 1-2 产品的多值过滤，两边（AI 问数 + 新明细接口）共用一份
- 新建 `lib/analytics/stock-trend.ts`：基于 `StockMove` 重建选定产品的历史 on-hand 时间序列（按周/月分桶取桶尾时点值），forecast 先按"该分桶的历史实际出货量"近似（见风险点1）

### 2. 后端 API 层（新增/扩展路由，见下方路由清单）
- 全部挂 `withAuth` + 复用现有 `analytics.*` 权限点（预计不需要新权限点，按最小改动原则）
- 新路由必须登记 `route-map.ts`（历史教训：漏登记会导致 middleware 层全员 403，即使 withAuth 本身写对了）

### 3. 前端组件层
- `sales-analysis/page.tsx` 改造（**已定案**：砍掉 pie/bar 图表视图，只保留表格类视图，不用给三套视图分别接真实数据源）：
  - `ViewType` 从 `'pie'|'bar'|'list'|'week'` 简化为 `'list'|'week'|'detail'`：`list` 改接新的服务端透视接口（真实 qty/price/untaxed/vat/total/margin，支持按产品/客户/不分组切换），`week` 保留现有 `WeeklyDrilldown`，新增 `detail` 对应需求4的明细清单
  - 时间筛选行在现有"全部/今日/本周/本月"按钮组后加"自定义区间"（复用 `components/boss/analytics-shared.tsx` 的 `DateRangeBar` 模式）+ 粒度下拉（周/月/季/年）
  - 新增"产品多选""客户多选"两个筛选下拉，复用页面自身已有的 Measures/GroupBy 自定义下拉交互（checklist 样式，改成多选不自动关闭）
  - `WeeklyDrilldown.tsx` 保留，接口层复用同一套扩展后的 pivot 函数
- 新建 `app/[locale]/classic/boss/procurement-analysis/page.tsx`：整体交互范式照抄 `sales-analysis`（用户明确要求），筛选行含：时间区间+粒度、供应商单选下拉（需求5）、产品多选下拉（需求6/7），视图含：进货明细表、库存趋势图（on-hand+forecast 按周/月，需求6）
- `boss/layout.tsx` 补导航入口（避免重蹈"做完忘挂导航"的坑，上次刚踩过）
- 新增一个共享组件 `MultiSelectDropdown`（放 `components/boss/analytics-shared.tsx`），两个页面的产品/客户多选筛选器共用，避免重复实现

## 路由清单（新增/扩展）

| 方法 | 路径 | 用途 | 对应需求 |
|---|---|---|---|
| GET | `/api/analytics/sales-analysis/pivot` | 通用销售透视：粒度(day/week/month/quarter/year)+groupBy(none/product/customer)+多选产品/客户筛选，返回 qty/price/untaxed/vat/total/margin | 1,2,3 |
| GET | `/api/analytics/sales-analysis/detail` | 明细点货清单：1-3客户×1-2产品，逐行返回日期/客户/产品/单价/数量/金额 | 4 |
| GET | `/api/analytics/procurement-analysis/pivot` | 采购透视：供应商单选 或 产品多选 + 时间区间，返回商品/数量/金额 | 5,7 |
| GET | `/api/analytics/procurement-analysis/stock-trend` | 选定产品的 on-hand + forecast 按周/月展开趋势 | 6 |

## Schema 设计

**本次不需要新增数据库迁移。** margin/vat 靠现有 `v_lot_daily_cost` 视图+聚合 SQL；明细清单靠现有表直查；on-hand 趋势靠 `StockMove` 运行时重建（不落盘新表），控制在"选定的少数产品 × 有限时间桶"范围内，避免全表扫描性能问题。

## 风险点（已定案）

1. **forecast 口径 —— 已确认用"历史实际出货量近似"**：按周/月分桶，展示该分桶的历史实际出货数量，帮助判断囤货趋势；不是移动平均/线性回归那种真预测算法。

2. **pie/bar/list 的 margin=0 bug —— 已确认处理方式：直接砍掉 pie/bar 图表视图**，`sales-analysis` 只保留表格类视图（list 透视表 + week 钻取 + 新增 detail 明细），不需要为图表视图单独接真实数据源，改动面比"三个视图都修"更小。

3. **多选下拉的候选项来源**：产品/客户数量可能有上千个，多选下拉需要支持搜索过滤（不是把全部选项摊开），会复用现有商品/客户搜索接口做 autocomplete，不新建接口。

4. **权限**：复用现有 `analytics.*` 权限点，不新增。

## 验收标准

- `npm run build` 无报错，4 个新/改路由 curl 实测鉴权（无 token 401、正常 token 200）
- 7 条需求逐条用真实生产库数据（或本地同步数据）跑一遍，人工核对数字（尤其 margin/vat 抽查几笔订单手算对账）
- 新采购分析页面挂上导航入口并实测可点击进入（不重蹈上次孤儿页面的坑）
- pie/bar/list/week/detail 五个视图切换正常，筛选组合（时间粒度×多选产品×多选客户）不出现 500/崩溃

---

✅ 计划已确认（forecast 用历史出货近似；pie/bar 视图砍掉只留表格类视图），开始按台账推进：`docs/20260915-sales-procurement-analysis-tasks.md`。
