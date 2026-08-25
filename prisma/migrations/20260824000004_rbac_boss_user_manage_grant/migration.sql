-- 老板停不了别的账号：boss 角色一直只有 system.user.read，没有 system.user.manage。
-- 20260807000001 建预置角色/20260807000002 重置权限时，operator 都补了这一位，boss 漏了——
-- 结果是"老板"能看用户列表，但停用/启用/新建/改密/重置密码全部 403（这些接口的闸门统一是
-- system.user.manage，见 app/api/users/route.ts、app/api/users/[id]/route.ts）。
--
-- 只动预置角色（isSystem = true）。

UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY['system.user.manage']) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE "isSystem" = true
  AND "code" = 'boss';

-- 权限集变了 → 已签发 token 的位图里缺这一位，点停用会 403。
-- 只踢 boss 角色下的人重新登录。
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE r."isSystem" = true AND r."code" = 'boss'
);
