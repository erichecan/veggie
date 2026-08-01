# 灵活数据分析（毛利透视模式）设计

> 生成：2026-07-31 · 需求来源：09 数据分析与 BI 决策中心 review，"灵活数据分析"子项
> 范围：本次只做「毛利分析页 → 透视模式」这一块。客户 RFM/复购率、商品 ABC/滞销/价格敏感度、
> 销售预测模型三块作为独立 spec，不在本次范围内。

## 背景

现有 7 个分析页面本质是"预设报表 + 单维度切换"：以毛利分析页为例，可选商品/分类/客户/业务员
四种分组维度，但一次只能选一个，做不到"客户×月份"这类交叉组合，筛选也只有日期范围。

## 目标

在不新建页面、不引入通用 OLAP 引擎的前提下，把毛利分析页升级出一个"透视模式"：
支持行×列两个维度交叉（含新增的日/周/月时间桶维度）、度量切换（销售额/毛利/毛利率/数量）、
三个额外筛选下拉（商品分类/客户/业务员）、CSV 导出。单维度视图保持现状不变。

## API 设计（`app/api/analytics/margin/route.ts`）

### 新增查询参数

| 参数 | 说明 |
|------|------|
| `groupBy` | 现有参数，语义变为"行维度"，取值不变：product / category / customer / salesUser |
| `colBy` | 新增，可选。取值：product / category / customer / salesUser / day / week / month |
| `categoryId` / `customerId` / `salesUserId` | 新增，可选精确过滤，默认不过滤 |

- 不传 `colBy` 时：SQL 和返回结构与现状完全一致（零回归）。
- 传 `colBy` 时：按 `(行key, 列key)` 两级 `GROUP BY`，返回：
  ```
  {
    summary: { revenueExTax, grossProfit, marginPct, costCoverageRate },  // 现有整体口径，不按格拆分
    rows: [{ key, name, subtotal: {revenueExTax, cost, grossProfit, marginPct, qty} }],   // 行头+行小计，按行小计降序
    cols: [{ key, name, subtotal: {...} }],                                                // 列头+列小计，业务维度按列小计降序；时间维度按时间正序
    cells: [{ rowKey, colKey, revenueExTax, cost, grossProfit, marginPct, qty }],          // 扁平交叉格，缺失组合前端渲染为 "—"
    grandTotal: {...},
  }
  ```

### 维度实现

- 复用现有 `GROUP_DEFS`（product/category/customer/salesUser 的 keyExpr/nameExpr/extraJoin 白名单）。
- 新增 `TIME_DEFS`：day/week/month 用 `to_char(date_trunc('day'|'week'|'month', o."confirmationDate"), 'YYYY-MM-DD'|'IYYY-"W"IW'|'YYYY-MM')` 生成 key 和展示名。
- 行列拼接时若两个维度都需要同一张表（例如同时用到 category join），按行/列分别起别名，避免冲突；`rowBy === colBy` 直接拒绝（前端禁用对方已选值 + 后端 400 兜底）。
- 所有 key/join 片段仍然只能来自代码里预先写死的白名单，不拼接任何用户输入到 SQL 文本里（沿用现有 `$queryRawUnsafe` 安全模式）。

### 保护措施

- **列数上限 60**：`colBy` 生成的 distinct 列数超过 60（典型场景：day 分桶 + 长日期范围）时，返回 400，
  提示"列数过多，请缩短日期范围或改用周/月分桶"，前端展示为红色提示条，不渲染表格。
- **行数不设上限**：与现状一致，前端保留搜索框做客户端过滤。
- **权限**：沿用现有 `['BOSS', 'OPERATOR', 'FINANCE']`，不变。
- **成本覆盖率**：透视模式下按当前筛选 + 两维度联合口径的合计计算一个整体数字（`summary` 里），不按格计算/展示。

## 前端设计（`app/[locale]/classic/boss/analytics/margin/page.tsx`）

- 顶部加模式切换：「单维度」（现状，默认）／「透视模式」。
- 透视模式控制条：
  - 行维度 / 列维度两个下拉（选项：商品/分类/客户/业务员/日/周/月），互斥彼此已选值
  - 度量下拉：销售额 / 毛利 / 毛利率 / 数量 —— 切换后矩阵单元格数值、行列小计、总计联动换算；
    行/列排序固定按销售额降序（后端返回时已排好，与现有单维度视图排序口径一致），切换度量
    只换数值显示，不重新排序，避免切换度量时行列位置跳动
  - 三个筛选下拉：商品分类 / 客户 / 业务员，默认"全部"，数据源复用现有档案列表接口
    （若现有列表接口字段过重，落地时按需加轻量 lookup 方式，不在设计阶段预先假设具体路由）
  - 日期范围沿用现有 `DateRangeBar`
- 矩阵表格：首列 = 行名 + 行小计，首行 = 列名 + 列小计，右下角 = 总计；负毛利单元格沿用现有红色高亮规则；空组合格显示 "—"。
- 「导出 CSV」按钮：前端直接把当前矩阵（含表头、小计、总计）序列化成 CSV 下载，不新增导出接口。
- 成本覆盖率黄条提示在透视模式下继续展示（整体口径提示，与维度选择无关）。

## 明确不做的事（YAGNI）

- 不引入跨域（销售/采购/司机等）的通用透视引擎，本次只覆盖毛利分析这一个数据域。
- 不支持三维及以上透视（只做行×列两维）。
- 不做行数上限/分页（沿用现状）。
- 客户 RFM/复购率、商品 ABC/滞销/价格敏感度、销售预测模型：另开 spec，不在本次范围。
