# 03 · 关键业务规则与计算逻辑

> 直接决定种子数据数值正确性的真实代码逻辑。每条标注文件:行。
> 末尾「代码缺口」一节是设计种子时必须知道的：哪些「本该自动发生」的事其实没实现。

---

## 1. 定价引擎

**文件**：`lib/server-pricing.ts`（行 1-340）+ `lib/pricing-engine.ts`（行 1-336）。
核心函数 `resolveCustomerPrice()`（pricing-engine 行 227-335），下单时由 `resolveOrderLines()`（server-pricing 行 170-195）调用。

**单价优先级（从高到低）**：
1. **客户特价 CustomerSpecialPrice**（行 252-260）—— 不论 priceType，先查 `customer.specialPrices`，按 minQty/dateStart/dateEnd 过滤命中即用。
2. 按 **priceType** 分流：
   - `default` → 直接 `product.listPrice`，忽略价格表（行 267-273）
   - `last` → 用最近售价 lastPrice，无则回退 listPrice（行 277-292）
   - `multi`（默认）→ 三级：① 客户绑定价格表规则（行 299-306）② 回退 lastPrice（行 310-321）③ 回退 listPrice（行 327-334）

**priceType 来源**：存在 Customer 与 Order 上，下单时从客户读，可按单覆写；小写归一化（multi/default/last）。
**价格表规则 `resolvePrice`**（行 43-90）：items 按 sequence 升序；匹配 applyOn(global>product>variant>category)/minQty/日期；支持嵌套价格表（深度限制）；三种计算：定价/百分比折扣/公式（带毛利边界）。
**最近售价 `queryLastSoldPrices`**（行 127-162，`/api/orders/last-price`）：扫客户最近 200 单，返回 `{productId: price}`。
**容差**：下单服务端重算，与前端报价差 >€0.01 以服务端为准（`PRICE_TOLERANCE_EUR`）。

---

## 2. 税 / VAT

**每行计税，无客户/供应商级税表**。税率存在行上（`OrderLine.taxRate` / `PurchaseOrderLine.taxRate`），来源是 `Product.customerTaxRate` / `ProductTemplate.vendorTaxRate`。

- 销售（在 `veggie_sales_report` 视图算，行 56-57）：
  - `tax_amount = subtotal × taxRate`（taxRate 为小数，如 0.13）
  - `line_total_inc_tax = subtotal × (1 + taxRate)`
  - `Order.totalAmount = Σ OrderLine.subtotal`（**不含税**；订单头不存税）
- 采购（建单时算，`purchase-orders/route.ts` 行 102-104）：`ex=qty×unitCost`，`tax=ex×taxRate`，`inc=ex+tax`，存到 POLine。

---

## 3. 司机佣金（⚠️ 未实现计算）

- 字段存在：`Trip.driverCommission`、`Customer.commissionRate`、`Order.commissionRate`（下单快照，小数如 0.02）。
- schema 注释期望：`driverCommission = Σ(订单 subtotal × commissionRate)`。
- **但代码中没有任何地方计算并写入** `Trip.driverCommission`（`trips/route.ts`、`trips/[id]/route.ts` 只读写字段，不计算）。物流视图直接取该字段值。
- 结论：**佣金计算缺失/待实现**，字段恒为初始值。种子若要让物流报表有佣金数，需自己填 `driverCommission`。

---

## 4. 业务员佣金（仅报表列，无结算）

- `veggie_sales_report` 行 77：`commission_amount = ol.subtotal × o.commissionRate`（不含税基数）。
- 报表定义 `commission_amount`（`lib/reports/definitions.ts` 行 47）可按 salesman 分组求和。
- **无任何 payout/结算逻辑、无佣金结算表** —— 只是报表里一个聚合列。

---

## 5. 库存（核心，已验证）

**出入库唯一会改 `qtyOnHand` + 写 `StockMove` 的地方**：

| 场景 | 文件:行 | 动作 |
|---|---|---|
| 下单 PENDING | `orders/route.ts` 行 291 | **不扣**（报价单阶段） |
| **订单确认 CONFIRMED** | `orders/[id]/route.ts` 行 459-484 | 每 PRODUCT 行 `qtyOnHand -= orderedQty` + `StockMove(OUT, qty=-, sourceType=ORDER)`。允许负库存不阻断 |
| 批量确认 | `orders/bulk/route.ts` 行 ~208 | 同上(OUT) |
| 确认后改行 | `orders/[id]/route.ts` 行 227-320 | 删行释放(+IN)、增量(-OUT)、减量(+IN) 差额调整 |
| 撤销已确认单 | `orders/[id]/route.ts` 行 542/588 | 回补 `qtyOnHand += qty` + StockMove(IN) |
| 拣货差异处理 | `order-discrepancies/[id]/route.ts` 行 181 | StockMove(OUT) |
| 采购退货 | `purchase-orders/[id]/route.ts` 行 317 | StockMove(OUT) |
| **采购收货** | `goods-receipts` | `qtyOnHand +=` + StockMove(IN) + 建 Lot |
| **手动调库存** | `app/api/stock-moves/route.ts` 行 25-116 | type=IN/OUT/ADJUSTMENT，改 qtyOnHand |

