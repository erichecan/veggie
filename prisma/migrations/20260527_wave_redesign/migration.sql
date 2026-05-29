-- Wave Redesign: fixed daily waves tied to DriverSlots
-- Add new fields to PickingWave
ALTER TABLE "PickingWave" ADD COLUMN "waveDate" DATE;
ALTER TABLE "PickingWave" ADD COLUMN "waveNumber" INTEGER;
ALTER TABLE "PickingWave" ADD COLUMN "waveType" TEXT;
ALTER TABLE "PickingWave" ADD COLUMN "driverSlotId" TEXT;
ALTER TABLE "PickingWave" ADD COLUMN "driverName" TEXT;

-- Remove picker-related column and index
DROP INDEX IF EXISTS "PickingWave_assignedPickerId_idx";
ALTER TABLE "PickingWave" DROP COLUMN IF EXISTS "assignedPickerId";

-- Add unique constraint: one wave per date+number
CREATE UNIQUE INDEX "PickingWave_waveDate_waveNumber_key" ON "PickingWave"("waveDate", "waveNumber");

-- Add indexes for common queries
CREATE INDEX "PickingWave_waveDate_idx" ON "PickingWave"("waveDate");
CREATE INDEX "PickingWave_driverSlotId_idx" ON "PickingWave"("driverSlotId");
