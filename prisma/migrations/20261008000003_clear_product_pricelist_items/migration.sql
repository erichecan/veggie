-- 20261008 客户要求：删除所有价格表里的「商品」规则行，保留价格表本身，准备重新导入
-- ============================================================================
-- 原因：重新导入时(没带 Item ID 的行会新增规则)，已有的商品规则会和导入的重复。
-- 先把商品级规则清空，再整份导入，价格表里就只有一份。
--
-- 范围：OdooPricelist.items 里 applyOn = 'variant' / 'product' 的规则(锁定具体商品的行)。
-- 保留：价格表本身(名称/币种/排序/客户挂靠等全部不动)，以及 applyOn = 'global'(全场)、
--       'category'(按分类)的规则。客户专属价(CustomerSpecialPrice)是另一张表，不受影响。
--
-- ⚠ 删完到重新导入之前，按商品定的价格不再生效，下单时会回落到全场/分类规则或商品标价。
-- 被删的规则原样存进 ActionLog.changes(每个价格表一条)，需要时可以从那里恢复。
-- 可重复执行：没有商品规则的价格表不会被改动。

CREATE TEMP TABLE _pl_prod AS
SELECT p.id,
       COALESCE(jsonb_agg(x.it ORDER BY x.ord) FILTER (WHERE NOT x.is_product), '[]'::jsonb) AS kept,
       COALESCE(jsonb_agg(x.it ORDER BY x.ord) FILTER (WHERE x.is_product), '[]'::jsonb) AS removed,
       COUNT(*) FILTER (WHERE x.is_product) AS removed_count
FROM "OdooPricelist" p
CROSS JOIN LATERAL (
  SELECT a.it, a.ord, COALESCE(a.it->>'applyOn', '') IN ('variant', 'product') AS is_product
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.items::jsonb) = 'array' THEN p.items::jsonb ELSE '[]'::jsonb END)
       WITH ORDINALITY AS a(it, ord)
) x
GROUP BY p.id;

DELETE FROM _pl_prod WHERE removed_count = 0;

UPDATE "OdooPricelist" p
SET items = c.kept, "updatedAt" = NOW()
FROM _pl_prod c
WHERE p.id = c.id;

INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, changes, "createdAt")
SELECT 'al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'UPDATE', 'pricelist', c.id,
       '清空商品规则(准备重新导入)：删除 ' || c.removed_count || ' 条商品规则，全场/分类规则保留',
       jsonb_build_object('removedItems', jsonb_build_object('before', c.removed, 'after', NULL)),
       NOW()
FROM _pl_prod c;

DROP TABLE _pl_prod;
