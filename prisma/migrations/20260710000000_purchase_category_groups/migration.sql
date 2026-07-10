-- CreateEnum
CREATE TYPE "CategoryGroupKey" AS ENUM ('DRY_GOODS', 'JAPANESE_KOREAN', 'SUPERMARKET', 'FRESH_FROZEN');

-- CreateTable
CREATE TABLE "CategoryGroup" (
    "id" TEXT NOT NULL,
    "key" "CategoryGroupKey" NOT NULL,
    "name" TEXT NOT NULL,
    "nameZh" TEXT NOT NULL,
    "cadence" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CategoryGroup_key_key" ON "CategoryGroup"("key");

-- AlterTable
ALTER TABLE "ProductCategory" ADD COLUMN "groupId" TEXT;

-- CreateIndex
CREATE INDEX "ProductCategory_groupId_idx" ON "ProductCategory"("groupId");

-- AlterTable
ALTER TABLE "PurchaseSuggestion" ADD COLUMN "categoryGroupKey" TEXT,
ADD COLUMN "reason" TEXT;

-- CreateIndex
CREATE INDEX "PurchaseSuggestion_categoryGroupKey_idx" ON "PurchaseSuggestion"("categoryGroupKey");

-- AddForeignKey
ALTER TABLE "CategoryGroup" ADD CONSTRAINT "CategoryGroup_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CategoryGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
