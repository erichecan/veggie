-- 打印中心批次「锁定/解锁」权限拆分（2026-09-22）。
--
-- 背景：锁定（含打印拣货单/送货单/销售单/汇总单时自动触发的锁）与解锁此前共用
-- 同一个权限点 stock.pick.manage，OPERATOR/DISPATCH 角色默认都有。客户反馈
-- 应该把「解锁」收口到具体的办公室打单人员，逐个授权，不再按角色批量放开。
--
-- 但锁定与打印是同一个接口的同一次写入，无法靠客户端传的 reason 字段真的分清
-- 「这是打印顺带锁的」还是「这是手动点锁定按钮」——reason 可以被伪造，不是权限
-- 边界。若把锁定也一起收紧，会连带把 OPERATOR 日常的打印动作也一起挡掉。
--
-- 所以拆成两个权限点（lib/rbac/catalog.ts stock.pick 模块）：
--   stock.pick.lock    —— 锁定（POST pick-lock，含打印自动上锁），低风险、可逆，
--                          维持"进得了打印中心就能用"，默认发给 boss/operator/
--                          sales/external_sales（= page.operator.access 的受众）
--   stock.pick.manage  —— 解锁（DELETE pick-lock）+ 取消整波司机安排（POST
--                          pick-unlock），从 operator/dispatch 角色收回，改成
--                          个人级例外授权（UserPermissionGrant，机制已存在）
--
-- 副作用：SALES/EXTERNAL_SALES 角色此前有页面入口却没有 stock.pick.manage，
-- 打印中心的打印功能其实一直 403（没人发现的既存 bug），本次一并修复。
--
-- DISPATCH 角色虽然此前挂着 stock.pick.manage，但没有 page.operator.access，
-- 打印中心页面进不去、调度台也没有锁定/解锁按钮，这个权限点对 DISPATCH 一直是
-- 摸不到的摆设，摘掉零实际影响。

-- 1. 权限点目录镜像（lib/rbac/catalog.ts 的镜像，仅供配置页展示，不参与鉴权判定）
INSERT INTO "Permission" ("id","module","action","labelZh","labelEn","sortKey") VALUES
  ('stock.pick.lock','stock.pick','lock','锁定批次（含打印联动）','Lock Batch (incl. print flow)',188)
ON CONFLICT ("id") DO UPDATE SET
  "module"=EXCLUDED."module","action"=EXCLUDED."action",
  "labelZh"=EXCLUDED."labelZh","labelEn"=EXCLUDED."labelEn","sortKey"=EXCLUDED."sortKey";

-- 2. 新权限点发给能进打印中心的角色（幂等追加，不覆盖管理员已调过的权限）
UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY['stock.pick.lock']) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE "code" IN ('boss', 'operator', 'sales', 'external_sales')
  AND 'stock.pick.lock' <> ALL("permissions");

-- 3. 从 operator / dispatch 收回 stock.pick.manage（解锁/取消司机安排），
--    boss 保留作为兜底管理权限
UPDATE "AppRole"
SET "permissions" = array_remove("permissions", 'stock.pick.manage'),
    "updatedAt"   = NOW()
WHERE "code" IN ('operator', 'dispatch')
  AND 'stock.pick.manage' = ANY("permissions");

-- 权限集变了（新增+收回）→ 已签发 token 的位图与最新状态不一致，两类用户都要
-- 重新登录：拿到新点的（boss/operator/sales/external_sales）要能立刻用上，
-- 被收回点的（operator/dispatch）不能靠旧 token 继续解锁/取消司机安排。
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE r."code" IN ('boss', 'operator', 'sales', 'external_sales', 'dispatch')
);
