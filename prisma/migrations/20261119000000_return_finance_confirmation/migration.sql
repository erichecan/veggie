ALTER TABLE "OrderReturn"
 ADD COLUMN "workflowVersion" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "returnKind" TEXT NOT NULL DEFAULT 'CURRENT',
 ADD COLUMN "approvedQuantity" DECIMAL(12,3),
 ADD COLUMN "scrapReason" TEXT,
 ADD COLUMN "actualReturnedStockQuantity" DECIMAL(14,3);
ALTER TABLE "Trip" ADD COLUMN "vehiclePlate" TEXT;
ALTER TABLE "PickingWave" ADD COLUMN "vehiclePlate" TEXT;
-- Unprocessed canonical records need a fresh warehouse quality/disposition check.
-- Historical approved/settled records keep v1: their stock effects must never be replayed.
UPDATE "OrderReturn" SET "status" = 'WAREHOUSE_PENDING',
 "warehouseNote" = concat_ws(E'\n', "warehouseNote", '新流程：请补核实质量、实收数量和处置去向')
WHERE "status" = 'PENDING_REVIEW' AND ("disposition" IS NULL OR "warehouseAcceptedQuantity" IS NULL);

CREATE TABLE "ReturnIntake" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "sourceTripId" TEXT NOT NULL REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "customerId" TEXT NOT NULL, "customerName" TEXT NOT NULL,
 "productName" TEXT NOT NULL, "spec" TEXT NOT NULL, "uomLabel" TEXT NOT NULL,
 "quantity" DECIMAL(12,3) NOT NULL,
 "photo" TEXT, "reason" TEXT,
 "status" TEXT NOT NULL DEFAULT 'OPEN',
 "orderReturnId" TEXT UNIQUE,
 "reportedById" TEXT NOT NULL, "reviewedById" TEXT, "reviewNote" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "reviewedAt" TIMESTAMP(3)
);
CREATE INDEX "ReturnIntake_status_createdAt_idx" ON "ReturnIntake"("status", "createdAt");
CREATE INDEX "ReturnIntake_sourceTripId_idx" ON "ReturnIntake"("sourceTripId");
