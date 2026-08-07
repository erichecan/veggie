# 灵活数据分析 + 提成考核 —— 需求存档（待规划）

> 记录：2026-08-07 · 状态：**已确认需求，尚未开始设计**
> 排序：排在 `docs/20260807-rbac-configurable-design-and-tasks.md`（可配置权限体系）之后。
> 理由：分析报表本身要按角色控制可见范围（外聘销售只看自己的、销售经理看团队的），
> 权限模型不定下来，分析页的数据隔离规则就得返工。

---

## 1. 需求原文（用户 2026-08-06）

> 灵活的数据分析功能，销售数据分析，采购数据分析。
> 新系统的数据分析功能：sale 或 purchase report 应保留 Odoo 12 类似的多维度、多条件、
> 可组合式分析能力 —— 多条件筛选，多维度分组，多种统计指标。
>
> CMS 分析：Product Commission 和 Customer Commission（Rate + Fixed）是用来计算和考核
> 司机的送货工作量及绩效。

---

## 2. 现状盘点（2026-08-07 实查）

### 2.1 已有的透视能力：只覆盖一个页面

`lib/analytics/pivot.ts` 有一个透视引擎（`DIMENSION_DEFS` 白名单 + `buildPivot`），
但**只接在毛利分析页**（`/classic/boss/analytics/margin`）上，能力边界见
`docs/20260731-flexible-pivot-analysis-design.md`：

- 行 × 列**两维**交叉（不支持三维及以上）
- 维度白名单：product / category / customer / salesUser / day / week / month
- 度量：销售额 / 毛利 / 毛利率 / 数量
- 筛选：日期范围 + 商品分类 / 客户 / 业务员 三个下拉
- 列数上限 60，超了返 400

那份设计明确写了「不引入跨域的通用透视引擎，本次只覆盖毛利分析这一个数据域」。
**现在用户的需求正是要跨域**：销售域、采购域都要。

### 2.2 其余分析页：预设报表，非可组合

`app/api/analytics/` 下 16 个路由（ap-aging / ar-aging / customers / internal-control /
inventory-overview / logistics / loss-dashboard / margin / overview / price-trends /
procurement / procurement-overview / sales-overview / shortage / snapshots / zone-inventory），
除 margin 外都是**固定口径 + 单维度切换**，做不到自由组合。

采购侧只有 `procurement` 和 `procurement-overview` 两个固定报表，**没有 Odoo purchase report
那样的可组合分析**。

### 2.3 提成数据：算得出来，但没有考核视角的报表

`lib/commission.ts` 是唯一计算入口，公式已实现：

```
司机提成 = 件提成 + 客户固定费 + 实送税前额 × 提成比率
  件提成   = Σ(行 commissionPrice × 实送量)   ← Product Commission
             Product.commissionPrice，fallback 到 ProductTemplate.commissionPrice
             多单位销售时按 Uom.factor 换算到基准单位
  固定费   = Order.commissionFixed             ← Customer Commission (Fixed)
  比率部分 = 实送税前额 × Order.commissionRate  ← Customer Commission (Rate)
边界：整单实送量为 0 → 固定费也不计（没去成没有辛苦费）
```

`Order.commissionRate` / `commissionFixed` 来自客户档案，下单时快照到订单。
提成冻结点已在 20260705 修好（`trips` PUT COMPLETED 批量 + `orders/[id]` PUT COMPLETED 个单）。

**缺的是分析/考核维度的报表** —— 用户这句话的落点是「计算和考核司机的送货工作量及绩效」，
也就是要能按司机 × 时间 × 客户 × 商品看提成构成、单量、送货量，做横向对比与排名。

> ⚠️ 20260802 合同功能核实探针实测：**提成冻结记录 0 单**。需要在规划时确认这是
> 「还没跑过完整行程」还是「冻结点仍未真正触发」—— 报表建在空数据上没有意义。

---

## 3. 差距清单（规划时逐条回答）

| # | 需求 | 现状 | 待定问题 |
|---|---|---|---|
| 1 | 销售分析可组合 | 仅 margin 页有两维透视 | 是把 pivot 引擎泛化成跨域通用，还是给 sales/purchase 各配一份？ |
| 2 | 采购分析可组合 | 无 | 采购的度量是什么（采购额/到货量/供应商准时率/价差）？ |
| 3 | 多维度**分组** | 只支持两维交叉 | Odoo 支持多级嵌套分组（行维度可叠 3 层），要不要做？ |
| 4 | 多条件**筛选** | 3 个固定下拉 | 要不要做成 Odoo 那种可自由增删的筛选条件行？ |
| 5 | 多种统计**指标** | 4 个 | 需要哪些？（金额/数量/单数/客户数/毛利率/环比…） |
| 6 | 提成考核报表 | 无页面 | 考核对象只有司机，还是也含销售？考核周期？排名口径？ |
| 7 | 分析结果的权限隔离 | analytics 路由现按 `['BOSS','OPERATOR','FINANCE']` 放行 | **依赖权限体系改造**：外聘销售/销售经理看到的范围要按 dataScope 收 |

---

## 4. 已知约束（规划时不能忽略）

- **性能**：droplet 2 vCPU，CPU 是瓶颈（`docs/20260805-perf-baseline-and-optimizations.md`）。
  16 个 analytics 路由已用 `withCachedAuth` 缓存（margin 1.632s → 0.019s），
  key 带 roles 防串数据。新做的可组合分析**必须考虑缓存 key 怎么设计** ——
  自由组合意味着 key 空间爆炸，缓存命中率会塌。
- **口径 SSOT**：`lib/analytics/metrics.ts` 是唯一口径来源，新报表不得另起炉灶。
- **时区**：`BUSINESS_TIMEZONE=Europe/Dublin`，日期分桶必须走这个口径
  （`docs/20260806` 那轮已统一，别退回 UTC）。
- **税口径**：`totalAmount` 是税前，`taxRate` 是百分数，销售额显示税后走派生
  `totalAmountIncTax`。提成的「实送税前额」用的是税前口径。
- **数据量**：`OrderLine` 133 万行 / 644 MB。自由组合的 GROUP BY 很容易打穿，
  要预估最坏情况并设护栏（现有 margin 透视的做法是列数上限 60）。

---

## 5. 下一步

权限体系（批 0–批 4）完成后，对本文档 §3 的 7 个待定问题逐条确认，再出设计与任务台账。
