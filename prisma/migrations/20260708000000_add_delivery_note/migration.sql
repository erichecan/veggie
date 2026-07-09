-- AlterTable: 第三方送货备注（第三方替我们送货时的具体信息，打印在送货单上）
-- 用 IF NOT EXISTS 保证幂等：dev 库此列已由中断的 migrate dev 提前加上，生产库尚无此列。
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "deliveryNote" TEXT;
