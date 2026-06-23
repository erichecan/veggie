-- 确认出发：PickingWave 增加 dispatchedAt 时间戳
ALTER TABLE "PickingWave" ADD COLUMN "dispatchedAt" TIMESTAMP(3);
