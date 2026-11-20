CREATE TABLE "FleetVehicle" (
  "id" TEXT NOT NULL,
  "plate" TEXT NOT NULL,
  "note" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FleetVehicle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FleetVehicle_plate_key" ON "FleetVehicle"("plate");
CREATE INDEX "FleetVehicle_isActive_plate_idx" ON "FleetVehicle"("isActive", "plate");

-- Keep existing delivery plate snapshots selectable immediately after rollout.
INSERT INTO "FleetVehicle" ("id", "plate", "createdAt", "updatedAt")
SELECT 'fleet-' || md5(plates.plate), plates.plate, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT UPPER(REGEXP_REPLACE(BTRIM(source."vehiclePlate"), '[[:space:]]+', ' ', 'g')) AS plate
  FROM (
    SELECT "vehiclePlate" FROM "PickingWave"
    UNION ALL
    SELECT "vehiclePlate" FROM "Trip"
  ) source
  WHERE NULLIF(BTRIM(source."vehiclePlate"), '') IS NOT NULL
) plates;
