-- 可售单位（ProductSaleUom）自己的毛重(kg)，独立于 Product.weight（基础单位层级，
-- UI 也显示"毛重"，历史遗留字段名）。打印单据折进规格说明文字显示。
ALTER TABLE "ProductSaleUom" ADD COLUMN "grossWeight" DECIMAL(10,3);
