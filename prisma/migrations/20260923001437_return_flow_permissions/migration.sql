-- 退换货流程补缺口（2026-09-22）：仓库核实新权限点 + 销售角色获得退货审核权限。
--
-- 背景见 DEV-PLAN.md「销售角色获得审核权限」「仓库核实」两节：
--   1. 新增 dispatch.trip.warehouse_verify，挂给 WAREHOUSE——司机上报的退换货先
--      落 WAREHOUSE_PENDING，仓库次日核实实物在不在车上，核实通过才转入现有的
--      销售/运营审核队列（dispatch.trip.returns）。
--   2. dispatch.trip.returns / dispatch.trip.read_returns 此前只挂 boss/operator，
--      追加给 sales（与 boss/operator 并存，不收回），因为 operator/returns 页面
--      自己画的流程图上写的就是"Salesperson"处理，但权限一直没跟上。

-- 1. 权限点目录镜像（lib/rbac/catalog.ts 的镜像，仅供配置页展示，不参与鉴权判定）
INSERT INTO "Permission" ("id","module","action","labelZh","labelEn","sortKey") VALUES
  ('dispatch.trip.warehouse_verify','dispatch.trip','warehouse_verify','仓库核实退货','Warehouse Verify Returns',189)
ON CONFLICT ("id") DO UPDATE SET
  "module"=EXCLUDED."module","action"=EXCLUDED."action",
  "labelZh"=EXCLUDED."labelZh","labelEn"=EXCLUDED."labelEn","sortKey"=EXCLUDED."sortKey";

-- 2. 新权限点 + 行程只读可见性发给 WAREHOUSE（幂等追加，不覆盖管理员已调过的权限）。
--    WAREHOUSE 此前完全没有 dispatch.trip.* 权限，新增的仓库核实页面需要先能
--    列出行程（GET /api/trips 需要 dispatch.trip.read）才知道有哪些待核实的记录，
--    一并给上，仅读不写。
UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY[
          'dispatch.trip.warehouse_verify',
          'dispatch.trip.read',
          'dispatch.trip.read_returns'
        ]) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE "code" = 'warehouse'
  AND (
    'dispatch.trip.warehouse_verify' <> ALL("permissions")
    OR 'dispatch.trip.read' <> ALL("permissions")
    OR 'dispatch.trip.read_returns' <> ALL("permissions")
  );

-- 3. 退货审核相关权限追加给 SALES（与 boss/operator 并存，不收回后者）
UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY['dispatch.trip.read_returns', 'dispatch.trip.returns']) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE "code" = 'sales'
  AND (
    'dispatch.trip.read_returns' <> ALL("permissions")
    OR 'dispatch.trip.returns' <> ALL("permissions")
  );

-- 权限集变了 → 已签发 token 的位图与最新状态不一致，受影响角色的用户都要重新
-- 登录才能拿到新权限。
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE r."code" IN ('warehouse', 'sales')
);
