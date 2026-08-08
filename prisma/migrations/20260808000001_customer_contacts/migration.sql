-- CustomerContact：客户名下的多个联系人/邮箱
--
-- 发报价单、销售单时要能选「主收件人 + 抄送若干」，而 Customer.email 只有一个格子。
-- 本表是补充不是替代：Customer.email 保留不动，采购 RFQ 等既有逻辑继续读它。

-- CreateTable
CREATE TABLE "CustomerContact" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "externalId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerContact_externalId_key" ON "CustomerContact"("externalId");

-- CreateIndex
CREATE INDEX "CustomerContact_customerId_idx" ON "CustomerContact"("customerId");

-- CreateIndex
CREATE INDEX "CustomerContact_email_idx" ON "CustomerContact"("email");

-- AddForeignKey
ALTER TABLE "CustomerContact" ADD CONSTRAINT "CustomerContact_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 每个客户至多一个主联系人。
-- Prisma schema 语法表达不了带 WHERE 的唯一索引，只能手写在这里 ——
-- 不加这条的话，「主联系人」就只是个约定，早晚会出现一个客户两条 isPrimary，
-- 而发邮件时默认选哪个就变成了看 ORDER BY 的运气。
CREATE UNIQUE INDEX "CustomerContact_one_primary_per_customer"
  ON "CustomerContact"("customerId") WHERE "isPrimary";

-- 回填：把现有 Customer.email 变成一条主联系人，让两边初始一致。
-- 生产实测（2026-08-08）1407 个客户中仅 46 个有邮箱，所以这里只会产生几十行。
--
-- id 用 'c' + 24 位十六进制拼出 cuid 形态的字符串 —— @default(cuid()) 是 Prisma
-- 在应用层生成的，数据库侧没有默认值，纯 SQL 插入必须自备主键。
INSERT INTO "CustomerContact" ("id", "customerId", "name", "email", "role", "isPrimary", "isActive", "createdAt", "updatedAt")
SELECT
  'c' || substr(md5(random()::text || clock_timestamp()::text || c."id"), 1, 24),
  c."id",
  c."name",
  btrim(c."email"),
  '',
  true,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Customer" c
WHERE btrim(c."email") <> ''
  AND btrim(c."email") LIKE '%@%';
