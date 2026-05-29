-- AlterTable: add movedAt to StockMove
-- Business date for inventory batches (follows PO expectedDate, not record creation time)
ALTER TABLE "StockMove" ADD COLUMN "movedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: set movedAt = createdAt for all existing records
UPDATE "StockMove" SET "movedAt" = "createdAt";

-- CreateIndex
CREATE INDEX "StockMove_movedAt_idx" ON "StockMove"("movedAt");
