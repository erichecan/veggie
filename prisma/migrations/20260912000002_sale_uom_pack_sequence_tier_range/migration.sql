-- Pack Sequence 收窄为 0-4 五档（0=基础/未特意分层，1=最下面最重，4=最上面最轻怕压）。
-- 历史上这一列是完全自由的 Int?（20260907 上线，从未做过回填），因此本迁移必须在
-- 同一个文件里先回填数据、再收紧约束——不能拆成"脚本回填 + 后续迁移改约束"两步，
-- 否则 `prisma migrate deploy` 在生产背靠背连续跑完两个迁移，中间没有人工窗口，
-- 会在约束生效前后出现瞬间不一致的窗口（历史教训见 20260825 那次迁移事故）。

-- 1) 历史 NULL（从未设置过装货顺序的行）→ 0（基础档，排最前/最底层）
UPDATE "ProductSaleUom" SET "sequence" = 0 WHERE "sequence" IS NULL;

-- 2) 历史自由数字里超出 0-4 范围的，收拢到最近的边界，不管具体分布都安全：
--    负数收到 0；大于 4 的收到 4（即"最上面/最怕压"那一档）。
UPDATE "ProductSaleUom" SET "sequence" = 0 WHERE "sequence" < 0;
UPDATE "ProductSaleUom" SET "sequence" = 4 WHERE "sequence" > 4;

-- 3) 数据已经全部落在 0-4 内，现在可以安全地加 NOT NULL + 默认值 0
ALTER TABLE "ProductSaleUom" ALTER COLUMN "sequence" SET NOT NULL;
ALTER TABLE "ProductSaleUom" ALTER COLUMN "sequence" SET DEFAULT 0;

-- 4) 加范围约束，防止以后又有代码路径绕过应用层校验写入非法值
ALTER TABLE "ProductSaleUom"
  ADD CONSTRAINT "ProductSaleUom_sequence_tier_range"
  CHECK ("sequence" BETWEEN 0 AND 4);
