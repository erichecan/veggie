-- 给 12 个预置角色起人话名字
--
-- 平迁迁移（20260807000001）直接拿 legacy 枚举名当角色名，于是权限中心里列出来的是
-- 「BOSS」「DISPATCH」「EXTERNAL_SALES」—— 这个页面是给客户的管理员用的，不是给
-- 开发看的。code 保持不变（迁移脚本、平迁基线、legacy 回退都按 code 认它们），
-- 只改显示名。
--
-- 名字与用户管理页上一直在用的中文标签一致（users-tab.tsx 的 ROLE_LABEL_ZH），
-- 免得同一个角色在两个页面上叫两个名字。

UPDATE "AppRole" SET "name" = v.name, "updatedAt" = NOW()
FROM (VALUES
  ('boss',           '老板'),
  ('operator',       '销售（运营后台）'),
  ('sales',          '销售助理'),
  ('external_sales', '外部合作销售'),
  ('dispatch',       '调度'),
  ('finance',        '财务'),
  ('warehouse',      '仓管'),
  ('sorter',         '分拣员'),
  ('picker',         '拣货员'),
  ('driver',         '司机'),
  ('restaurant',     '餐馆客户'),
  ('other',          '其他')
) AS v(code, name)
WHERE "AppRole"."code" = v.code
  AND "AppRole"."isSystem" = true
  -- 只改还没被人动过的：管理员如果已经自己改过名字，不要覆盖回去
  AND "AppRole"."name" = UPPER(v.code);
