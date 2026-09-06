-- 可售单位「产品规格」（20260905）
--
-- 每个可售单位各自一条规格说明（如"500g/包"、"10包一箱共5kg"），供加订单行时
-- 覆盖商品级的 Sale Description，最终落进 OrderLine.spec（打印模版已在读这个字段，
-- 见 lib/print/trip-delivery-template.ts 等）。新增列默认 NULL，不影响存量数据。
ALTER TABLE "ProductSaleUom" ADD COLUMN "spec" TEXT;
