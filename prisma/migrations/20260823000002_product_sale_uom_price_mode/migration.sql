-- 可售单位价格公式（20260823）
--
-- 三态显式建模：AUTO(现状默认) / FIXED(现状"填了就固定") / FORMULA(新增)。
-- priceOverride 字段不变，FIXED 态仍然读它；存量行按它是否有值一次性归类，
-- 归类后所有旧数据的计算结果一个数字都不变。
CREATE TYPE "SaleUomPriceMode" AS ENUM ('AUTO', 'FIXED', 'FORMULA');
ALTER TABLE "ProductSaleUom" ADD COLUMN "priceMode" "SaleUomPriceMode" NOT NULL DEFAULT 'AUTO';
ALTER TABLE "ProductSaleUom" ADD COLUMN "priceDiscountPct" DECIMAL(6,4) NOT NULL DEFAULT 0;
ALTER TABLE "ProductSaleUom" ADD COLUMN "priceSurcharge" DECIMAL(12,2) NOT NULL DEFAULT 0;
UPDATE "ProductSaleUom" SET "priceMode" = 'FIXED' WHERE "priceOverride" IS NOT NULL;
