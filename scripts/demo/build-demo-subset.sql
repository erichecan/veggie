-- 演示数据闭包抽样（T4）
--
-- 用法：
--   psql "$NEON_DIRECT" -v win="'2026-06-21'" -v commit=0 -f scripts/demo/build-demo-subset.sql   # dry-run
--   psql "$NEON_DIRECT" -v win="'2026-06-21'" -v commit=1 -f scripts/demo/build-demo-subset.sql   # 真删
--
-- ⛔ 跑之前必须已有全量 dump（见 docs/20260816-demo-data-anonymization-tasks.md T1）。
--
-- 为什么不是「每表留 50 条」：该库 39 个外键，且 Order.restaurantId → Customer
-- 根本没有外键约束 —— 按表各留 50 条会让订单指向已删客户，数据库不报错，
-- 只在页面上显示空白。这里改为从「50 个锚点客户」出发取引用闭包。

\set ON_ERROR_STOP on

BEGIN;

-- ── 保留集 ────────────────────────────────────────────────
-- 锚点：时间窗内有订单的客户按订单数降序取第 11–60 名。
-- 跳过前 10 大客户是为了避免单个大客户吃掉绝大部分订单量。
-- 必须并上被采购侧引用的供应商 —— ProductSupplierInfo.supplierId 和
-- PurchaseOrder.supplierId 是真外键，供应商没留全会直接删不动。
CREATE TEMP TABLE _keep_customer AS
WITH ranked AS (
  SELECT c.id, ROW_NUMBER() OVER (ORDER BY COUNT(o.id) DESC) AS rn
  FROM "Customer" c
  JOIN "Order" o ON o."restaurantId" = c.id
  WHERE o."createdAt" >= :win
  GROUP BY c.id
)
SELECT id FROM ranked WHERE rn BETWEEN 11 AND 60
UNION
SELECT DISTINCT "supplierId" FROM "ProductSupplierInfo" WHERE "supplierId" IS NOT NULL
UNION
SELECT DISTINCT "supplierId" FROM "PurchaseOrder" WHERE "supplierId" IS NOT NULL;

CREATE TEMP TABLE _keep_order AS
SELECT o.id
FROM "Order" o
JOIN _keep_customer k ON o."restaurantId" = k.id
WHERE o."createdAt" >= :win;

-- ── 1. 纯日志表整表清空（最易藏 PII，演示价值低）──────────
TRUNCATE "ActionLog";
TRUNCATE "Notification";
TRUNCATE "DailyBusinessSnapshot";   -- 聚合的真实营业额，抽样后必然对不上

-- ── 2. 按订单裁剪（先叶子后根）────────────────────────────
DELETE FROM "OrderLine"       WHERE "orderId" NOT IN (SELECT id FROM _keep_order);
DELETE FROM "DeliverySlip"    WHERE "orderId" NOT IN (SELECT id FROM _keep_order);
DELETE FROM "OrderAuditLog"   WHERE "orderId" NOT IN (SELECT id FROM _keep_order);
DELETE FROM "OrderDiscrepancy" WHERE "orderId" NOT IN (SELECT id FROM _keep_order);
DELETE FROM "Order"           WHERE id NOT IN (SELECT id FROM _keep_order);

-- ── 3. 按客户裁剪 ─────────────────────────────────────────
-- 发票/贷记单同样要卡时间窗：只按 customerId 删的话，这批客户几年来的
-- 全部历史发票都会留下（实测 24,755 张 vs 544 个订单，明显对不上）。
DELETE FROM "Invoice"
  WHERE "customerId" NOT IN (SELECT id FROM _keep_customer) OR "createdAt" < :win;
DELETE FROM "CreditNoteLine"
  WHERE "creditNoteId" IN (
    SELECT id FROM "CreditNote"
    WHERE "customerId" NOT IN (SELECT id FROM _keep_customer) OR "createdAt" < :win);
DELETE FROM "CreditNote"
  WHERE "customerId" NOT IN (SELECT id FROM _keep_customer) OR "createdAt" < :win;
DELETE FROM "CustomerPricelist"   WHERE "customerId" NOT IN (SELECT id FROM _keep_customer);
DELETE FROM "CustomerSpecialPrice" WHERE "customerId" NOT IN (SELECT id FROM _keep_customer);
DELETE FROM "Customer"            WHERE id NOT IN (SELECT id FROM _keep_customer);

-- ── 4. 数组列里的悬空引用 ─────────────────────────────────
-- 波次和发票把订单 id 存成数组，删订单不会自动清理，
-- 留着会让配送中心/发票页显示指向不存在订单的空条目。
UPDATE "PickingWave"
   SET "orderIds" = ARRAY(SELECT unnest("orderIds") INTERSECT SELECT id FROM _keep_order);
DELETE FROM "PickingWave" WHERE cardinality("orderIds") = 0;

UPDATE "Invoice"
   SET "saleOrderIds" = ARRAY(SELECT unnest("saleOrderIds") INTERSECT SELECT id FROM _keep_order);

-- 行程挂在波次上，波次没了就删
DELETE FROM "Trip"   WHERE "waveId" IS NOT NULL AND "waveId" NOT IN (SELECT id FROM "PickingWave");
DELETE FROM "Pallet" WHERE "waveId" IS NOT NULL AND "waveId" NOT IN (SELECT id FROM "PickingWave");

-- ── 5. 结果报数 ───────────────────────────────────────────
SELECT 'Customer' AS t, count(*) FROM "Customer"
UNION ALL SELECT 'Order',        count(*) FROM "Order"
UNION ALL SELECT 'OrderLine',    count(*) FROM "OrderLine"
UNION ALL SELECT 'Invoice',      count(*) FROM "Invoice"
UNION ALL SELECT 'CreditNote',   count(*) FROM "CreditNote"
UNION ALL SELECT 'DeliverySlip', count(*) FROM "DeliverySlip"
UNION ALL SELECT 'PickingWave',  count(*) FROM "PickingWave"
UNION ALL SELECT 'Trip',         count(*) FROM "Trip"
UNION ALL SELECT 'ProductTemplate', count(*) FROM "ProductTemplate"
UNION ALL SELECT 'User',         count(*) FROM "User"
ORDER BY 1;

-- ── 6. 悬空引用自检（必须全为 0）──────────────────────────
-- Order.restaurantId 没有外键约束，这一步是唯一的防线
SELECT 'orphan_order_customer' AS chk, count(*) FROM "Order" o
  WHERE o."restaurantId" IS NOT NULL AND o."restaurantId" NOT IN (SELECT id FROM "Customer")
UNION ALL SELECT 'orphan_orderline_order', count(*) FROM "OrderLine" ol
  WHERE ol."orderId" NOT IN (SELECT id FROM "Order")
UNION ALL SELECT 'orphan_invoice_customer', count(*) FROM "Invoice" i
  WHERE i."customerId" IS NOT NULL AND i."customerId" NOT IN (SELECT id FROM "Customer")
UNION ALL SELECT 'orphan_slip_order', count(*) FROM "DeliverySlip" d
  WHERE d."orderId" NOT IN (SELECT id FROM "Order");

\if :commit
  COMMIT;
\else
  ROLLBACK;
\endif
