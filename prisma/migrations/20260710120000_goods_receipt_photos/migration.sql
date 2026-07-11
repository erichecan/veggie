-- GoodsReceipt.photos：收货取证照片（base64 data URI 数组），配合库存管理"收货"工作台
-- 复用司机退货证据照片同一套轻量存储方式（driver/trip/[id]/page.tsx），无需新建对象存储。
ALTER TABLE "GoodsReceipt" ADD COLUMN IF NOT EXISTS "photos" TEXT[] DEFAULT ARRAY[]::TEXT[];
