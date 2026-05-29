-- CreateTable
CREATE TABLE "OrderDiscrepancy" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "orderedQty" DECIMAL(14,3) NOT NULL,
    "pickedQty" DECIMAL(14,3) NOT NULL,
    "diffQty" DECIMAL(14,3) NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resolution" TEXT,
    "substituteProductId" TEXT,
    "substituteProductName" TEXT,
    "substituteQty" DECIMAL(14,3),
    "substituteUnitPrice" DECIMAL(12,2),
    "note" TEXT,
    "reportedBy" TEXT,
    "reportedByName" TEXT,
    "resolvedBy" TEXT,
    "resolvedByName" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDiscrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderDiscrepancy_code_key" ON "OrderDiscrepancy"("code");

-- CreateIndex
CREATE INDEX "OrderDiscrepancy_orderId_idx" ON "OrderDiscrepancy"("orderId");

-- CreateIndex
CREATE INDEX "OrderDiscrepancy_status_idx" ON "OrderDiscrepancy"("status");

-- CreateIndex
CREATE INDEX "OrderDiscrepancy_createdAt_idx" ON "OrderDiscrepancy"("createdAt");

-- AddForeignKey
ALTER TABLE "OrderDiscrepancy" ADD CONSTRAINT "OrderDiscrepancy_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
