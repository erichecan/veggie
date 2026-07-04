-- PickingWave.assignmentDoneAt：分配完成标记（纯进度标记，可反悔；订单变动即清空）
-- 可空、无默认，存量波次 NULL = 分配中，与现状一致。
ALTER TABLE "PickingWave" ADD COLUMN IF NOT EXISTS "assignmentDoneAt" TIMESTAMP(3);
