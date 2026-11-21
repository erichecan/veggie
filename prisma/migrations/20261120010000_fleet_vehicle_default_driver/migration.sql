ALTER TABLE "FleetVehicle"
ADD COLUMN "defaultDriverId" TEXT;

CREATE UNIQUE INDEX "FleetVehicle_defaultDriverId_key"
ON "FleetVehicle"("defaultDriverId");

ALTER TABLE "FleetVehicle"
ADD CONSTRAINT "FleetVehicle_defaultDriverId_fkey"
FOREIGN KEY ("defaultDriverId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
