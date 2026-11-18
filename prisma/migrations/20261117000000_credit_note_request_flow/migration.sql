ALTER TABLE "OrderReturn" ADD COLUMN IF NOT EXISTS "actualReturnedProductName" TEXT;
ALTER TABLE "OrderReturn" ADD COLUMN IF NOT EXISTS "actualReturnedProductId" TEXT;
ALTER TABLE "OrderReturn" ADD COLUMN IF NOT EXISTS "warehouseAcceptedQuantity" DECIMAL(12,3);
ALTER TABLE "CreditNoteLine" ADD COLUMN IF NOT EXISTS "sourceOrderLineId" TEXT;

CREATE TABLE IF NOT EXISTS "CreditNoteRequest" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "customerName" TEXT NOT NULL,
  "sourceOrderId" TEXT NOT NULL,
  "sourceOrderCode" TEXT NOT NULL DEFAULT '',
  "sourceInvoiceId" TEXT,
  "sourceReturnId" TEXT,
  "requestDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" TEXT NOT NULL,
  "lines" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "totalIncTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "requestedById" TEXT NOT NULL,
  "requestedByName" TEXT,
  "reviewedById" TEXT,
  "reviewedByName" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "creditNoteId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreditNoteRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CreditNoteRequest_name_key" ON "CreditNoteRequest"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "CreditNoteRequest_creditNoteId_key" ON "CreditNoteRequest"("creditNoteId");
CREATE UNIQUE INDEX IF NOT EXISTS "CreditNoteRequest_sourceReturnId_key" ON "CreditNoteRequest"("sourceReturnId");
CREATE INDEX IF NOT EXISTS "CreditNoteRequest_customerId_status_idx" ON "CreditNoteRequest"("customerId", "status");
CREATE INDEX IF NOT EXISTS "CreditNoteRequest_sourceOrderId_idx" ON "CreditNoteRequest"("sourceOrderId");
CREATE INDEX IF NOT EXISTS "CreditNoteRequest_status_createdAt_idx" ON "CreditNoteRequest"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "CreditNoteLine_sourceOrderLineId_idx" ON "CreditNoteLine"("sourceOrderLineId");
