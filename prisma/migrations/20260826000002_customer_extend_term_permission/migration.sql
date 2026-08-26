-- 账期灵活化 20260826：新增权限点 master.customer.extend_term（延长账期），
-- 只发给 boss / finance 两个预置角色——这是给会计/主管的正式操作，不是全员权限。

-- 1. 权限点目录镜像（lib/rbac/catalog.ts 的镜像，仅供配置页展示，不参与鉴权判定）
INSERT INTO "Permission" ("id","module","action","labelZh","labelEn","sortKey") VALUES
  ('master.customer.extend_term','master.customer','extend_term','延长账期','Extend Payment Term',184)
ON CONFLICT ("id") DO UPDATE SET
  "module"=EXCLUDED."module","action"=EXCLUDED."action",
  "labelZh"=EXCLUDED."labelZh","labelEn"=EXCLUDED."labelEn","sortKey"=EXCLUDED."sortKey";

-- 2. 只发给 boss / finance，管理员在页面上已经调过的权限不动（幂等追加，不覆盖）
UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY['master.customer.extend_term']) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE "isSystem" = true
  AND "code" IN ('boss', 'finance');

-- 权限集变了 → 已签发 token 的位图里缺这一位，得重新登录才能用。
-- 只影响 boss/finance 角色下的人。
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE r."isSystem" = true AND r."code" IN ('boss', 'finance')
);
