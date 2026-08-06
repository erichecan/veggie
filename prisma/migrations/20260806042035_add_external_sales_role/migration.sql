-- 新增「外部合作销售」角色。
-- 权限比正式 SALES 更窄（不给 invoice / pricelist，customer 不给 update），
-- 且必须配合行级隔离：只能看到自己名下的客户与其订单。
-- 见 lib/permissions.ts 的 EXTERNAL_SALES 与 docs/20260806-rbac-audit-and-tasks.md
--
-- ⚠️ ALTER TYPE ... ADD VALUE 在 PostgreSQL 里不能放在事务块中执行，
-- Prisma 逐条跑 migration.sql 且此文件只有这一句，所以没问题。
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'EXTERNAL_SALES';
