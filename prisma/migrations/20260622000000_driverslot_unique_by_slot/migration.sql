-- Change DriverSlot unique constraint from (driverName) to (timeOfDay, batchNum, driverName)
-- Allows the same driver name to be assigned to different time slots / batches,
-- only blocking an exact duplicate slot (same timeOfDay + batchNum + driverName).
-- Existing 24 rows all have distinct driverName, so no data conflict on the new index.

-- Drop old global-name unique constraint (backed by a table CONSTRAINT, not a plain index)
ALTER TABLE "DriverSlot" DROP CONSTRAINT IF EXISTS "DriverSlot_driverName_key";

-- Add composite unique constraint: one row per timeOfDay + batchNum + driverName
CREATE UNIQUE INDEX IF NOT EXISTS "DriverSlot_timeOfDay_batchNum_driverName_key" ON "DriverSlot"("timeOfDay", "batchNum", "driverName");
