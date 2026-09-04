-- Customer: 新增 updatedAt / updatedBy，支撑客户列表「Last Updated by / Last Updated on」筛选
ALTER TABLE "Customer" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Customer" ADD COLUMN "updatedBy" TEXT;

CREATE INDEX "Customer_updatedAt_idx" ON "Customer"("updatedAt");
