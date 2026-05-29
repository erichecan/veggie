-- CreateTable: Lot (库存批次)
CREATE TABLE "Lot" (
    "id" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "initialQty" DECIMAL(14,3) NOT NULL,
    "currentQty" DECIMAL(14,3) NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceRef" TEXT,
    "bestBefore" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lot_lotNumber_key" ON "Lot"("lotNumber");
CREATE INDEX "Lot_productId_idx" ON "Lot"("productId");
CREATE INDEX "Lot_status_idx" ON "Lot"("status");
CREATE INDEX "Lot_arrivedAt_idx" ON "Lot"("arrivedAt");
CREATE INDEX "Lot_sourceType_sourceId_idx" ON "Lot"("sourceType", "sourceId");

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: StockMove add lotId
ALTER TABLE "StockMove" ADD COLUMN "lotId" TEXT;
CREATE INDEX "StockMove_lotId_idx" ON "StockMove"("lotId");
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
