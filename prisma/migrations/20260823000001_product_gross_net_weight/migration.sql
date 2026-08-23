-- 商品毛重 / 净重（20260823）
--
-- 与既有的 ProductTemplate.weight（"默认商品重量"）是三个独立字段：
-- weight 沿用原有用途不动，grossWeight / netWeight 供物流、报关、称重场景使用。
-- 可空 + 无默认值 = 存量 1718 个商品全部为 NULL，读取侧按"未填写"渲染，
-- 不会改动任何一张历史单据的重量口径。
ALTER TABLE "ProductTemplate" ADD COLUMN "grossWeight" DECIMAL(10,3);
ALTER TABLE "ProductTemplate" ADD COLUMN "netWeight" DECIMAL(10,3);
