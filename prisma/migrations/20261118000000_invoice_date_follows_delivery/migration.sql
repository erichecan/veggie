ALTER TABLE "Invoice"
  ADD COLUMN IF NOT EXISTS "invoiceDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Historical invoices with delivery orders inherit the earliest linked delivery date.
-- Unlinked/manual invoices retain their creation date as the best available business date.
UPDATE "Invoice" AS invoice
SET "invoiceDate" = COALESCE(
  (
    SELECT MIN("deliveryDate")
    FROM "Order"
    WHERE id = ANY(invoice."saleOrderIds")
      AND "deliveryDate" IS NOT NULL
  ),
  invoice."createdAt"
);

CREATE INDEX IF NOT EXISTS "Invoice_invoiceDate_idx" ON "Invoice"("invoiceDate");

-- Keep the legacy order-level date used by sales reports in sync as well.
UPDATE "Order"
SET "invoiceDate" = "deliveryDate"
WHERE "deliveryDate" IS NOT NULL;
