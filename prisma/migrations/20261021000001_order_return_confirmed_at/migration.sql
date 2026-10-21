-- 20261021 回单核销时间 / 人：核销管理页「已核销的在主列表保留 24 小时，之后移到『已核销』tab」
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "returnConfirmedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "returnConfirmedBy" TEXT;
CREATE INDEX IF NOT EXISTS "Order_returnStatus_returnConfirmedAt_idx" ON "Order" ("returnStatus", "returnConfirmedAt");

-- 已核销的旧单回填核销时间：取订单操作记录里最后一次「回单 → RETURNED」的时间；
-- 没有记录的退回到送货日（都早于 24 小时，直接归入「已核销」tab）。只写新列
UPDATE "Order" o SET "returnConfirmedAt" = COALESCE(
  (SELECT MAX(a."createdAt") FROM "OrderAuditLog" a
    WHERE a."orderId" = o.id AND a."changedFields" -> 'returnStatus' ->> 'after' = 'RETURNED'),
  o."deliveryDate", o."createdAt")
WHERE o."returnStatus" = 'RETURNED' AND o."returnConfirmedAt" IS NULL;
