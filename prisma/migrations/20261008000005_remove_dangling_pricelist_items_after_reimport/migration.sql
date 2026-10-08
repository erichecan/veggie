-- 20261008 第二次清理价格表里的空规则（客户要求：「把线上那些空规则清理掉」）
-- ============================================================================
-- 20261008000003 清空商品规则后客户重新导入了价格表。当时的导入代码在商品编号/名称、
-- 分类没对上时，仍会写入一条没有目标的规则(详情页 Applicable On 显示「-」)，
-- 20261008 起导入已改为不写入这类规则(app/api/pricelists/bulk/route.ts missingTarget)。
-- 这里用与 20261008000002 完全相同的判定，把重新导入产生的空规则清掉：
--   - applyOn = variant/product，但商品 id 为空，或指向的商品已不在商品表里；
--   - applyOn = category，但分类 id 为空，或分类已不存在。
-- ⛔ 指向「已归档」商品的规则不动。
-- 被删的规则原样存进 ActionLog.changes(每个价格表一条)，需要时可以从那里恢复。
-- 可重复执行：没有空规则的价格表不会被改动。

CREATE TEMP TABLE _pl_clean AS
SELECT p.id,
       COALESCE(jsonb_agg(x.it ORDER BY x.ord) FILTER (WHERE x.keep), '[]'::jsonb) AS kept,
       COALESCE(jsonb_agg(x.it ORDER BY x.ord) FILTER (WHERE NOT x.keep), '[]'::jsonb) AS removed,
       COUNT(*) FILTER (WHERE NOT x.keep) AS removed_count
FROM "OdooPricelist" p
CROSS JOIN LATERAL (
  SELECT a.it, a.ord,
         CASE a.it->>'applyOn'
           WHEN 'variant' THEN COALESCE(a.it->>'productVariantId', '') <> ''
                           AND EXISTS (SELECT 1 FROM "Product" pr WHERE pr.id = a.it->>'productVariantId')
           WHEN 'product' THEN COALESCE(a.it->>'productTemplateId', '') <> ''
                           AND EXISTS (SELECT 1 FROM "Product" pr WHERE pr.id = a.it->>'productTemplateId')
           WHEN 'category' THEN COALESCE(a.it->>'categoryId', '') <> ''
                           AND EXISTS (SELECT 1 FROM "ProductCategory" pc WHERE pc.id = a.it->>'categoryId')
           ELSE true
         END AS keep
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.items::jsonb) = 'array' THEN p.items::jsonb ELSE '[]'::jsonb END)
       WITH ORDINALITY AS a(it, ord)
) x
GROUP BY p.id;

DELETE FROM _pl_clean WHERE removed_count = 0;

UPDATE "OdooPricelist" p
SET items = c.kept, "updatedAt" = NOW()
FROM _pl_clean c
WHERE p.id = c.id;

INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, changes, "createdAt")
SELECT 'al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'UPDATE', 'pricelist', c.id,
       '清理无效价格规则(重新导入后)：删除 ' || c.removed_count || ' 条(指向已不存在的商品/分类)',
       jsonb_build_object('removedItems', jsonb_build_object('before', c.removed, 'after', NULL)),
       NOW()
FROM _pl_clean c;

DROP TABLE _pl_clean;
