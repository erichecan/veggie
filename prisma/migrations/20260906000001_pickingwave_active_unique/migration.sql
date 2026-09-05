-- 同一司机同一时段，未出发的波次只能有一条——这个约束此前只在应用层保证
-- (lib/wave-assign.ts assignOrderToWave 的"查有没有→没有就建"两步没有锁保护)。
-- 2026-09-05 生产事故：两次几乎同时(相差2毫秒)的"分配到批次"请求都读到"还没有波次"，
-- 各自建了一条同名重复波次，其中一单被隔离进界面找不到的那条波次里。
-- 订正脚本 scripts/fix-orphan-and-duplicate-wave-20260906.ts 已清理存量重复数据（全库校验为 0），
-- 现在补上数据库层的兜底：用部分唯一索引（只约束未出发的波次）拦下并发建重复波次。
CREATE UNIQUE INDEX "PickingWave_active_driver_slot_key"
ON "PickingWave" ("driverName", "timeOfDay", "waveDate")
WHERE "dispatchedAt" IS NULL AND "driverName" IS NOT NULL AND "timeOfDay" IS NOT NULL AND "waveDate" IS NOT NULL;
