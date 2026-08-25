-- ============================================================================
-- 合表重构 T1（2026-08-25）：ProductTemplate → Product
-- ============================================================================
-- 只加字段，不删旧表/旧列。ProductTemplate 与 Product.templateId 在 T5 才删除。
-- 详见 docs/20260825-producttemplate-merge-tasks.md、DEV-PLAN.md。
-- ============================================================================

BEGIN;

ALTER TABLE "Product"
  ADD COLUMN "type"             "ProductType" NOT NULL DEFAULT 'PRODUCT',
  ADD COLUMN "canBeSold"        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "canBePurchased"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "description"      TEXT,
  ADD COLUMN "saleDescription"  TEXT,
  ADD COLUMN "weight"           NUMERIC(10,3),
  ADD COLUMN "netWeight"        NUMERIC(10,3),
  ADD COLUMN "volume"           NUMERIC(10,3),
  ADD COLUMN "isPackaging"      BOOLEAN,
  ADD COLUMN "canBeExpensed"    BOOLEAN,
  ADD COLUMN "uomId"            TEXT REFERENCES "Uom"("id"),
  ADD COLUMN "purchaseUomId"    TEXT REFERENCES "Uom"("id"),
  ADD COLUMN "unitOfMeasure"    TEXT,
  ADD COLUMN "purchaseUoM"      TEXT,
  ADD COLUMN "tracking"         TEXT,
  ADD COLUMN "websitePublished" BOOLEAN,
  ADD COLUMN "websiteName"      TEXT,
  ADD COLUMN "vendorTaxRate"    NUMERIC(6,4),
  ADD COLUMN "forecastQty"      NUMERIC(14,3),
  ADD COLUMN "createdBy"        TEXT,
  ADD COLUMN "updatedBy"        TEXT,
  ADD COLUMN "barcode"          TEXT;

CREATE INDEX "Product_uomId_idx"         ON "Product"("uomId");
CREATE INDEX "Product_purchaseUomId_idx" ON "Product"("purchaseUomId");

COMMIT;
