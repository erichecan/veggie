ALTER TABLE "Invoice"
ADD COLUMN "writeOffAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

INSERT INTO "Account" ("id", "code", "name", "nameZh", "type", "active", "allowManual", "createdAt")
VALUES ('acct_6990_cash_rounding', '6990', 'Cash Rounding Write-offs', '收款抹零', 'EXPENSE', true, false, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

CREATE TABLE "PaymentBatch" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "paymentJournalId" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "method" TEXT NOT NULL DEFAULT 'transfer',
  "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentBatch_paymentJournalId_fkey" FOREIGN KEY ("paymentJournalId") REFERENCES "PaymentJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "Payment" ADD COLUMN "paymentBatchId" TEXT;
CREATE INDEX "Payment_paymentBatchId_idx" ON "Payment"("paymentBatchId");
CREATE INDEX "PaymentBatch_customerId_paidAt_idx" ON "PaymentBatch"("customerId", "paidAt");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_paymentBatchId_fkey"
  FOREIGN KEY ("paymentBatchId") REFERENCES "PaymentBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
