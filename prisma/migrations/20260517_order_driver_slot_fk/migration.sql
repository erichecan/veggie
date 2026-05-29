-- Add driverSlotId FK on Order → DriverSlot
-- Replaces the combined deliveryBatch string with a proper FK relation

-- 1. Add the column (camelCase to match Prisma convention)
ALTER TABLE "Order" ADD COLUMN "driverSlotId" TEXT;

-- 2. Backfill: match existing deliveryBatch strings to DriverSlot records
--    deliveryBatch format: "1 am BAO" → batchNum=1, timeOfDay='am', driverName='BAO'
--    We match by driverName (case-insensitive) since it's unique in DriverSlot
UPDATE "Order" o
SET "driverSlotId" = ds."id"
FROM "DriverSlot" ds
WHERE o."deliveryBatch" IS NOT NULL
  AND UPPER(TRIM(
    CASE
      WHEN POSITION(' ' IN TRIM(o."deliveryBatch")) > 0
      THEN SUBSTRING(TRIM(o."deliveryBatch") FROM POSITION(' ' IN SUBSTRING(TRIM(o."deliveryBatch") FROM POSITION(' ' IN TRIM(o."deliveryBatch")) + 1)) + POSITION(' ' IN TRIM(o."deliveryBatch")) + 1)
      ELSE TRIM(o."deliveryBatch")
    END
  )) = UPPER(TRIM(ds."driverName"));

-- 3. Add FK constraint
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_driverSlotId_fkey"
  FOREIGN KEY ("driverSlotId") REFERENCES "DriverSlot"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Add index for performance
CREATE INDEX "Order_driverSlotId_idx" ON "Order"("driverSlotId");
