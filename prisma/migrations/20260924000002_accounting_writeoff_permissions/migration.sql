-- 会计核销重构（2026-09-24）：司机交账/司机对账两个独立入口下线，合并进会计核销页。
--
-- 权限点变化（lib/rbac/catalog.ts）：
--   finance.settlement 模块改名义为「司机收款确认」，去掉 create（司机不再自己申报，
--   钱直接由系统按订单算出，会计核对无误后 confirm——这次改造起 confirm 会真正
--   生成 Payment、核销发票，不可撤销）
--   新增 finance.write_off 模块（送货单核销）：read / confirm / return 三个动作，
--   取代此前 /api/orders/bulk 内部硬编码的角色判断（isFinance || isOperatorOrBoss）
--
-- 顺带发现并修复：/api/orders/bulk 外层闸门（route-map.ts）此前只挂
-- sales.order.bulk_import，FINANCE 角色一直没有这个点——批量核销真正的授权在
-- 路由内部判定，但请求连外层闸门都过不去，FINANCE 从来没能真正调通这个接口。
-- 现在外层闸门改成 sales.order.bulk_import 或 finance.write_off.confirm 任一即可。

-- 1. 权限点目录镜像
INSERT INTO "Permission" ("id","module","action","labelZh","labelEn","sortKey") VALUES
  ('finance.write_off.read','finance.write_off','read','查看','View',191),
  ('finance.write_off.confirm','finance.write_off','confirm','确认','Confirm',192),
  ('finance.write_off.return','finance.write_off','return','退回核实','Return for Review',193)
ON CONFLICT ("id") DO UPDATE SET
  "module"=EXCLUDED."module","action"=EXCLUDED."action",
  "labelZh"=EXCLUDED."labelZh","labelEn"=EXCLUDED."labelEn","sortKey"=EXCLUDED."sortKey";

-- finance.settlement 模块改了义（司机交账 → 司机收款确认），id 不变，只更新展示文案
UPDATE "Permission" SET "labelZh" = '查看司机收款确认' WHERE "id" = 'finance.settlement.read';
UPDATE "Permission" SET "labelZh" = '确认司机收款（真正入账）' WHERE "id" = 'finance.settlement.confirm';

-- 2. 新权限点发给 boss / operator / finance（幂等追加）
UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY['finance.write_off.read', 'finance.write_off.confirm', 'finance.write_off.return']) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE "code" IN ('boss', 'operator', 'finance');

-- 3. 收回 finance.settlement.create（boss / operator / driver 此前都有；driver 的
--    read 也一并收回——司机端页面整页下线，不再有任何交账/对账入口）
UPDATE "AppRole"
SET "permissions" = array_remove("permissions", 'finance.settlement.create'),
    "updatedAt"   = NOW()
WHERE "code" IN ('boss', 'operator', 'driver')
  AND 'finance.settlement.create' = ANY("permissions");

UPDATE "AppRole"
SET "permissions" = array_remove("permissions", 'finance.settlement.read'),
    "updatedAt"   = NOW()
WHERE "code" = 'driver'
  AND 'finance.settlement.read' = ANY("permissions");

-- 权限集变了（新增+收回）→ 已签发 token 的位图与最新状态不一致，都要重新登录
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE r."code" IN ('boss', 'operator', 'finance', 'driver')
);
