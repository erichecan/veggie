-- 采购导入路由已在「采购单据识别收口到一条确定性路径」中删除（POST /api/purchase-orders/import），
-- 权限点 purchase.order.import 随之从 lib/rbac/catalog.ts 移除。库里残留的授权若不清掉，
-- 权限配置页会列出一个点不到任何路由的假开关（见 [[decorative-permission-points]] 那类问题）。
--
-- ⚠️ 不改 20260807000003 那条历史迁移 —— 它 2026-08-08 已在生产应用，
-- 改文件会让 prisma migrate deploy 因 checksum 不匹配整批失败。存量数据用这条新迁移收敛。
--
-- 不 bump permVersion：该权限点对应的路由已不存在，移除它不改变任何人的实际可达性，
-- 没必要把所有在线用户踢下线。

DELETE FROM "UserPermissionGrant" WHERE "permissionId" = 'purchase.order.import';

UPDATE "AppRole"
SET "permissions" = array_remove("permissions", 'purchase.order.import'),
    "updatedAt"   = NOW()
WHERE 'purchase.order.import' = ANY("permissions");

DELETE FROM "Permission" WHERE "id" = 'purchase.order.import';
