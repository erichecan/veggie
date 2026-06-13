# 01 · 数据模型

> 源：`prisma/schema.prisma`（约 1167 行，38 model）+ 报表 VIEW（`prisma/migrations/20260522_reporting_views/migration.sql`）。
> 每张表给：一句话职责 + 关键字段 + 关联。

---

## 1. 业务域分组总览

| 域 | 表 |
|---|---|
| 主数据 | User, Customer, Product, ProductTemplate, ProductCategory, ProductAttribute(+Value), Uom, UomCategory, ProductSupplierInfo, CustomerSpecialPrice, OdooPricelist, DriverSlot |
| 销售 | Order, OrderLine, OrderAuditLog, OrderDiscrepancy, DeliverySlip, Invoice, Payment, CreditNote, CreditNoteLine |
| 采购 | PurchaseOrder, PurchaseOrderLine, GoodsReceipt, VendorBill, PurchaseRecord |
| 库存批次 | Lot, StockMove, PurchaseSuggestion |
| 财务会计 | Account, JournalEntry, JournalEntryLine, Statement |
| 物流 | PickingWave, Trip |
| 系统 | ActionLog, Notification |

---

## 2. 主数据

| 表 | 职责 | 关键字段 | 关联 |
|---|---|---|---|
| **User** | 系统用户+认证 | email(唯一), passwordHash, role, **roles[]**, customerId, isActive, mfaSecret/mfaEnabled | createdBy→Order；customerId→Customer |
| **Customer** | 客户/供应商统一实体 | name, address/经纬度, vatNumber, **paymentTerm**, creditLimit, isCustomer, **isVendor**, **commissionRate**, defaultDriverSlotId | specialPrices, supplierInfos(反向), defaultDriverSlot；被 PurchaseOrder.supplierId 引用 |
| **Product** | 商品/SKU | templateId, name, listPrice, **standardPrice(成本基准)**, **qtyOnHand**, **safetyStockMin**, categoryId, customerTaxRate, status | template, category, supplierInfos；被 OrderLine/Lot/StockMove/POLine 引用 |
| **ProductTemplate** | 商品模板 | name, categoryId, listPrice/standardPrice, type(PRODUCT/CONSU/SERVICE), canBeSold/canBePurchased, uomId/purchaseUomId, vendorTaxRate, commissionPrice | category, saleUom/purchaseUom；← Product 变体 |
| **ProductCategory** | 商品分类 | name, nameZh, externalId | ← templates, products |
| **Uom** | 计量单位 | name, categoryId, type(REFERENCE/SMALLER/BIGGER), **factor**, rounding | category；← 模板/OrderLine/StockMove。唯一(categoryId,name) |
| **UomCategory** | 单位族 | name(唯一), nameZh | ← uoms。每族必须有且仅一个 REFERENCE 单位 |
| **ProductSupplierInfo** | 商品-供应商报价 | productId, supplierId, price, minQty, delay, dateStart/End | product, supplier(isVendor)。唯一(productId,supplierId,name) |
| **CustomerSpecialPrice** | 客户特价 | customerId, productId, minQty, **fixedPrice**, dateStart/End | customer。定价最高优先级 |
| **OdooPricelist** | 价格表 | externalId(唯一), name, **items(Json 规则)**, sequence, active | 被 Order.pricelistId / Customer 引用 |
| **DriverSlot** | 司机配送批次 | timeOfDay(am/pm), batchNum(1-5), driverName(唯一), archived | ← orders, defaultCustomers |

> 软删除：User.isActive / Product.active / ProductTemplate.status=ARCHIVED / Customer.isActive / Uom.active / DriverSlot.archived / Lot.status=DEPLETED。无硬删，FK 多为 onDelete=Cascade。

---

## 3. 销售

