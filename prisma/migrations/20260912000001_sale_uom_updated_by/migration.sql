-- 记录最后改动 ProductSaleUom 这一行的用户名/邮箱，供"按可售单位查看商品"页的
-- Last Updated by 列使用；历史行没有这个记录，改之前一律为 NULL。
ALTER TABLE "ProductSaleUom" ADD COLUMN "updatedBy" TEXT;