> 注：`orders/route.ts` POST 文档注释（行 171-173）描述了一条「确认即扣、库存不足拒单 409 INSUFFICIENT_STOCK」的设计，但实际扣减发生在确认 PUT（允许负库存）。下单 POST 本身不扣。

**FIFO / Lot**：Lot 由收货创建（sourceType=GOODS_RECEIPT），`currentQty` 随出库递减，status AVAILABLE→DEPLETED。StockMove.lotId 关联消耗批次。销售确认扣减时是否逐 Lot 扣减分摊：**确认逻辑写的是 product.qtyOnHand 整体扣减 + StockMove，未见逐 Lot FIFO 分摊**（待确认细节，批次主要由收货侧维护）。

---

## 6. 补货建议（安全库存字段未参与）

`app/api/purchase-suggestions/route.ts`（行 44-182）：
```
demand   = Σ OrderLine.orderedQty WHERE Order.status ∈ {CONFIRMED, WAVE_ASSIGNED}
shortage = max(0, demand - qtyOnHand)；shortage<=0 跳过
suggestedQty = max(shortage, supplier.minQty)
priority: shortageRate>0.8→critical, >0.5→high, else normal
```
⚠️ **`Product.safetyStockMin` 字段存在但算法未用**（待实现）。

---

## 7. 应收账龄（⚠️ 无分桶）

`app/api/finance/historical-debt/route.ts`：取每个客户**最新的 confirmed/sent 对账单**的 `closingBalance`（>0 才返回），作为「历史欠款」。
**没有 dueDate 比较、没有 0-30/31-60/61-90/90+ 账龄分桶** —— 只是「最近对账单余额」。

---

## 8. 毛利（⚠️ 未实现）

- `veggie_sales_report` **没有 cost_subtotal / 毛利 / COGS 列**；销售度量里也没有 margin。
- 成本数据存在（`Product.standardPrice`）但既不落到 OrderLine、也不进视图、也不算毛利。
- 结论：**毛利报表未实现**。要做毛利，需把成本带进 OrderLine 或视图。

---

## 9. 对账单聚合

`app/api/statements/route.ts`（行 91-132）：
```
openingBalance = 上一期 closingBalance（首期=0）
totalSales     = Σ Order.totalAmount  WHERE status ∈ {CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY,COMPLETED,LOCKED} 且 createdAt∈[periodStart,periodEnd]
totalPayments  = Σ Invoice.amountPaid WHERE status ∈ {PAID,PARTIAL} 且 createdAt∈期间
closingBalance = openingBalance + totalSales - totalPayments
```
生命周期：draft → confirmed/sent；历史欠款读最新 confirmed/sent 的 closingBalance。

---

## 10. 审批流

**订单编辑审批 `editApprovalRequired`**（`orders/[id]/route.ts` 行 104-131）：当订单处于 **CONFIRMED/WAVE_ASSIGNED** 且不改状态、却要 ① 改任何行，或 ② 改「非安全字段」时，置 `editApprovalRequired=true`。
- 安全字段（CONFIRMED 下可改不需审批）：deliveryDate/internalNote/driverSlotId/salesman/deliveryBatch/paymentMethod/各种 date。
- 解除：`PATCH /api/orders/[id]/approve-edit` `{approved:true}`。

**采购 TO_APPROVE**：`SENT→TO_APPROVE` **纯手动触发**（action=to_approve），**无金额阈值自动判定**（待确认是否有 UI 入口）。

---

## 11. 报表视图绑定

`lib/reports/definitions.ts` REPORT_REGISTRY（行 110-126）：
- sales → `veggie_sales_report`
- purchasing → `veggie_purchasing_report`
- logistics → `veggie_logistics_report`

---

## 12. 代码缺口汇总（设计种子必读）

| 能力 | 状态 | 影响种子 |
|---|---|---|
| 销售确认扣库存 | ✅ **已实现**（CONFIRMED 时） | 种子必须走真实确认逻辑，否则库存不守恒 |
| 采购收货入库 | ✅ 已实现 | 可复用 |
| 发票过账→凭证 | ✅ 已实现 | 过账即生成 JE |
| 供应商账单过账→凭证 | ❌ 未接线 | 采购侧无凭证 |
| 收款→凭证 | ❌ 未实现 | 收款无凭证 |
| 司机佣金计算 | ❌ 未实现 | 物流报表佣金需手填 |
| 业务员佣金结算 | ❌ 仅报表列 | — |
| 安全库存触发补货 | ❌ 字段未用 | 补货建议靠 demand-stock |
| 账龄分桶 | ❌ 无 | 只有 closingBalance |
| 毛利/COGS | ❌ 无 | 报表无毛利 |

> 设计种子的正确路径：**事件驱动**（走真实确认/收货/开票/收款逻辑重放），让已实现的副作用（扣库存、回写 deliveredQty/invoicedQty、发票凭证）自然发生；对未实现的部分（采购/收款凭证、司机佣金）在种子里**显式补值并断言守恒**，同时把这些缺口记为待补业务代码。详见 [seed-data-design](../20260612-seed-data-design.md)。

---

## 关联文档
[00 概览](00-overview.md) · [01 数据模型](01-data-model.md) · [02 角色与工作流](02-roles-and-workflows.md) · [04 功能与报表](04-features-and-reports.md) · [05 数据来源与种子现状](05-data-sources-and-seed-state.md)
