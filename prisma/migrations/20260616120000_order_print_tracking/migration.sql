-- 销售单打印状态追踪：新增打印时间/打印人/类型/次数字段
ALTER TABLE "Order" ADD COLUMN "printedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "printedById" TEXT;
ALTER TABLE "Order" ADD COLUMN "printedByName" TEXT;
ALTER TABLE "Order" ADD COLUMN "printType" TEXT;
ALTER TABLE "Order" ADD COLUMN "printCount" INTEGER NOT NULL DEFAULT 0;
