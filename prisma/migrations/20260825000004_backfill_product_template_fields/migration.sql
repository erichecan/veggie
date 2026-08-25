-- ============================================================================
-- 合表重构 T3（2026-08-25）：把 ProductTemplate 的字段回填进 Product
-- ============================================================================
-- 必须夹在 T1（加列，见 20260825000003）和 T5（删表，见 20260825000006）之间——
-- 这一步之后 ProductTemplate 才允许被删，否则这 20 个字段的真实值会随删表永久丢失。
--
-- 规则（依据 T2 的全字段 diff 报表，docs/20260825-producttemplate-merge-tasks.md）：
--   - 20 个新字段：Product 侧目前全是默认值，直接从 Template 覆盖。
--   - internalRef / categoryId / images / customerTaxRate：Product 优先，
--     Product 为空才退回 Template —— 复用现有 /api/products GET 的运行时兜底约定，
--     保证迁移前后这几个字段的可见值不变。
--   - name / listPrice / standardPrice / commissionPrice / status / sequence /
--     externalId：Product 侧已是权威值，本迁移不覆盖，即便与 Template 有历史分歧
--     也保留 Product 侧现状。
-- 本地库已用一次性脚本（scripts/archive/backfill-product-template-fields-20260825.ts）
-- 跑过等价的 UPDATE 并验证通过（5479 行全部回填，抽查 0 条不一致）；这里原样落成迁移，
-- 保证生产库走同一条自动化流水线（加列→回填→改视图→删表）时序不出错。
-- ============================================================================

BEGIN;

UPDATE "Product" p SET
  "type"             = t."type",
  "canBeSold"        = t."canBeSold",
  "canBePurchased"   = t."canBePurchased",
  "description"      = t."description",
  "saleDescription"  = t."saleDescription",
  "weight"           = t."weight",
  "netWeight"        = t."netWeight",
  "volume"           = t."volume",
  "isPackaging"      = t."isPackaging",
  "canBeExpensed"    = t."canBeExpensed",
  "uomId"            = t."uomId",
  "purchaseUomId"    = t."purchaseUomId",
  "unitOfMeasure"    = t."unitOfMeasure",
  "purchaseUoM"      = t."purchaseUoM",
  "tracking"         = t."tracking",
  "websitePublished" = t."websitePublished",
  "websiteName"      = t."websiteName",
  "vendorTaxRate"    = t."vendorTaxRate",
  "forecastQty"      = t."forecastQty",
  "createdBy"        = t."createdBy",
  "updatedBy"        = t."updatedBy",
  "barcode"          = t."barcode",
  "internalRef"      = COALESCE(p."internalRef", t."internalRef"),
  "categoryId"       = COALESCE(p."categoryId", t."categoryId"),
  "images"           = CASE WHEN cardinality(p."images") = 0 THEN t."images" ELSE p."images" END,
  "customerTaxRate"  = COALESCE(p."customerTaxRate", t."customerTaxRate")
FROM "ProductTemplate" t
WHERE p."templateId" = t.id;

COMMIT;
