-- Add latitude/longitude to Customer for geocoding
ALTER TABLE "Customer" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "Customer" ADD COLUMN "longitude" DOUBLE PRECISION;
