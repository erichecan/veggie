-- P0+P1 Schema Changes
-- Customer: default driver binding (P1-4)
-- Order: edit approval flag (P1-6)
-- Trip: settlement fields (P1-10)
-- New tables: PurchaseSuggestion (P0-2), Notification (P1-11), Statement (P1-1)

-- ============================================================
-- 1. ALTER existing tables
-- ============================================================

-- Customer: default driver slot binding
ALTER TABLE "Customer" ADD COLUMN "defaultDriverSlotId" TEXT;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_defaultDriverSlotId_fkey"
  FOREIGN KEY ("defaultDriverSlotId") REFERENCES "DriverSlot"("id") ON DELETE SET NULL;
CREATE INDEX "Customer_defaultDriverSlotId_idx" ON "Customer"("defaultDriverSlotId");

-- Order: edit approval flag (CONFIRMED orders needing boss approval to edit)
ALTER TABLE "Order" ADD COLUMN "editApprovalRequired" BOOLEAN NOT NULL DEFAULT false;

-- Trip: driver settlement fields
ALTER TABLE "Trip" ADD COLUMN "cashCollected" DECIMAL(12,2) DEFAULT 0;
ALTER TABLE "Trip" ADD COLUMN "onlineCollected" DECIMAL(12,2) DEFAULT 0;
ALTER TABLE "Trip" ADD COLUMN "settlementStatus" TEXT DEFAULT 'pending';
ALTER TABLE "Trip" ADD COLUMN "settledAt" TIMESTAMP;
ALTER TABLE "Trip" ADD COLUMN "settledBy" TEXT;
ALTER TABLE "Trip" ADD COLUMN "settlementNote" TEXT;

CREATE INDEX "Trip_settlementStatus_idx" ON "Trip"("settlementStatus");

-- ============================================================
-- 2. CREATE new tables
-- ============================================================

-- PurchaseSuggestion: auto-generated purchase recommendations (P0-2)
CREATE TABLE "PurchaseSuggestion" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL DEFAULT 'test-company',
  "productId" TEXT NOT NULL,
  "productName" TEXT NOT NULL,
  "currentStock" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "demandQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "suggestedQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "supplierId" TEXT,
  "supplierName" TEXT,
  "estimatedCost" DECIMAL(12,2),
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "purchaseOrderId" TEXT,
  "generatedAt" TIMESTAMP NOT NULL DEFAULT now(),
  "resolvedAt" TIMESTAMP,
  "resolvedBy" TEXT,
  CONSTRAINT "PurchaseSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PurchaseSuggestion_productId_idx" ON "PurchaseSuggestion"("productId");
CREATE INDEX "PurchaseSuggestion_status_idx" ON "PurchaseSuggestion"("status");
CREATE INDEX "PurchaseSuggestion_generatedAt_idx" ON "PurchaseSuggestion"("generatedAt");

-- Notification: in-app notifications (P1-11)
CREATE TABLE "Notification" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL DEFAULT 'test-company',
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "data" JSONB DEFAULT '{}',
  "read" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");
CREATE INDEX "Notification_read_idx" ON "Notification"("read");
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- Statement: finance reconciliation statements (P1-1)
CREATE TABLE "Statement" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL DEFAULT 'test-company',
  "customerId" TEXT NOT NULL,
  "customerName" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "openingBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "totalSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "totalPayments" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "closingBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "orderIds" TEXT[] DEFAULT '{}',
  "invoiceIds" TEXT[] DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "sentAt" TIMESTAMP,
  CONSTRAINT "Statement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Statement_customerId_idx" ON "Statement"("customerId");
CREATE INDEX "Statement_status_idx" ON "Statement"("status");
CREATE INDEX "Statement_periodStart_idx" ON "Statement"("periodStart");
