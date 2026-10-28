-- 退货/报废整合（DEV-PLAN.md 2026-10-27）：新增 dispatch.goods_return 权限模块
--
-- 背景：日销售中心手动登记退货（OrderReturn 表）与司机端上报退货（Trip/ReturnItem，
-- dispatch.trip.returns）是两条入口，共用同一套审核/处置规则（lib/returns-engine.ts），
-- 但各自需要独立的权限点——manual 登记入口不应该因为"有 trip.returns" 就自动放开，
-- 也不应该反过来因为没有 trip 模块权限就连手动登记都进不去。
--
-- 发放对象：按「当前谁有对应 Trip 权限就给谁」发放（这是新增能力，不是从既有权限拆分）：
--   · dispatch.trip.returns      → read + register + review （boss / operator / sales 三者都有）
--   · dispatch.trip.warehouse_verify → read + warehouse_verify （只有 warehouse 有）
-- dispatch（调度台）、finance、driver 均不在 dispatch.trip.returns/warehouse_verify 持有者
-- 之列，因此本迁移不动它们——跟它们在 Trip 退货流程里原本就够不着是同一个边界。

UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY[
          'dispatch.goods_return.read',
          'dispatch.goods_return.register',
          'dispatch.goods_return.review'
        ]) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE 'dispatch.trip.returns' = ANY("permissions");

UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY[
          'dispatch.goods_return.read',
          'dispatch.goods_return.warehouse_verify'
        ]) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE 'dispatch.trip.warehouse_verify' = ANY("permissions");

-- 权限集变了 → 已签发 token 的位图里缺这几位，调两条分支各自只踢受影响角色下的人。
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE 'dispatch.goods_return.register' = ANY(r."permissions")
     OR 'dispatch.goods_return.warehouse_verify' = ANY(r."permissions")
);
