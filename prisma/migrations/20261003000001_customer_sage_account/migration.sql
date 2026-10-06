-- AlterTable
-- Sage（会计系统）对账用的客户编号，财务要求全局唯一；选填（历史客户大多没有）
ALTER TABLE "Customer" ADD COLUMN "sageAccount" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_sageAccount_key" ON "Customer"("sageAccount");
