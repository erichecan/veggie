-- P0-3: CreditNote + CreditNoteLine tables (credit notes / refund memos)
-- P0-4: Product.safetyStockMin field (low stock warning threshold)
-- P1-3: StockMove source document tracking fields

-- ============================================================================
-- 1. CreditNote (P0-3)
-- ============================================================================
CREATE TABLE "CreditNote" (
  "id"             TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  "name"           TEXT         NOT NULL,
  "customerId"     TEXT         NOT NULL,
  "customerName"   TEXT         NOT NULL,
  "creditDate"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "currency"       TEXT         NOT NULL DEFAULT 'EUR',
  "subtotalExTax"  DECIMAL(12,2) NOT NULL DEFAULT 0,
  "totalTax"       DECIMAL(12,2) NOT NULL DEFAULT 0,
  "totalIncTax"    DECIMAL(12,2) NOT NULL DEFAULT 0,
  "status"         TEXT         NOT NULL DEFAULT 'DRAFT',
  "notes"          TEXT,
  "createdBy"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreditNote_name_key" ON "CreditNote"("name");
CREATE INDEX "CreditNote_customerId_idx" ON "CreditNote"("customerId");
CREATE INDEX "CreditNote_status_idx" ON "CreditNote"("status");
CREATE INDEX "CreditNote_creditDate_idx" ON "CreditNote"("creditDate");

-- ============================================================================
-- 2. CreditNoteLine (P0-3)
-- ============================================================================
CREATE TABLE "CreditNoteLine" (
  "id"             TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  "creditNoteId"   TEXT         NOT NULL,
  "productId"      TEXT         NOT NULL,
  "productName"    TEXT         NOT NULL,
  "quantity"       DECIMAL(14,3) NOT NULL,
  "unitPrice"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  "taxRate"        DECIMAL(6,4) NOT NULL DEFAULT 0,
  "subtotalExTax"  DECIMAL(12,2) NOT NULL DEFAULT 0,
  "taxAmount"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  "subtotalIncTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "reason"         TEXT,
  "sourceOrderId"  TEXT,
  "sourceTripId"   TEXT,
  "sequence"       INTEGER      NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CreditNoteLine_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CreditNoteLine"
  ADD CONSTRAINT "CreditNoteLine_creditNoteId_fkey"
  FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "CreditNoteLine_creditNoteId_idx" ON "CreditNoteLine"("creditNoteId");
CREATE INDEX "CreditNoteLine_productId_idx" ON "CreditNoteLine"("productId");
CREATE INDEX "CreditNoteLine_sourceOrderId_idx" ON "CreditNoteLine"("sourceOrderId");

-- ============================================================================
-- 3. Product.safetyStockMin (P0-4)
-- ============================================================================
ALTER TABLE "Product" ADD COLUMN "safetyStockMin" DECIMAL(14,3) DEFAULT 0;

-- ============================================================================
-- 4. StockMove source document tracking (P1-3)
-- ============================================================================
ALTER TABLE "StockMove" ADD COLUMN "sourceType" TEXT;
ALTER TABLE "StockMove" ADD COLUMN "sourceId"   TEXT;
ALTER TABLE "StockMove" ADD COLUMN "sourceRef"  TEXT;

CREATE INDEX "StockMove_sourceType_sourceId_idx" ON "StockMove"("sourceType", "sourceId");