| 表 | 职责 | 关键字段 | 关联 |
|---|---|---|---|
| **Order** | 销售订单（报价→确认→送货→开票） | code(唯一,如 CJ-260424-001), restaurantId/Name, items(Json), totalAmount, **status**, paymentMethod(ONLINE/CASH), pricelistId, priceType, **commissionRate**, salesman, quotation/confirmation/delivery/invoiceDate, orderReturn, driverSlotId, **editApprovalRequired**, lockedAt | createdBy(User), lines, discrepancies, driverSlot；← DeliverySlip(1:1) |
| **OrderLine** | 订单行 | productId/Name, uomId, unitPrice, **taxRate**, **orderedQty/deliveredQty/invoicedQty**, subtotal | order(Cascade), product |
| **OrderAuditLog** | 订单操作审计 | userId, action(created/confirmed/withdrawn/cancelled/updated), changedFields(Json), totalBefore/After | order(Cascade) |
| **OrderDiscrepancy** | 拣货差异 | code(唯一), orderLineId, orderedQty/pickedQty/diffQty, type(SHORTAGE/SUBSTITUTE/WEIGHT_DIFF), status, resolution, substitute* | order(Cascade) |
| **DeliverySlip** | 送货单 | orderId(唯一), customerId/Name, deliveryDate | order(1:1, Cascade) |
| **Invoice** | 销售发票 | name(唯一), customerId/Name, **saleOrderIds[](软外键)**, lines(Json), subtotalExTax/totalTax/totalIncTax, **amountPaid/amountDue**, status(DRAFT/POSTED/PAID/CANCELLED), dueDate, postedAt/paidAt | ← payments |
| **Payment** | 收款流水 | invoiceId, customerId, amount, method, paidAt | invoice(Cascade)。Σpayments=Invoice.amountPaid |
| **CreditNote** | 贷记单（退货退款） | name(唯一), customerId, subtotalExTax/totalTax/totalIncTax, status(DRAFT/CONFIRMED/APPLIED/CANCELLED) | ← lines |
| **CreditNoteLine** | 贷记单行 | productId, quantity, unitPrice, taxRate, sourceOrderId, sourceTripId | creditNote(Cascade) |

---

## 4. 采购

| 表 | 职责 | 关键字段 | 关联 |
|---|---|---|---|
| **PurchaseOrder** | 采购单（询价→确认→收货→开票） | name(唯一,PO-00001), supplierId, **status**, orderDate/expectedDate, subtotalExTax/totalTax/totalIncTax, editApprovalRequired, confirmedAt/lockedAt | lines, receipts, bills |
| **PurchaseOrderLine** | 采购行 | productId, uomId, **orderedQty/receivedQty/invoicedQty**, unitCost, taxRate, subtotal*, bestBefore | purchaseOrder(Cascade) |
| **GoodsReceipt** | 收货单 | name(唯一,GR-00001), purchaseOrderId, arrivedAt, receivedBy, **lines(Json:[{productId,qty,uomId,condition}])** | purchaseOrder(Cascade) |
| **VendorBill** | 供应商账单 | name(唯一), purchaseOrderId, supplierId, billDate/dueDate, lines(Json), amountPaid/amountDue, status(DRAFT/POSTED/PAID/CANCELLED) | purchaseOrder |
| **PurchaseRecord** | 历史采购流水（兼容老数据） | productId/Name, quantity, unitCost, supplierId/supplier(文本), arrivedAt | — |

---

## 5. 库存批次

