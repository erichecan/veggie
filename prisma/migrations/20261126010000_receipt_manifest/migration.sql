CREATE TABLE "ReceiptManifest" (
    "tripId" TEXT NOT NULL PRIMARY KEY,
    "businessDate" TEXT NOT NULL,
    "driverId" TEXT,
    "driverName" TEXT,
    "vehiclePlate" TEXT,
    "departedAt" TIMESTAMP(3) NOT NULL,
    "handedOverAt" TIMESTAMP(3),
    "handedOverBy" TEXT,
    "actualReceived" DECIMAL(14,2),
    "returnPieces" DECIMAL(14,3),
    "scanClosedAt" TIMESTAMP(3)
);

CREATE TABLE "ReceiptManifestEntry" (
    "tripId" TEXT NOT NULL REFERENCES "ReceiptManifest"("tripId") ON DELETE RESTRICT ON UPDATE CASCADE,
    "orderId" TEXT NOT NULL,
    "orderCode" TEXT,
    "customerName" TEXT NOT NULL,
    "expectedAmount" DECIMAL(14,2) NOT NULL,
    "scannedAt" TIMESTAMP(3),
    "paperIssue" TEXT,
    "paperReviewedAt" TIMESTAMP(3),
    "paperReviewedBy" TEXT,
    "paperReviewNote" TEXT,
    PRIMARY KEY ("tripId", "orderId")
);

CREATE INDEX "ReceiptManifest_businessDate_driverId_idx" ON "ReceiptManifest"("businessDate", "driverId");
CREATE INDEX "ReceiptManifestEntry_orderId_idx" ON "ReceiptManifestEntry"("orderId");
CREATE INDEX "Invoice_saleOrderIds_receipt_idx" ON "Invoice" USING GIN ("saleOrderIds");

ALTER TABLE "OrderReturn" ADD COLUMN "reviewOutcome" TEXT, ADD COLUMN "scrapQuantity" DECIMAL(14,3);
ALTER TABLE "Order" ADD COLUMN "returnIssueAt" TIMESTAMP(3);
ALTER TABLE "OrderReturn" ADD COLUMN "duplicateOfReturnId" TEXT;
ALTER TABLE "ReceiptManifestEntry" ADD COLUMN "unreportedDetectedAt" TIMESTAMP(3);
ALTER TABLE "ReturnIntake" ADD COLUMN "candidateOrderIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "ReturnIntake_candidateOrderIds_idx" ON "ReturnIntake" USING GIN ("candidateOrderIds");
