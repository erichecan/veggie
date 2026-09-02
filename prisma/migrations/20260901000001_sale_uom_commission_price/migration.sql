-- 可售单位司机提成价（20260901）
--
-- 提成价照抄价格的换算机制：复用 SaleUomPriceMode 枚举，新增 override + FORMULA 的
-- 折扣/加价两个字段。全部默认 AUTO / 0 / NULL，未特意配置的商品/可售单位算出来的
-- 提成总额跟改造前一字不差。
ALTER TABLE "ProductSaleUom" ADD COLUMN "commissionPriceOverride" DECIMAL(12,2);
ALTER TABLE "ProductSaleUom" ADD COLUMN "commissionPriceMode" "SaleUomPriceMode" NOT NULL DEFAULT 'AUTO';
ALTER TABLE "ProductSaleUom" ADD COLUMN "commissionDiscountPct" DECIMAL(6,4) NOT NULL DEFAULT 0;
ALTER TABLE "ProductSaleUom" ADD COLUMN "commissionSurcharge" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- 存量数据回填：OrderLine.commissionPrice 语义从此变成"该行在其选用单位下、已经
-- 折算好的提成单价"，而不是"基础单位提成价原值"（配套的 lib/commission.ts 改造
-- 不再在算提成总额时对数量做 toStockQty 折算，改为直接 commissionPrice × deliveredQty）。
-- 存量行如果选用的不是基础单位，必须在这里把 commissionPrice 提前乘上换算系数，
-- 否则改造后这些历史行的提成会凭空少算 factor 倍。
--
-- 用的是"当前" factor——跟改造前 toStockQty 运行时永远用当前 factor 折算是同一个
-- 数据来源，不比现状更不准；isDefault=true（基础单位）的行 factor 恒为 1，不受影响。
UPDATE "OrderLine" ol
SET "commissionPrice" = ol."commissionPrice" * psu."factor"
FROM "ProductSaleUom" psu
WHERE ol."commissionPrice" IS NOT NULL
  AND ol."uomId" = psu."uomId"
  AND ol."productId" = psu."productId"
  AND psu."isDefault" = false;
