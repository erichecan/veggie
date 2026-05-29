-- ============================================================
-- Veggie Reporting VIEWs
-- Three analytical views for sales, purchasing, and logistics
-- ============================================================

-- 1. Sales Report VIEW (OrderLine grain)
CREATE OR REPLACE VIEW veggie_sales_report AS
SELECT
    ol.id                               AS id,
    o.id                                AS order_id,
    o.code                              AS order_code,

    -- Time dimensions
    o."quotationDate"                   AS quotation_date,
    o."confirmationDate"                AS confirmation_date,
    o."deliveryDate"                    AS delivery_date,
    o."invoiceDate"                     AS invoice_date,
    o."createdAt"                       AS created_at,

    -- Customer dimensions
    o."restaurantId"                    AS customer_id,
    o."restaurantName"                  AS customer_name,
    c.city                              AS customer_city,
    c.country                           AS customer_country,
    c."paymentTerm"                     AS payment_term,

    -- Product dimensions
    ol."productId"                      AS product_id,
    ol."productName"                    AS product_name,
    p."templateId"                      AS product_template_id,
    pt.name                             AS product_template_name,
    COALESCE(p."categoryId", pt."categoryId") AS category_id,
    COALESCE(pc.name, '未分类')          AS category_name,

    -- Salesman / delivery dimensions
    o.salesman                          AS salesman,
    o."createdById"                     AS created_by_id,
    o."createdByName"                   AS created_by_name,
    o."driverSlotId"                    AS driver_slot_id,
    ds."driverName"                     AS driver_name,
    ds."timeOfDay"                      AS time_of_day,
    ds."batchNum"                       AS batch_num,

    -- Status dimensions
    o.status::text                      AS order_status,
    o."paymentMethod"::text             AS payment_method,

    -- UoM dimensions
    ol."uomId"                          AS uom_id,
    ol."uomName"                        AS uom_name,

    -- Measures: amounts
    ol."unitPrice"                      AS unit_price,
    ol.subtotal                         AS line_subtotal,
    o."totalAmount"                     AS order_total,
    ol."taxRate"                        AS tax_rate,
    ol.subtotal * COALESCE(ol."taxRate", 0)           AS tax_amount,
    ol.subtotal * (1 + COALESCE(ol."taxRate", 0))     AS line_total_inc_tax,

    -- Measures: quantities
    ol."orderedQty"                     AS ordered_qty,
    ol."deliveredQty"                   AS delivered_qty,
    ol."invoicedQty"                    AS invoiced_qty,
    ol."orderedQty" - ol."deliveredQty" AS qty_to_deliver,
    ol."deliveredQty" - ol."invoicedQty" AS qty_to_invoice,

    -- Measures: UoM-normalized quantities
    ol."orderedQty" * COALESCE(u.factor, 1)   AS ordered_qty_ref,
    ol."deliveredQty" * COALESCE(u.factor, 1) AS delivered_qty_ref,

    -- Measures: weight/volume
    COALESCE(pt.weight, 0) * ol."orderedQty" * COALESCE(u.factor, 1)  AS total_weight,
    COALESCE(pt.volume, 0) * ol."orderedQty" * COALESCE(u.factor, 1)  AS total_volume,

    -- Measures: commission
    COALESCE(o."commissionRate", 0)     AS commission_rate,
    ol.subtotal * COALESCE(o."commissionRate", 0) AS commission_amount,

    -- Measures: line count
    1                                   AS line_count

FROM "OrderLine" ol
JOIN "Order" o           ON o.id = ol."orderId"
LEFT JOIN "Product" p    ON p.id = ol."productId"
LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
LEFT JOIN "ProductCategory" pc ON pc.id = COALESCE(p."categoryId", pt."categoryId")
LEFT JOIN "Customer" c   ON c.id = o."restaurantId"
LEFT JOIN "DriverSlot" ds ON ds.id = o."driverSlotId"
LEFT JOIN "Uom" u        ON u.id = ol."uomId"
WHERE o.status != 'CANCELLED';


-- 2. Purchasing Report VIEW (PurchaseOrderLine grain)
CREATE OR REPLACE VIEW veggie_purchasing_report AS
SELECT
    pol.id                              AS id,
    po.id                               AS purchase_order_id,
    po.name                             AS po_name,

    -- Time dimensions
    po."orderDate"                      AS order_date,
    po."expectedDate"                   AS expected_date,
    po."confirmedAt"                    AS confirmed_at,

    -- Supplier dimensions
    po."supplierId"                     AS supplier_id,
    sup.name                            AS supplier_name,
    sup.city                            AS supplier_city,

    -- Product dimensions
    pol."productId"                     AS product_id,
    pol."productName"                   AS product_name,
    p."templateId"                      AS product_template_id,
    COALESCE(p."categoryId", pt."categoryId") AS category_id,
    COALESCE(pc.name, '未分类')          AS category_name,

    -- Status dimension
    po.status::text                     AS po_status,

    -- Measures
    pol."unitCost"                      AS unit_cost,
    pol."subtotalExTax"                 AS subtotal_ex_tax,
    pol."taxAmount"                     AS tax_amount,
    pol."subtotalIncTax"                AS subtotal_inc_tax,
    pol."orderedQty"                    AS ordered_qty,
    pol."receivedQty"                   AS received_qty,
    pol."invoicedQty"                   AS invoiced_qty,
    pol."orderedQty" - pol."receivedQty" AS qty_to_receive,
    pol."bestBefore"                    AS best_before,
    1                                   AS line_count

FROM "PurchaseOrderLine" pol
JOIN "PurchaseOrder" po     ON po.id = pol."purchaseOrderId"
LEFT JOIN "Customer" sup    ON sup.id = po."supplierId" AND sup."isVendor" = true
LEFT JOIN "Product" p       ON p.id = pol."productId"
LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
LEFT JOIN "ProductCategory" pc ON pc.id = COALESCE(p."categoryId", pt."categoryId")
WHERE po.status != 'CANCELLED';


-- 3. Logistics Report VIEW (Trip grain)
CREATE OR REPLACE VIEW veggie_logistics_report AS
SELECT
    t.id                                AS id,
    t.name                              AS trip_name,

    -- Time dimensions
    t."createdAt"                       AS created_at,
    t."settledAt"                       AS settled_at,

    -- Driver dimensions
    t."driverId"                        AS driver_id,
    t."driverName"                      AS driver_name,
    t."timeSlot"                        AS time_slot,

    -- Wave dimension
    t."waveId"                          AS wave_id,

    -- Status dimensions
    t.status::text                      AS trip_status,
    t."settlementStatus"                AS settlement_status,

    -- Measures
    t."totalPayment"                    AS total_payment,
    t."driverCommission"                AS driver_commission,
    t."cashCollected"                   AS cash_collected,
    t."onlineCollected"                 AS online_collected,
    COALESCE(t."cashCollected", 0) + COALESCE(t."onlineCollected", 0) AS total_collected,
    jsonb_array_length(t.restaurants::jsonb)  AS restaurant_count,
    1                                   AS trip_count

FROM "Trip" t
WHERE t.status != 'PENDING';
