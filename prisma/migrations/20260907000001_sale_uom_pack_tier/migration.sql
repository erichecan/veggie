-- 可售单位「装货层位」（20260907）
--
-- 仓库配货/司机卸货堆叠顺序：BOTTOM=最先装/放最下（重、耐压）、NORMAL=普通、
-- TOP=最后装/放最上（怕压）。跟 Product.sequence（单据里排第几行）是两个独立维度。
-- 默认 NORMAL，存量与新建行天然有值，不需要回填脚本；同层大量商品重复是设计目标。
CREATE TYPE "PackTier" AS ENUM ('BOTTOM', 'NORMAL', 'TOP');

ALTER TABLE "ProductSaleUom" ADD COLUMN "packTier" "PackTier" NOT NULL DEFAULT 'NORMAL';
