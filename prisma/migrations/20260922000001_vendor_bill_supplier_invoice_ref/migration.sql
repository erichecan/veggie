-- 采购分析明细列（20260922）
-- ============================================================================
-- 客户要求采购分析加一张明细表：按采购单逐行列出「审批日期、供应商发票参考号、
-- 系统生成的 invoice NO.、供应商、数量、金额」。
--
-- 供应商发票参考号(人工录入，收到供应商发票后核对填写)在此之前完全没有建模，
-- 加在 VendorBill 上而不是 PurchaseOrder 上——它是"这张账单对应供应商的哪张发票"，
-- 一个 PO 只生成一张 VendorBill（lib/vendor-bill-from-po.ts 幂等按 purchaseOrderId 查重），
-- 语义上属于账单而不是订单。
--
-- veggie_purchasing_report 视图同时加两列：vendor_bill_no（VendorBill.name，系统生成）、
-- vendor_bill_ref（供应商发票参考号）。LEFT JOIN 是安全的：一个 PO 至多一张 VendorBill。

ALTER TABLE "VendorBill" ADD COLUMN "supplierInvoiceRef" TEXT;

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
