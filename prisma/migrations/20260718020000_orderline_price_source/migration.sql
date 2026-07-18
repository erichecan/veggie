-- OrderLine 加单价来源快照三字段：下单/编辑时算好存下来，供订单/报价单详情页
-- "Price" 列 hover 展示"这个价格是从 pricelist / default / last 来的"。
-- 历史订单没有这三个字段，一律为 null。
ALTER TABLE "OrderLine" ADD COLUMN "priceSourceType" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN "priceSourceDetail" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN "priceSourceDate" TIMESTAMP(3);
