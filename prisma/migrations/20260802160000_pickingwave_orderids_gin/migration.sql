-- PickingWave.orderIds 是 String[]，被 attachWaveDisplay / getOrderWaveDisplayMap /
-- driverNameClause 用 `orderIds && ARRAY[...]`（Prisma 的 hasSome）匹配。
-- 订单列表、CSV 导出、发票 PDF、行程打印都走这条路径。
--
-- 该表原有 6 个索引（pkey / status / createdAt / waveDate / driverSlotId /
-- waveDate+driverName+timeOfDay），没有一个能服务数组包含查询，实测走 Seq Scan。
--
-- 生产库实测（2026-08-02，51 行）：
--   建索引前：Seq Scan          0.063 ms
--   建索引后：Bitmap Heap Scan  0.034 ms
-- 当前行数少，绝对收益小；建索引的理由是形状——该表按天线性增长
-- （每司机每时段一条），Seq Scan 的成本随行数线性上升，而这条路径每次列表请求都会走。
--
-- 生产库上是用 CREATE INDEX CONCURRENTLY 建的（不锁 PickingWave 写入，即不阻塞调度台
-- 拖拽派单），随后 prisma migrate resolve --applied 标记。此处为非并发版本，供全新环境
-- 使用（空表无锁表风险，且 CONCURRENTLY 不能在 Prisma 迁移的事务里执行）。

CREATE INDEX IF NOT EXISTS idx_pickingwave_orderids_gin
  ON "PickingWave" USING gin ("orderIds");
