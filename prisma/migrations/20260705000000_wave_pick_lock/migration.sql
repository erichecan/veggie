-- PickingWave 拣货锁定：打印拣货单后回填 pickLockedAt/pickLockedBy，解锁清空并记录 pickUnlockedAt。
-- 均可空、无默认，存量波次 NULL = 未锁定，与现状一致。
ALTER TABLE "PickingWave" ADD COLUMN IF NOT EXISTS "pickLockedAt" TIMESTAMP(3);
ALTER TABLE "PickingWave" ADD COLUMN IF NOT EXISTS "pickLockedBy" TEXT;
ALTER TABLE "PickingWave" ADD COLUMN IF NOT EXISTS "pickUnlockedAt" TIMESTAMP(3);
