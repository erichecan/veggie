-- Add DriverSlot table for managing driver roster
-- Each driver is one row; timeOfDay and batchNum are their default assigned slot
CREATE TABLE IF NOT EXISTS "DriverSlot" (
  "id"         TEXT NOT NULL,
  "timeOfDay"  TEXT NOT NULL,   -- 'am' | 'pm'
  "batchNum"   INTEGER NOT NULL, -- 1-5
  "driverName" TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DriverSlot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DriverSlot_name_unique" UNIQUE ("driverName")
);
