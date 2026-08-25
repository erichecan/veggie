-- ============================================================================
-- 合表重构 T5（2026-08-25）：删除 ProductTemplate，删除 Product.templateId
-- ============================================================================
-- 前置条件（执行前已核实，见 docs/20260825-producttemplate-merge-tasks.md）：
--   T3 已把 ProductTemplate 的字段全部回填进 Product，T4 已把
--   OdooPricelistItem.items 里 621 条 applyOn='product' 松引用 remap 成 Product.id。
--   全库唯一指向 ProductTemplate 的外键就是 Product.templateId（已核实，
--   没有其它表的 FK 指向这张表）。
-- ============================================================================

BEGIN;

ALTER TABLE "Product" DROP COLUMN "templateId";

DROP TABLE "ProductTemplate";

COMMIT;
