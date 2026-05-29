-- Change wave unique constraint from (waveDate, waveNumber) to (waveDate, driverSlotId)
-- This allows creating one wave per DriverSlot per day instead of per waveNumber.
-- All 15 active DriverSlots have batchNum=1, so the old constraint only allowed 1 wave per day.

-- Drop old unique constraint
DROP INDEX IF EXISTS "PickingWave_waveDate_waveNumber_key";

-- Add new unique constraint: one wave per date + driverSlot
CREATE UNIQUE INDEX "PickingWave_waveDate_driverSlotId_key" ON "PickingWave"("waveDate", "driverSlotId");
