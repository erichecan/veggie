-- grossWeight 与 weight（默认商品重量）语义重复，客户反馈两个字段并排显示看着像重复。
-- 生产实测 5482 个商品无一个填过 grossWeight（全 NULL），删列零数据损失。
-- netWeight 保留：formatUomConversionHint（可售单位打印换算说明）用它算实物重量小字。
ALTER TABLE "ProductTemplate" DROP COLUMN "grossWeight";
