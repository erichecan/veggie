-- Identify which approved return created each draft credit-note line.
-- NULL remains valid for manually created and historical credit-note lines.
ALTER TABLE "CreditNoteLine" ADD COLUMN "sourceReturnId" TEXT;
CREATE UNIQUE INDEX "CreditNoteLine_sourceReturnId_key" ON "CreditNoteLine"("sourceReturnId");
