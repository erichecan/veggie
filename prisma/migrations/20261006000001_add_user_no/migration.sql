-- 用户友好的自增编号（20261006 客户要求"增加 user 编号"），仅展示/搜索/导出用。
-- cuid `id` 仍是主键和所有外键目标，不受影响。
--
-- 不直接用 `ADD COLUMN ... SERIAL`（Product.productNo 那样）：SERIAL 给已有行回填时按
-- 物理存储顺序，而 User 每次登录都会更新 lastLoginAt，PostgreSQL 的 UPDATE 会写新行版本，
-- 物理顺序早已不是创建顺序——直接 SERIAL 出来的编号会是乱序的。这里显式按 createdAt
-- 排好序回填，最早建的账号是 1 号，然后把序列接到最大值之后，新账号继续自增。
-- 最终形态与 Prisma `Int @unique @default(autoincrement())` 完全一致（序列名、属主、默认值）。

-- AlterTable
ALTER TABLE "User" ADD COLUMN "userNo" INTEGER;

CREATE SEQUENCE "User_userNo_seq" OWNED BY "User"."userNo";

UPDATE "User" AS u
SET "userNo" = ordered.rn
FROM (SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS rn FROM "User") AS ordered
WHERE u."id" = ordered."id";

SELECT setval('"User_userNo_seq"', COALESCE((SELECT MAX("userNo") FROM "User"), 0) + 1, false);

ALTER TABLE "User"
  ALTER COLUMN "userNo" SET DEFAULT nextval('"User_userNo_seq"'),
  ALTER COLUMN "userNo" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_userNo_key" ON "User"("userNo");
