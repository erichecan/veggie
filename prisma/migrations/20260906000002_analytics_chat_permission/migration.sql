-- AI 问数（数据分析聊天中台）20260906：新增权限点 analytics.chat.read / analytics.chat.manage，
-- 只发给 boss——这个功能按客户要求"只给老板级别看"，不跟其它 analytics.* 权限一样普发给 operator。

-- 1. 权限点目录镜像（lib/rbac/catalog.ts 的镜像，仅供配置页展示，不参与鉴权判定）
INSERT INTO "Permission" ("id","module","action","labelZh","labelEn","sortKey") VALUES
  ('analytics.chat.read','analytics.chat','read','查看','View',185),
  ('analytics.chat.manage','analytics.chat','manage','管理','Manage',186)
ON CONFLICT ("id") DO UPDATE SET
  "module"=EXCLUDED."module","action"=EXCLUDED."action",
  "labelZh"=EXCLUDED."labelZh","labelEn"=EXCLUDED."labelEn","sortKey"=EXCLUDED."sortKey";

-- 2. 只发给 boss（幂等追加，不覆盖管理员在页面上已经调过的权限）
UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY['analytics.chat.read','analytics.chat.manage']) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE "isSystem" = true
  AND "code" = 'boss';

-- 权限集变了 → 已签发 token 的位图里缺这两位，得重新登录才能用。只影响 boss 角色下的人。
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE r."isSystem" = true AND r."code" = 'boss'
);
