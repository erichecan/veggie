-- veggie_sales_report: salesman is now derived from Order.salesUserId -> User.name
-- (source of truth moved off the old free-text Order.salesman column). Also expose
-- sales_user_id so role-based report filtering can match by ID instead of by name.

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
    su.name                             AS salesman,
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
    1                                   AS line_count,

    -- New: FK to User, for ID-based role filtering (avoid fragile name matching)
    o."salesUserId"                     AS sales_user_id

FROM "OrderLine" ol
JOIN "Order" o           ON o.id = ol."orderId"
LEFT JOIN "Product" p    ON p.id = ol."productId"
LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
LEFT JOIN "ProductCategory" pc ON pc.id = COALESCE(p."categoryId", pt."categoryId")
LEFT JOIN "Customer" c   ON c.id = o."restaurantId"
LEFT JOIN "DriverSlot" ds ON ds.id = o."driverSlotId"
LEFT JOIN "Uom" u        ON u.id = ol."uomId"
LEFT JOIN "User" su      ON su.id = o."salesUserId"
WHERE o.status != 'CANCELLED';
