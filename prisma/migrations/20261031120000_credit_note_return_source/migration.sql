-- Link each credit-note line to the return decision that created it.
-- Unique nullable source keys make automatic draft generation idempotent.
ALTER TABLE "CreditNoteLine" ADD COLUMN "sourceReturnId" TEXT;
CREATE UNIQUE INDEX "CreditNoteLine_sourceReturnId_key" ON "CreditNoteLine"("sourceReturnId");
