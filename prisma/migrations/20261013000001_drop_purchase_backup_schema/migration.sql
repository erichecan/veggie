-- 20261013 删除采购数据备份（客户确认：「备份可以删掉了」）
-- ============================================================================
-- 20261008000004_clear_purchase_data 清空采购模块前，把被删的数据整表复制到了独立 schema
-- backup_20261008_purchases（不在 public 里，系统和 Prisma 都不用它）。客户确认清空后的数据无误，
-- 不再需要这份备份。整个 schema 删除；可重复执行(IF EXISTS)。

INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
SELECT 'al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'DELETE', 'purchase-order', 'bulk',
       '删除采购数据备份 schema backup_20261008_purchases（客户确认不再需要）', NOW()
WHERE EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'backup_20261008_purchases');

DROP SCHEMA IF EXISTS backup_20261008_purchases CASCADE;
