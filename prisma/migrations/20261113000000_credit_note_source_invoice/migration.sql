ALTER TABLE "CreditNote" ADD COLUMN "sourceInvoiceId" TEXT;

CREATE INDEX "CreditNote_sourceInvoiceId_idx" ON "CreditNote"("sourceInvoiceId");

ALTER TABLE "CreditNote"
ADD CONSTRAINT "CreditNote_sourceInvoiceId_fkey"
FOREIGN KEY ("sourceInvoiceId") REFERENCES "Invoice"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
