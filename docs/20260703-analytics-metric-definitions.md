# 数据分析中心 · 指标口径定义（SSOT）

> 生成：2026-07-03 · 代码落点：`lib/analytics/metrics.ts`（常量）+ `lib/analytics/snapshot.ts`（快照）
> 规则：所有 `/api/analytics/*` 与分析页面必须引用 metrics.ts，禁止自定口径。
> 数据源一律 `OrderLine` 表，**禁止读 `Order.items` JSON**（SSOT 审计 P0，见 docs/20260624）。

## 1. 三个时点口径（分开展示，不混用）

| 口径 | 时间字段 | 适用指标 |
|------|---------|---------|
| 销售口径（默认） | `Order.confirmationDate` | 销售额、毛利、客户/业务员分析、流失预警 |
| 物流口径 | `Order.deliveryDate` | 配送装载、缺货率、司机分析 |
| 财务口径 | `Invoice.invoiceDate` / `postedAt` | 开票额、应收、账龄 |

## 2. 指标定义

| 指标 | 定义 | 备注 |
|------|------|------|
| 销售额（税前） | Σ OrderLine.subtotal，Order.status ∈ SALES_COUNTED_STATUSES，按 confirmationDate 归日 | subtotal = unitPrice × orderedQty，恒税前（20260701 SSOT） |
| 销售额（税后） | Σ subtotal × (1 + taxRate/100) | taxRate 是百分数；对外展示默认税后 |
| 毛利 | Σ (unitPrice − unitCostRef) × orderedQty，税前 | unitCostRef = 商品当日加权平均批次成本（v_lot_daily_cost / Lot.unitCost），无则 fallback Product.standardPrice |
| 成本覆盖率 | 有批次成本的行金额 ÷ 总行金额 | 毛利报表必须展示；<70% 时页面黄条提示 |
| 缺货率 | Σ OrderDiscrepancy 行 ÷ Σ OrderLine 行（同日，物流口径） | |
| 退货额 | Σ CreditNote 金额（税前），按创建日 | |
| 活跃客户 | 当期 ≥1 张 SALES_COUNTED 订单的客户数 | |
| 流失预警 | 前 8~30 天 ≥2 单、近 7 天 0 单的客户 | 参数在 metrics.ts CHURN_* |
| 应收余额 | Σ Invoice.amountDue，status = POSTED 且 amountDue > 0 | InvoiceStatus 无 PARTIAL；部分收款只减 amountDue |
| 账龄分桶 | 今天 − dueDate：未到期 / 1-30 / 31-60 / 61-90 / 90+ / 未知 | dueDate 是 String 列，parse 失败归"未知"桶并计数展示 |
| 损耗额 | Σ SCRAP 数量 × 批次成本 + 盘亏 ADJUSTMENT × 成本 | 成本 fallback 同毛利 |
| 库存周转天数 | 平均库存价值 ÷ 日均出库成本（近 30 天） | |
| 到货满足率 | Σ PurchaseOrderLine.receivedQty ÷ Σ orderedQty | 按供应商/PO |
| 司机日装载 | 按 deliveryDate + 司机：单数/行数/税后金额 | |
| 司机交账差异 | Σ Payment(method=cash, 按司机日) − 当日 CASH 订单应收 | |

## 3. 成本链（缺口①的实现约定）

- `PurchaseOrderLine.unitCost` = 真实采购价（采购 UoM 下）。
- 收货（goods-receipts POST）时：`Lot.unitCost` 直接写 PO 行 unitCost —— 与既有 standardPrice 加权平均回写同口径（现有代码即以收货 qty 直接与 qtyOnHand 混加，采购 UoM 与库存单位视为一致）。
- 历史批次由 `scripts/backfill-lot-cost.ts` 按 `Lot.sourceRef → GR → PO → PO 行(productId)` 回填；回填不到保持 null。
- 毛利成本优先级：当日批次加权平均（v_lot_daily_cost）→ 最近一次有成本批次 → Product.standardPrice。

## 4. 快照规则（DailyBusinessSnapshot）

- 惰性生成：打开分析中心时补齐缺失日期（幂等 upsert）；**当天永远实时算，不写快照**；昨天及以前读快照。
- 订正（credit note / invoicedQty 晚回写）后用「重算最近 N 天」按钮（POST /api/analytics/snapshots）。
- 快照记录 computedAt，报表页展示"数据截至"。

## 5. 权限

BOSS 全部；OPERATOR：销售/缺货/物流；FINANCE：账龄/内控；WAREHOUSE：盘点。
`lib/permissions.ts` 新增 subject：`analytics`、`stock_take`。
