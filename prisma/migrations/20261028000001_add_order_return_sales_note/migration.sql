-- 退换货补全 M5：OrderReturn 销售审核备注独立字段
ALTER TABLE "OrderReturn" ADD COLUMN "salesNote" TEXT;
