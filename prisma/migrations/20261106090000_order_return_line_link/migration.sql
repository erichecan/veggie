-- Tie a manual return registration to the exact sold order line. Historical
-- rows remain nullable and are handled conservatively by the API.
ALTER TABLE "OrderReturn" ADD COLUMN "orderLineId" TEXT;

CREATE INDEX "OrderReturn_orderLineId_idx" ON "OrderReturn"("orderLineId");

ALTER TABLE "OrderReturn"
ADD CONSTRAINT "OrderReturn_orderLineId_fkey"
FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
