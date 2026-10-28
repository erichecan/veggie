-- CreateEnum
CREATE TYPE "GoodsReturnStatus" AS ENUM ('WAREHOUSE_PENDING', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SETTLED');

-- CreateEnum
CREATE TYPE "GoodsReturnDisposition" AS ENUM ('SELLABLE', 'SCRAP');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "goodsReturnStatus" TEXT,
ADD COLUMN     "goodsReturnedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OrderReturn" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "reason" TEXT,
    "actionType" TEXT NOT NULL DEFAULT 'return',
    "exchangeOrderId" TEXT,
    "status" "GoodsReturnStatus" NOT NULL DEFAULT 'WAREHOUSE_PENDING',
    "disposition" "GoodsReturnDisposition",
    "scrapLotId" TEXT,
    "warehouseVerifiedById" TEXT,
    "warehouseVerifiedByName" TEXT,
    "warehouseVerifiedAt" TIMESTAMP(3),
    "warehouseNote" TEXT,
    "approvedById" TEXT,
    "approvedByName" TEXT,
    "approvedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "registeredById" TEXT NOT NULL,
    "registeredByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderReturn_orderId_idx" ON "OrderReturn"("orderId");

-- CreateIndex
CREATE INDEX "OrderReturn_status_idx" ON "OrderReturn"("status");

-- AddForeignKey
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

