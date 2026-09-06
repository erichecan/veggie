-- T3+T5：商品去重合并 —— 实际写入版（生产库执行）
-- 逻辑与 product-merge-decision-table-20260905.sql 完全一致，多了：备份表 + FK remap + 写入 + 删除。
-- 全程一个事务：出错自动整体回滚，不会半吊子落地。
\pset pager off
BEGIN;

WITH base AS (
  SELECT
    p.id, p.name, trim(p.name) AS gname, p.type, p.status, p."qtyOnHand",
    p."externalId", p."createdAt"::date AS created_date,
    NULLIF(regexp_replace(coalesce(p."externalId", ''), '[^0-9]', '', 'g'), '')::bigint AS ext_num,
    (SELECT count(*) FROM "OrderLine" ol WHERE ol."productId" = p.id) AS order_lines,
    (SELECT count(*) FROM "StockMove" sm WHERE sm."productId" = p.id) AS stock_moves
  FROM "Product" p
  WHERE trim(p.name) IN (SELECT trim(name) FROM "Product" GROUP BY trim(name) HAVING count(*) > 1)
),
grp AS (
  SELECT *,
    count(*) FILTER (WHERE order_lines > 0) OVER (PARTITION BY gname) AS cnt_ol,
    count(*) FILTER (WHERE stock_moves > 0) OVER (PARTITION BY gname) AS cnt_sm,
    count(*) FILTER (WHERE status = 'ACTIVE') OVER (PARTITION BY gname) AS cnt_active,
    sum("qtyOnHand") OVER (PARTITION BY gname) AS summed_qty,
    row_number() OVER (
      PARTITION BY gname
      ORDER BY (order_lines > 0) DESC, (stock_moves > 0) DESC, (status = 'ACTIVE') DESC,
               ext_num ASC NULLS LAST, id ASC
    ) AS rnk
  FROM base
),
winners AS (
  SELECT
    g.gname, g.id AS winner_id, g.type AS final_type,
    CASE WHEN g.status = 'ARCHIVED' AND g.cnt_active >= 1 THEN 'ACTIVE' ELSE g.status END AS final_status,
    g.summed_qty AS final_qty
  FROM grp g WHERE g.rnk = 1
),
losers AS (
  SELECT id AS loser_id, gname FROM grp WHERE rnk > 1
)
-- product_merge_map：本次合并的完整映射表，供后面所有步骤复用，且落表存档方便事后核对
SELECT l.loser_id, w.winner_id, w.gname, w.final_type, w.final_status, w.final_qty
INTO TEMP TABLE product_merge_map
FROM losers l JOIN winners w USING (gname);

-- 备份：受影响的全部 Product 行（winner + loser）原样存档，回滚只需从这张表读回
CREATE TABLE product_dedup_backup_20260905 AS
SELECT * FROM "Product"
WHERE id IN (SELECT loser_id FROM product_merge_map)
   OR id IN (SELECT winner_id FROM product_merge_map);

-- FK remap：把 loser id 出现的地方全部改指向 winner id
UPDATE "OrderLine" ol SET "productId" = m.winner_id
FROM product_merge_map m WHERE ol."productId" = m.loser_id;

UPDATE "StockMove" sm SET "productId" = m.winner_id
FROM product_merge_map m WHERE sm."productId" = m.loser_id;

UPDATE "Lot" l SET "productId" = m.winner_id
FROM product_merge_map m WHERE l."productId" = m.loser_id;

UPDATE "ProductAlias" pa SET "productId" = m.winner_id
FROM product_merge_map m WHERE pa."productId" = m.loser_id;

UPDATE "CustomerSpecialPrice" csp SET "productId" = m.winner_id
FROM product_merge_map m WHERE csp."productId" = m.loser_id;

-- ProductSupplierInfo 有 @@unique([productId,supplierId])：winner 侧已有同 supplierId 的行时，
-- loser 侧那条会撞唯一键，先删除撞键的 loser 行（打印出来存档，不静默丢弃）
CREATE TABLE product_dedup_dropped_supplier_info_20260905 AS
SELECT psi.* FROM "ProductSupplierInfo" psi
JOIN product_merge_map m ON psi."productId" = m.loser_id
WHERE EXISTS (
  SELECT 1 FROM "ProductSupplierInfo" psi2
  WHERE psi2."productId" = m.winner_id AND psi2."supplierId" = psi."supplierId"
);
DELETE FROM "ProductSupplierInfo" psi
USING product_merge_map m
WHERE psi."productId" = m.loser_id
  AND EXISTS (
    SELECT 1 FROM "ProductSupplierInfo" psi2
    WHERE psi2."productId" = m.winner_id AND psi2."supplierId" = psi."supplierId"
  );
UPDATE "ProductSupplierInfo" psi SET "productId" = m.winner_id
FROM product_merge_map m WHERE psi."productId" = m.loser_id;

-- ProductSaleUom 同理，@@unique([productId,uomId])
CREATE TABLE product_dedup_dropped_sale_uom_20260905 AS
SELECT psu.* FROM "ProductSaleUom" psu
JOIN product_merge_map m ON psu."productId" = m.loser_id
WHERE EXISTS (
  SELECT 1 FROM "ProductSaleUom" psu2
  WHERE psu2."productId" = m.winner_id AND psu2."uomId" = psu."uomId"
);
DELETE FROM "ProductSaleUom" psu
USING product_merge_map m
WHERE psu."productId" = m.loser_id
  AND EXISTS (
    SELECT 1 FROM "ProductSaleUom" psu2
    WHERE psu2."productId" = m.winner_id AND psu2."uomId" = psu."uomId"
  );
UPDATE "ProductSaleUom" psu SET "productId" = m.winner_id
FROM product_merge_map m WHERE psu."productId" = m.loser_id;

-- 写入 winner 最终字段（type/status/qtyOnHand），一个 winner 只需要 distinct 一次
UPDATE "Product" p SET
  type = m.final_type,
  status = m.final_status::"ProductStatus",
  "qtyOnHand" = m.final_qty
FROM (SELECT DISTINCT winner_id, final_type, final_status, final_qty FROM product_merge_map) m
WHERE p.id = m.winner_id;

-- 删除 loser 行
DELETE FROM "Product" WHERE id IN (SELECT loser_id FROM product_merge_map);

-- 验证：应为 0 行（不再有重名分组）
SELECT trim(name), count(*) FROM "Product" GROUP BY trim(name) HAVING count(*) > 1;

-- 验证：备份表行数应为 132（60 组的全部候选，winner+loser）
SELECT count(*) AS backup_rows FROM product_dedup_backup_20260905;

-- 验证：本次映射表行数应为 72（132 - 60 winner = 72 loser）
SELECT count(*) AS mapping_rows FROM product_merge_map;

COMMIT;
