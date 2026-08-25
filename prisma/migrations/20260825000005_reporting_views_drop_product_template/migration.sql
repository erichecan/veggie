-- ============================================================================
-- 合表重构 T5（2026-08-25）：报表视图去掉 ProductTemplate join
-- ============================================================================
-- veggie_purchasing_report / veggie_sales_report 原来 LEFT JOIN ProductTemplate
-- 取 weight/volume/categoryId 兜底，字段已在 T3 并入 Product，这里直接改读 Product。
-- product_template_id / product_template_name 两列一并去掉——lib/reports/definitions.ts
-- 核实过，SALES_DIMENSIONS/SALES_MEASURES 从未暴露这两列，删除不影响报表功能。
-- 必须在 Product.templateId 列被删之前重建（同一批迁移里顺序在前）。
-- ============================================================================

-- 去掉了 product_template_id 列（改 REPLACE 会报 cannot drop columns from view），必须先 DROP。
DROP VIEW IF EXISTS veggie_purchasing_report;
DROP VIEW IF EXISTS veggie_sales_report;

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
    1 AS line_count
   FROM "PurchaseOrderLine" pol
     JOIN "PurchaseOrder" po ON po.id = pol."purchaseOrderId"
     LEFT JOIN "Customer" sup ON sup.id = po."supplierId" AND sup."isVendor" = true
     LEFT JOIN "Product" p ON p.id = pol."productId"
     LEFT JOIN "ProductCategory" pc ON pc.id = p."categoryId"
  WHERE po.status <> 'CANCELLED'::"PurchaseOrderStatus";

CREATE VIEW veggie_sales_report AS
 SELECT ol.id,
    o.id AS order_id,
    o.code AS order_code,
    o."quotationDate" AS quotation_date,
    o."confirmationDate" AS confirmation_date,
    o."deliveryDate" AS delivery_date,
    o."invoiceDate" AS invoice_date,
    o."createdAt" AS created_at,
    o."restaurantId" AS customer_id,
    o."restaurantName" AS customer_name,
    c.city AS customer_city,
    c.country AS customer_country,
    c."paymentTerm" AS payment_term,
    ol."productId" AS product_id,
    ol."productName" AS product_name,
    p."categoryId" AS category_id,
    COALESCE(pc.name, '未分类'::text) AS category_name,
    su.name AS salesman,
    o."createdById" AS created_by_id,
    o."createdByName" AS created_by_name,
    o."driverSlotId" AS driver_slot_id,
    ds."driverName" AS driver_name,
    ds."timeOfDay" AS time_of_day,
    ds."batchNum" AS batch_num,
    o.status::text AS order_status,
    o."paymentMethod"::text AS payment_method,
    ol."uomId" AS uom_id,
    ol."uomName" AS uom_name,
    ol."unitPrice" AS unit_price,
    ol.subtotal AS line_subtotal,
    o."totalAmount" AS order_total,
    ol."taxRate" AS tax_rate,
    ol.subtotal * COALESCE(ol."taxRate", 0::numeric) AS tax_amount,
    ol.subtotal * (1::numeric + COALESCE(ol."taxRate", 0::numeric)) AS line_total_inc_tax,
    ol."orderedQty" AS ordered_qty,
    ol."deliveredQty" AS delivered_qty,
    ol."invoicedQty" AS invoiced_qty,
    ol."orderedQty" - ol."deliveredQty" AS qty_to_deliver,
    ol."deliveredQty" - ol."invoicedQty" AS qty_to_invoice,
    ol."orderedQty" * COALESCE(u.factor, 1::numeric) AS ordered_qty_ref,
    ol."deliveredQty" * COALESCE(u.factor, 1::numeric) AS delivered_qty_ref,
    COALESCE(p.weight, 0::numeric) * ol."orderedQty" * COALESCE(u.factor, 1::numeric) AS total_weight,
    COALESCE(p.volume, 0::numeric) * ol."orderedQty" * COALESCE(u.factor, 1::numeric) AS total_volume,
    COALESCE(o."commissionRate", 0::numeric) AS commission_rate,
    ol.subtotal * COALESCE(o."commissionRate", 0::numeric) AS commission_amount,
    1 AS line_count,
    o."salesUserId" AS sales_user_id
   FROM "OrderLine" ol
     JOIN "Order" o ON o.id = ol."orderId"
     LEFT JOIN "Product" p ON p.id = ol."productId"
     LEFT JOIN "ProductCategory" pc ON pc.id = p."categoryId"
     LEFT JOIN "Customer" c ON c.id = o."restaurantId"
     LEFT JOIN "DriverSlot" ds ON ds.id = o."driverSlotId"
     LEFT JOIN "Uom" u ON u.id = ol."uomId"
     LEFT JOIN "User" su ON su.id = o."salesUserId"
  WHERE o.status <> 'CANCELLED'::"OrderStatus";
