-- Support warehouse-entered vehicle returns that have no known driver trip or customer yet.
ALTER TABLE "ReturnIntake"
  ALTER COLUMN "sourceTripId" DROP NOT NULL,
  ALTER COLUMN "customerId" DROP NOT NULL,
  ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'DRIVER',
  ADD COLUMN "vehiclePlate" TEXT,
  ADD COLUMN "driverName" TEXT;

CREATE INDEX "ReturnIntake_sourceType_status_createdAt_idx"
  ON "ReturnIntake"("sourceType", "status", "createdAt");

-- Keep the vehicle and driver visible after an intake is linked to an order return,
-- including cases where no matching recent trip exists.
ALTER TABLE "OrderReturn"
  ADD COLUMN "vehiclePlateSnapshot" TEXT,
  ADD COLUMN "driverNameSnapshot" TEXT;

CREATE INDEX "OrderReturn_vehiclePlateSnapshot_createdAt_idx"
  ON "OrderReturn"("vehiclePlateSnapshot", "createdAt");
