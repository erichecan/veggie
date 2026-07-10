-- CreateEnum
CREATE TYPE "ZoneKey" AS ENUM ('FROZEN', 'CHILLED', 'DRY', 'AMBIENT');

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "key" "ZoneKey" NOT NULL,
    "name" TEXT NOT NULL,
    "nameZh" TEXT NOT NULL,
    "tempRangeLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Zone_key_key" ON "Zone"("key");

-- AlterTable
ALTER TABLE "ProductCategory" ADD COLUMN "requiredZoneId" TEXT;

-- CreateIndex
CREATE INDEX "ProductCategory_requiredZoneId_idx" ON "ProductCategory"("requiredZoneId");

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_requiredZoneId_fkey" FOREIGN KEY ("requiredZoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "currentZoneId" TEXT;

-- CreateIndex
CREATE INDEX "Product_currentZoneId_idx" ON "Product"("currentZoneId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_currentZoneId_fkey" FOREIGN KEY ("currentZoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
