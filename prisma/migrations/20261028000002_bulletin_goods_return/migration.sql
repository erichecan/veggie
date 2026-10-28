-- 退换货补全 M4：信息广场接入退换货自动通知
ALTER TYPE "BulletinCategory" ADD VALUE 'GOODS_RETURN';
ALTER TABLE "BulletinPost" ADD COLUMN "linkUrl" TEXT;
