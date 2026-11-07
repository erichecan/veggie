-- One canonical return ledger for driver reports and manual registrations.
ALTER TABLE "OrderReturn"
  ADD COLUMN "orderLineId" TEXT,
  ADD COLUMN "sourceTripId" TEXT,
  ADD COLUMN "unitPrice" DECIMAL(12,2),
  ADD COLUMN "photo" TEXT,
  ADD COLUMN "lateReportNote" TEXT,
  ADD COLUMN "refundMode" TEXT,
  ADD COLUMN "refundPct" DECIMAL(6,3),
  ADD COLUMN "refundAmount" DECIMAL(12,2),
  ADD COLUMN "refundNote" TEXT;

ALTER TABLE "OrderReturn"
  ADD CONSTRAINT "OrderReturn_orderLineId_fkey"
    FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "OrderReturn_sourceTripId_fkey"
    FOREIGN KEY ("sourceTripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "OrderReturn_orderLineId_status_idx" ON "OrderReturn"("orderLineId", "status");
CREATE INDEX "OrderReturn_sourceTripId_status_idx" ON "OrderReturn"("sourceTripId", "status");
