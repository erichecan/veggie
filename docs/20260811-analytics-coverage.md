# 数据中心覆盖矩阵 · 20260811

> 台账 H1。对应需求原话：「经营看板、客户分析、商品分析可能已经有一些，但不一定全面。
> 需要和现有的界面做一个整合分析，如果没有的，需要 AI 给出一个最小的 MVP」。
>
> ⚠️ 本文先实查了全部 **17 个分析页 + 16 个分析接口**再下判断。
> G4 的教训：不查就写，会把已经存在的功能当成新需求交付。

---

## 一、现有分析面（实查全集）

**17 个页面**

| 归属 | 页面 |
|---|---|
| 老板 | `/boss`（首页看板）、`/boss/sales-report`、`/boss/sales-analysis`、`/boss/purchase-analysis` |
| 分析中心 | `/boss/analytics/` 下 8 个：`sales-overview` `customers` `margin` `procurement` `logistics` `ar-aging` `ap-aging` `internal-control` |
| 运营 | `/operator/daily-sales`（日销售中心） |
| 报表 | `/operator/reports/` 下 3 个：`sales` `purchasing` `logistics` |

**16 个接口**：`overview` `sales-overview` `customers` `margin` `procurement`
`procurement-overview` `logistics` `inventory-overview` `zone-inventory` `shortage`
`loss-dashboard` `price-trends` `ar-aging` `ap-aging` `internal-control` `snapshots`

---

## 二、覆盖矩阵：需求点名的指标 × 现状

### 需求「四、日销售管理中心」点名的四个指标

| 指标 | 现状 | 在哪 |
|---|---|---|
| 日销售额 | ✅ **已有** | `sales-overview.dailySeries`（读 `dailyBusinessSnapshot` 快照表） |
| 客单价 | ✅ **已有** | 同上，`deriveAov(salesExTax, orderCount)` |
| 缺货率 | ✅ **已有** | `sales-overview.shortage` 按天序列 + 汇总，与 `/analytics/shortage` **共用同一份计算**（`lib/analytics/shortage.ts`），不会两处跑偏 |
| 关键商品销售量 | ✅ **已有** | `sales-overview.topProducts`（按销售额 Top 10，按所选范围重新排名） |

**四项全部已实现，且是同一个接口一次返回**——设计上已经考虑了口径一致性。

### 需求「八、数据中心」点名的三块

| 模块 | 现状 | 说明 |
|---|---|---|
| 经营看板 | ✅ **已有** | `/boss` 首页 + `/analytics/overview`（老板日报一屏） |
| 客户分析 | ✅ **已有且较完整** | `analytics/customers`：活跃/新客数、**ABC 分层**（≤80% A / ≤95% B / 其余 C）、客单价、最后下单日、**流失预警名单** |
| **商品分析** | ⛔ **没有独立页面** | 商品维度散在 `sales-overview.topProducts`、`shortage`、`procurement` 三处，**没有一个「以商品为主体」的分析入口** |

---

## 三、唯一的真缺口：商品分析

### 现状

想回答「这个商品卖得怎么样」，现在要跨三个页面拼：

- 卖了多少 → 销售总览的 Top10（**只有前 10 名，第 11 名之后查不到**）
- 缺不缺货 → 缺货分析
- 采购价怎么变 → 采购分析 / `price-trends`
- 毛利多少 → 毛利分析（可透视到商品维度）
- 损耗多少 → 损耗看板

数据都有，**缺的是一个把它们按商品聚起来的视图**。

### MVP 定义（一句话）

> **商品分析页：搜一个商品，一屏看到它的销量趋势、毛利、缺货次数、损耗、采购价走势。**

具体最小实现：

| 区块 | 数据来源（全部已存在，无需新算） |
|---|---|
| 顶部：商品选择 + 期间 | 复用 `ProductSearchInput` |
| KPI 四格：销量 / 销售额 / 毛利率 / 缺货次数 | `sales-overview` + `margin` + `shortage` |
| 销量趋势（按日/周） | `snapshots` 或按 `OrderLine` 聚合 |
| 采购价走势 | `price-trends`（已有） |
| 损耗记录 | `loss-dashboard` 的 TOP 商品部分（已有金额） |
| 当前库存 + 安全库存 | `inventory-overview` |

**新增工作量**：1 个页面 + 1 个聚合接口（把上述按 `productId` 汇一次）。约 **2–3 天**。

---

## 四、次要缺口（记录，不建议本期做）

| 缺口 | 说明 | 为什么不急 |
|---|---|---|
| Top 10 之外查不到 | `topProducts` 固定 Top 10 | 商品分析页做出来后，可按商品直接查，此项自然解决 |
| 无「商品对比」 | 不能把两个商品放一起看 | 单品页先做出来再说 |
| 库存成本表 | 见 G4 报告，`qtyOnHand × standardPrice` | 已在 G4 提出，不重复 |

---

## 五、这版不做什么

- ⛔ **不新建「经营看板」** —— 已有 `/boss` 首页 + `overview` 接口
- ⛔ **不新建「客户分析」** —— 已有且含 ABC 分层与流失预警，比常见实现更完整
- ⛔ **不重做四个日销售指标** —— 日销售额/客单价/缺货率/关键商品 全部已实现，
  且共用同一份缺货计算，重做只会制造第二套口径
- ⛔ **不做整合式「大屏」** —— 需求说的是「整合分析」，指的是把散的信息按主体聚起来
  （即商品分析页），不是再堆一个总览页

---

## 六、结论

**需求里点名的三块，两块已有且完整，只有「商品分析」是真缺口。**

数据层面所有原料都已具备（销量、毛利、缺货、损耗、采购价、库存），
缺的只是一个以商品为主体的聚合视图。这也印证了本轮反复出现的判断：
**这个系统的问题很少是「没做」，多数是「做了但没有数据流经它」或「做了但入口散着」。**
