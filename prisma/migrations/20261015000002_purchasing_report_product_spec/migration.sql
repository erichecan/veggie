-- 采购分析报表加 product_spec / description（20261015）
-- ============================================================================
-- 客户要求采购分析「明细」「分层明细」两个 tab 的商品都要带规格/描述，不能只显示商品名。
-- 这两列不是新数据——PurchaseOrderLine.productSpec / description 是下单时的行快照
-- （见 20261011000001_purchase_order_line_snapshots），只是 veggie_purchasing_report
-- 视图之前没有把它们吐出来，报表层够不着。直接从 PurchaseOrderLine 取，不读 Product 实时值
-- ——跟 product_name 用同一张快照表，口径一致（商品后来改名/改规格不影响历史报表）。

DROP VIEW IF EXISTS veggie_purchasing_report;

CREATE VIEW veggie_purchasing_report AS
 SELECT pol.id,
    po.id AS purchase_order_id,
    po.name AS po_name,
    po."orderDate" AS order_date,
    po."expectedDate" AS expected_date,
    po."confirmedAt" AS confirmed_at,
    po."supplierId" AS supplier_id,
    sup.name AS supplier_name,
    sup.city AS supplier_city,
    pol."productId" AS product_id,
    pol."productName" AS product_name,
    pol."productSpec" AS product_spec,
    pol.description AS description,
    p."categoryId" AS category_id,
    COALESCE(pc.name, '未分类'::text) AS category_name,
    po.status::text AS po_status,
    pol."unitCost" AS unit_cost,
    pol."subtotalExTax" AS subtotal_ex_tax,
    pol."taxAmount" AS tax_amount,
    pol."subtotalIncTax" AS subtotal_inc_tax,
    pol."orderedQty" AS ordered_qty,
    pol."receivedQty" AS received_qty,
    pol."invoicedQty" AS invoiced_qty,
    pol."orderedQty" - pol."receivedQty" AS qty_to_receive,
    pol."bestBefore" AS best_before,
    vb.name AS vendor_bill_no,
    vb."supplierInvoiceRef" AS vendor_bill_ref,
    1 AS line_count
   FROM "PurchaseOrderLine" pol
     JOIN "PurchaseOrder" po ON po.id = pol."purchaseOrderId"
     LEFT JOIN "Customer" sup ON sup.id = po."supplierId" AND sup."isVendor" = true
     LEFT JOIN "Product" p ON p.id = pol."productId"
     LEFT JOIN "ProductCategory" pc ON pc.id = p."categoryId"
     LEFT JOIN "VendorBill" vb ON vb."purchaseOrderId" = po.id
  WHERE po.status <> 'CANCELLED'::"PurchaseOrderStatus";
