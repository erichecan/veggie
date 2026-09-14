-- Pack Sequence 从 0-4 五档扩到 0-8 九档（0=基础/未特意分层，1=最下面最重，8=最上面最轻怕压）。
-- 上一次收窄（20260912000002）加的 CHECK 约束只允许 0-4；20260913 前端已经把按钮扩到 1-8，
-- 但漏改了这条 DB 约束和 lib/sale-uom.ts 的应用层校验，导致写入 5-8 会被拒绝
-- （应用层报"装货顺序只能是 0-4 之间的整数"，就算绕过应用层，DB CHECK 也会拦）。
--
-- 现有数据本来就落在 0-4 内，是 0-8 的子集，不需要任何回填——直接放宽约束即可。

ALTER TABLE "ProductSaleUom"
  DROP CONSTRAINT "ProductSaleUom_sequence_tier_range";

ALTER TABLE "ProductSaleUom"
  ADD CONSTRAINT "ProductSaleUom_sequence_tier_range"
  CHECK ("sequence" BETWEEN 0 AND 8);
