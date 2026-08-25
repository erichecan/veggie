-- 可售单位"÷N"精度丢失：ProductSaleUom.factor 只有 6 位小数（20260819 加的列），
-- "÷3" 存成 factor = 1/3 → 落库截断成 0.333333，页面反算 1/0.333333 想还原成 3
-- 结果显形成 3.000003。不是输入错了，是这一列精度不够存"除不尽"的小数。
--
-- 加宽到 18,10：分子(1 个此单位=factor个基础单位)上限本来就没到过百万级，
-- 10 位小数足够让 ÷N（N 到几万）反算回整数时落在显示层 6 位小数的舍入范围内。

ALTER TABLE "ProductSaleUom" ALTER COLUMN "factor" TYPE DECIMAL(18,10);

-- 回填现网已经被截断存脏的行：只处理"看起来像是从整数 N 做÷N 反算出来的"那些行——
-- 用「当前值」与「用当前值反推的最近整数 N 再算回 1/N」的差值做门槛(<0.00001)，
-- 差值极小才改，避免误伤本来就是通过 API 直接写入的、并非来自"÷"这套 UI 的正常小数。
UPDATE "ProductSaleUom"
SET "factor" = 1.0 / ROUND(1.0 / "factor")
WHERE "factor" > 0
  AND "factor" < 1
  AND ABS("factor" - 1.0 / ROUND(1.0 / "factor")) < 0.00001;