| 表 | 职责 | 关键字段 | 关联 |
|---|---|---|---|
| **Lot** | 库存批次（效期/FIFO） | lotNumber(唯一), productId, initialQty/**currentQty**, sourceType(GOODS_RECEIPT/PURCHASE_ORDER/ADJUSTMENT/RETURN), sourceId, bestBefore, status(AVAILABLE/DEPLETED) | product(Cascade), ← stockMoves。索引(sourceType,sourceId) |
| **StockMove** | 库存流水（双向） | productId, **type(IN/OUT/ADJUSTMENT/RETURN/SCRAP)**, qty, sourceType(SO/PO/RETURN/ADJUSTMENT/CREDIT_NOTE), sourceId, sourceRef, lotId, movedAt | lot(可空)。索引(sourceType,sourceId) |
| **PurchaseSuggestion** | 补货建议（算法生成） | tenantId, productId, currentStock, demandQty, suggestedQty, supplierId, estimatedCost, priority(critical/high/normal/low), status, purchaseOrderId | — |

---

## 6. 财务会计

| 表 | 职责 | 关键字段 | 关联 |
|---|---|---|---|
| **Account** | 会计科目 | code(唯一,4 位如 1100), name/nameZh, type(ASSET/LIABILITY/EQUITY/INCOME/EXPENSE/RECEIVABLE/PAYABLE), allowManual | ← JournalEntryLine |
| **JournalEntry** | 凭证 | name(唯一,JE-00001), date, narration, sourceType(invoice/vendor_bill/payment/manual), sourceId, status(DRAFT/POSTED/REVERSED), totalDebit/totalCredit | ← lines。索引(sourceType,sourceId) |
| **JournalEntryLine** | 凭证行 | accountId, debit, credit, partnerId | entry(Cascade), account。Σdebit=Σcredit |
| **Statement** | 客户对账单 | tenantId, customerId/Name, periodStart/End, **openingBalance/totalSales/totalPayments/closingBalance**, orderIds[]/invoiceIds[], status(draft/confirmed/sent) | — |

---

## 7. 物流

| 表 | 职责 | 关键字段 | 关联 |
|---|---|---|---|
| **PickingWave** | 拣货波次 | name, **orderIds[](软外键)**, zones(Json), status(PENDING/PICKING/PICKED/SORTING/SORTED), waveDate, waveNumber, driverSlotId/Name | 无直接 FK，靠 orderIds。唯一(waveDate,driverSlotId) |
| **Trip** | 司机行程 | waveId(可空), timeSlot(AM/PM), driverId/Name, departTime, status(PENDING/PENDING_ASSIGNMENT/VERIFYING/IN_PROGRESS/COMPLETED), **restaurants(Json)**, totalPayment, **driverCommission**, cashCollected/onlineCollected, settlementStatus | — |

---

## 8. 系统

| 表 | 职责 | 关键字段 |
|---|---|---|
| **ActionLog** | 全局操作审计 | userId/Email/Name, action(LOGIN/CREATE/UPDATE/DELETE), resource, resourceId, changes(Json), ipAddress, userAgent |
| **Notification** | 站内通知 | tenantId, userId, type(shortage/order_update/system), title, body, data(Json), read |

---

## 9. 枚举一览

```
Role: OPERATOR RESTAURANT PICKER SORTER DRIVER BOSS FINANCE WAREHOUSE SALES
ProductType: PRODUCT CONSU SERVICE          ProductStatus: DRAFT ACTIVE ARCHIVED
OrderStatus: PENDING CONFIRMED WAVE_ASSIGNED IN_DELIVERY COMPLETED LOCKED CANCELLED
PaymentMethod: ONLINE CASH
WaveStatus: PENDING PICKING PICKED SORTING SORTED
TripStatus: PENDING PENDING_ASSIGNMENT VERIFYING IN_PROGRESS COMPLETED
InvoiceStatus: DRAFT POSTED PAID CANCELLED   VendorBillStatus: DRAFT POSTED PAID CANCELLED
StockMoveType: IN OUT ADJUSTMENT RETURN SCRAP
UomType: REFERENCE SMALLER BIGGER
PurchaseOrderStatus: DRAFT SENT TO_APPROVE CONFIRMED RECEIVED INVOICED LOCKED CANCELLED
AccountType: ASSET LIABILITY EQUITY INCOME EXPENSE RECEIVABLE PAYABLE
JournalEntryStatus: DRAFT POSTED REVERSED    ActionType: LOGIN CREATE UPDATE DELETE
```

---

## 10. 数据库 VIEW（报表聚合源）

文件：`prisma/migrations/20260522_reporting_views/migration.sql`。报表引擎绑定见 `lib/reports/definitions.ts` 行 110-126。

### `veggie_sales_report`（行 7-90）— OrderLine 粒度
- **基表**：OrderLine ⋈ Order ⋈ Product ⋈ ProductTemplate ⋈ ProductCategory ⋈ Customer ⋈ DriverSlot ⋈ Uom。
- **过滤**：`WHERE o.status != 'CANCELLED'`。
- **关键计算**：
  - `tax_amount = ol.subtotal * COALESCE(ol."taxRate",0)`
  - `line_total_inc_tax = ol.subtotal * (1 + COALESCE(ol."taxRate",0))`
  - `commission_amount = ol.subtotal * COALESCE(o."commissionRate",0)`（行 77）
  - 物理量：total_weight / total_volume / 参考单位换算 qty
- **维度**：时间(quotation/confirmation/delivery/invoice/created)、客户(name/city/country/payment_term)、商品(name/template/category)、salesman/created_by、司机(driver_name/time_of_day/batch_num)、order_status、payment_method、uom_name。
- ⚠️ **无 cost_subtotal / 毛利**列 —— 成本不进销售视图（见 03 文档第 8 节）。

### `veggie_purchasing_report`（行 94-138）— POLine 粒度
- 基表：PurchaseOrderLine ⋈ PurchaseOrder ⋈ Customer(供应商) ⋈ Product ⋈ Template ⋈ Category。过滤 `po.status != 'CANCELLED'`。
- 度量：subtotal_ex_tax/inc_tax/tax_amount、ordered/received/invoiced_qty、`qty_to_receive = orderedQty-receivedQty`、unit_cost(AVG)。
- 维度：supplier(name/city)、product/category、po_status、order/expected/confirmed 日期。

### `veggie_logistics_report`（行 142-173）— Trip 粒度
- 基表：Trip（无 JOIN）。过滤 `t.status != 'PENDING'`。
- 度量：total_payment、driver_commission、cash/online_collected、`total_collected`、`restaurant_count = jsonb_array_length(restaurants)`、trip_count。
- 维度：driver_name/time_slot、trip_status、settlement_status、wave_id、created/settled 日期。

---

## 关联文档
[00 概览](00-overview.md) · [02 角色与工作流](02-roles-and-workflows.md) · [03 业务规则](03-business-rules.md) · [04 功能与报表](04-features-and-reports.md) · [05 数据来源与种子现状](05-data-sources-and-seed-state.md)
