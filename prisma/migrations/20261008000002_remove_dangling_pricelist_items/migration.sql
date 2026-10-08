-- 20261008 清理价格表里的无效规则（客户要求：删除价格表里没有关联商品的行）
-- ============================================================================
-- 价格表详情页 Applicable On 显示「-」的规则里，有一类是真正失效的：
--   - applyOn = variant/product，但商品 id 为空，或指向的商品已经不在商品表里(被删掉了)；
--   - applyOn = category，但分类 id 为空，或分类已经不存在。
-- 这类规则不会命中任何商品(lib/pricing-engine.ts 按 id 精确匹配)，只是在列表里占位。
--
-- ⛔ 只删上面这两类。指向「已归档」商品的规则不动——商品还在，重新启用后规则仍然有效；
--    详情页改为显示商品名并标注已归档(以前也显示成「-」，看起来像无效)。
-- 被删的规则原样存进 ActionLog.changes(每个价格表一条)，需要时可以从那里恢复。
-- 可重复执行：没有失效规则的价格表不会被改动。

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
       '清理无效价格规则：删除 ' || c.removed_count || ' 条(指向已不存在的商品/分类)',
       jsonb_build_object('removedItems', jsonb_build_object('before', c.removed, 'after', NULL)),
       NOW()
FROM _pl_clean c;

DROP TABLE _pl_clean;
