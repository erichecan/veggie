-- Sprint 3 Multi-Feature Migration
-- Groups 1-5: UI improvements, order field extensions, pricing, UoM, order flow

-- ── 1. Enum: Add CONFIRMED to OrderStatus ──────────────────────────────────
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'CONFIRMED' AFTER 'PENDING';

-- ── 2. Enum: Add PENDING_ASSIGNMENT to TripStatus ──────────────────────────
ALTER TYPE "TripStatus" ADD VALUE IF NOT EXISTS 'PENDING_ASSIGNMENT' AFTER 'PENDING';

-- ── 3. Customer: add salesman field ────────────────────────────────────────
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "salesman" TEXT;

-- ── 4. Order: add new fields ────────────────────────────────────────────────
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "internalNote"     TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "quotationDate"    TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "confirmationDate" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "deliveryDate"     TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "invoiceDate"      TIMESTAMP(3);

-- Backfill quotationDate with createdAt for existing orders
UPDATE "Order" SET "quotationDate" = "createdAt" WHERE "quotationDate" IS NULL;

-- ── 5. OrderAuditLog ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "OrderAuditLog" (
  "id"            TEXT        NOT NULL,
  "orderId"       TEXT        NOT NULL,
  "userId"        TEXT        NOT NULL,
  "action"        TEXT        NOT NULL,
  "changedFields" JSONB,
  "totalBefore"   DECIMAL(12,2),
  "totalAfter"    DECIMAL(12,2),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OrderAuditLog_orderId_idx"   ON "OrderAuditLog"("orderId");
CREATE INDEX IF NOT EXISTS "OrderAuditLog_createdAt_idx" ON "OrderAuditLog"("createdAt");

ALTER TABLE "OrderAuditLog"
  ADD CONSTRAINT "OrderAuditLog_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE
  ON CONFLICT DO NOTHING;

-- ── 6. DeliverySlip ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DeliverySlip" (
  "id"           TEXT         NOT NULL,
  "orderId"      TEXT         NOT NULL,
  "customerId"   TEXT         NOT NULL,
  "customerName" TEXT         NOT NULL,
  "deliveryDate" TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeliverySlip_pkey"   PRIMARY KEY ("id"),
  CONSTRAINT "DeliverySlip_orderId_key" UNIQUE ("orderId")
);

CREATE INDEX IF NOT EXISTS "DeliverySlip_customerId_idx" ON "DeliverySlip"("customerId");
CREATE INDEX IF NOT EXISTS "DeliverySlip_createdAt_idx"  ON "DeliverySlip"("createdAt");

ALTER TABLE "DeliverySlip"
  ADD CONSTRAINT "DeliverySlip_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE
  ON CONFLICT DO NOTHING;
