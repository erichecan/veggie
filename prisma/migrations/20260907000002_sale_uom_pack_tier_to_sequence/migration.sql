-- 可售单位「装货顺序」改设计（20260907）
--
-- 上一版（20260907000001）用了三档枚举（BOTTOM/NORMAL/TOP）。客户明确要的是跟
-- Product.sequence 一样的纯数字：数字越小越先装/放最下（重、耐压），越大越后装/
-- 放最上（轻、怕压），不做唯一性约束——不建新迁移改数据类型，直接建新迁移撤换，
-- 不改动上一条已应用的迁移文件本身。
ALTER TABLE "ProductSaleUom" DROP COLUMN "packTier";
DROP TYPE "PackTier";

ALTER TABLE "ProductSaleUom" ADD COLUMN "sequence" INTEGER;
