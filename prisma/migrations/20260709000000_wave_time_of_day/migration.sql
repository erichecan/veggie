-- PickingWave.timeOfDay：波次按"司机+时段"聚合改造的一部分（批次号=托盘号，不再=独立车次）。
-- 与 driverName 同为快照字段，可空、无默认，存量波次由 scripts/backfill-wave-timeofday.ts 回填。
ALTER TABLE "PickingWave" ADD COLUMN IF NOT EXISTS "timeOfDay" TEXT;

-- 查询优化索引；真正的"同司机同时段未出发波次只能有一条"由应用层(lib/wave-assign.ts)保证。
-- 数据库层的 partial unique index 留到历史重复波次(同司机同时段多条未出发波次)合并干净后再补，
-- 见 DEV-PLAN.md 第 6 节，避免建索引时因存量脏数据直接失败。
CREATE INDEX IF NOT EXISTS "PickingWave_waveDate_driverName_timeOfDay_idx"
  ON "PickingWave" ("waveDate", "driverName", "timeOfDay");
