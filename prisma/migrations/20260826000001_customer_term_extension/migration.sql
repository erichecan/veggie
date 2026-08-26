-- ============================================================================
-- 账期灵活化 20260826：客户账期临时延期
-- ============================================================================
-- Customer.termExtendedUntil/termExtendedNote 是当前生效延期的缓存（下单时
-- 一次查询即可判断，不用每次连 CustomerTermExtension 算最新一条）；
-- CustomerTermExtension 是不可变的审批履历，两者都要写。
-- ============================================================================

BEGIN;

ALTER TABLE "Customer" ADD COLUMN "termExtendedUntil" TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN "termExtendedNote" TEXT;

CREATE TABLE "CustomerTermExtension" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "days" INTEGER NOT NULL,
  "until" TIMESTAMP(3) NOT NULL,
  "note" TEXT,
  "createdById" TEXT NOT NULL,
  "createdByName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CustomerTermExtension_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomerTermExtension_customerId_idx" ON "CustomerTermExtension"("customerId");

ALTER TABLE "CustomerTermExtension" ADD CONSTRAINT "CustomerTermExtension_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
