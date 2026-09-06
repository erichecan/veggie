-- T1：商品去重合并决策表（只读，不写库）
-- 直接在生产库（167.99.86.19，veggie 库）跑，不依赖本地/dev 库（已确认两边有 drift）。
\pset pager off

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
    count(*) FILTER (WHERE "qtyOnHand" <> 0) OVER (PARTITION BY gname) AS cnt_qty_nonzero,
    -- 20260905 更正：生产库实测 38/60 组两个 id 上都挂着真实订单（不是"一份空壳一份真"），
    -- 两条各自被各自的确认订单独立扣减库存 —— 相加才能还原真实剩余量，不能再"取一份、另一份归零"
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
    g.gname, g.id AS winner_id, g."externalId" AS winner_ext, g.type AS final_type,
    g.cnt_ol, g.cnt_sm, g.cnt_active, g.cnt_qty_nonzero,
    CASE
      WHEN g.cnt_ol = 1 THEN 1
      WHEN g.cnt_ol > 1 THEN 0
      WHEN g.cnt_sm = 1 THEN 2
      WHEN g.cnt_sm > 1 THEN 0
      WHEN g.cnt_active = 1 THEN 3
      ELSE 4
    END AS rule,
    CASE WHEN g.status = 'ARCHIVED' AND g.cnt_active >= 1 THEN 'ACTIVE' ELSE g.status END AS final_status,
    g.summed_qty AS final_qty
  FROM grp g
  WHERE g.rnk = 1
),
losers AS (
  SELECT gname, array_agg(id ORDER BY rnk) AS loser_ids, array_agg("externalId" ORDER BY rnk) AS loser_exts
  FROM grp WHERE rnk > 1 GROUP BY gname
)
SELECT
  w.gname AS name,
  w.winner_id, w.winner_ext,
  w.final_type,
  w.final_status,
  w.final_qty,
  w.rule,
  (w.rule = 0) AS ambiguous_winner,
  l.loser_ids, l.loser_exts
FROM winners w
JOIN losers l USING (gname)
ORDER BY (w.rule = 0) DESC, w.gname;
