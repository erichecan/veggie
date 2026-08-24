-- 信息广场（DEV-PLAN 20260824）：新增两个权限点，发给除 RESTAURANT 外的全部预置角色
--
-- 背景：信息广场按设计不做角色差异化（所有内部登录用户都能发帖/浏览），管理动作
-- （置顶/删任意帖）在 handler 内部硬判断 BOSS/OPERATOR，不走权限点。但 RESTAURANT
-- 客户门户账号必须被结构性挡在外面——tests/role-reachability.test.ts 要求这一点
-- 在 route-map 层就是拒绝的，不能只靠 handler 内部判断（那对静态可达性审计不可见）。
-- 所以专门开这一对权限点，只用来划这条内部/外部的线，不做更细的角色区分：
--   tool.bulletin.use    —— API：/api/bulletin-posts/**
--   page.bulletin.access —— 页面：/classic/bulletin/**
--
-- 1. 权限点目录镜像（lib/rbac/catalog.ts 的镜像，仅供配置页展示，不参与鉴权判定）
INSERT INTO "Permission" ("id","module","action","labelZh","labelEn","sortKey") VALUES
  ('tool.bulletin.use','tool.bulletin','use','使用','Use',182),
  ('page.bulletin.access','page.bulletin','access','进入','Access',183)
ON CONFLICT ("id") DO UPDATE SET
  "module"=EXCLUDED."module","action"=EXCLUDED."action",
  "labelZh"=EXCLUDED."labelZh","labelEn"=EXCLUDED."labelEn","sortKey"=EXCLUDED."sortKey";

-- 2. 发给全部预置角色，唯独不发给 restaurant（客户门户账号本就不该碰内部信息广场）
UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY['tool.bulletin.use','page.bulletin.access']) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE "isSystem" = true
  AND "code" <> 'restaurant';

-- 权限集变了 → 已签发 token 的位图里缺这两位，得重新登录才能看到广场入口。
-- 只踢受影响角色下的人（即所有非 restaurant 的预置角色）。
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE r."isSystem" = true AND r."code" <> 'restaurant'
);
