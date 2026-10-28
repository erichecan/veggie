-- 退货/报废整合（DEV-PLAN.md 2026-10-27）：新增 dispatch.goods_return 权限模块
--
-- 背景：日销售中心手动登记退货（OrderReturn 表）与司机端上报退货（Trip/ReturnItem，
-- dispatch.trip.returns）是两条入口，共用同一套审核/处置规则（lib/returns-engine.ts），
-- 但各自需要独立的权限点。
--
-- 发放对象严格按 DEV-PLAN「路由清单」一节拍板：
--   · WAREHOUSE                  → dispatch.goods_return.warehouse_verify
--   · OPERATOR / SALES（现有持有 dispatch.trip.read_returns 的角色）
--                                 → dispatch.goods_return.register + dispatch.goods_return.review
-- 不含 read：GET /api/order-returns 直接复用 warehouse_verify 或 review（任一即可），
-- 没有单独的查看权限点。BOSS 本轮不发（计划只点名 OPERATOR/SALES）。

UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY['dispatch.goods_return.warehouse_verify']) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE "isSystem" = true
  AND "code" = 'warehouse';

UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY[
          'dispatch.goods_return.register',
          'dispatch.goods_return.review'
        ]) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE "isSystem" = true
  AND "code" IN ('operator', 'sales');

-- 权限集变了 → 已签发 token 的位图里缺这几位，调两条分支各自只踢受影响角色下的人。
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE r."isSystem" = true AND r."code" IN ('warehouse', 'operator', 'sales')
);
