-- CreateEnum
CREATE TYPE "OrderAdjustmentType" AS ENUM ('DISCOUNT', 'DELIVERY_FEE', 'PRICE_CORRECTION', 'OTHER');

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "isGift" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OrderAdjustment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "OrderAdjustmentType" NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderAdjustment_orderId_idx" ON "OrderAdjustment"("orderId");

-- AddForeignKey
ALTER TABLE "OrderAdjustment" ADD CONSTRAINT "OrderAdjustment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAdjustment" ADD CONSTRAINT "OrderAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

