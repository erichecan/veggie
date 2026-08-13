-- 司机提成考核报表（台账 H3）上线：把 analytics.commission.read 发给管理岗
--
-- 背景：`analytics.commission.read` 自权限目录建立起就存在，但**没有任何 handler
-- 引用它**——I2 实测出的 13 个「假开关」之一：配置页上勾了没勾，系统行为完全一样。
-- 本轮新增 `/api/analytics/driver-commission` 并把它作为该路由的闸门，
-- 这个权限点从此是真的。
--
-- 谁该有：
--   · boss     —— 考核报表本来就是给他看的
--   · operator —— 运营后台管司机绩效
-- 平迁进来的 legacy 角色是靠「现有可达性」推导权限的（derive-system-roles.ts），
-- 而一个没被任何 handler 引用的权限点不会进任何人的 Needed 集合 —— 所以这两个角色
-- 此前一个都没拿到。不补的话，报表做完老板自己打不开。
--
-- ⛔ finance 刻意不给，尽管「发钱的人要能核」听着最有道理：报表页落在
--    `/classic/boss/analytics/*`，而那个 layout 只放行 BOSS + OPERATOR。
--    单发 API 权限而页面进不去，就又造出一个够不着的开关 —— H2 刚在
--    ROLE_REPORT_ACCESS 上踩过同样的坑。财务侧要核提成属于 C9（当日货款确认）
--    的范围，连同入口一起决定，不在这条迁移里顺手放开。
-- ⛔ dispatch_center 同理不给：它有 analytics.logistics.read（调度日常要看行程），
--    但提成金额是**薪酬数据**。用「谁有物流分析就给谁」这种看着聪明的条件，
--    会把薪酬顺手发给调度台。
-- ⛔ DRIVER 更不在此列：司机自查本月提成属于司机端功能（C8/C9 那条线），
--    且 DRIVER 在 role-access 里根本够不着 /api/analytics/**，给了也是够不着的假开关。
--
-- 只动预置角色（isSystem = true）。业务角色模板 sales_manager 在建立时就显式声明了
-- analytics.commission，不需要也不应该被这条迁移改写。

UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY['analytics.commission.read']) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE "isSystem" = true
  AND "code" IN ('boss', 'operator');

-- 权限集变了 → 已签发 token 的位图里缺这一位，点开报表会 403。
-- 只踢受影响角色下的人。
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE r."isSystem" = true AND r."code" IN ('boss', 'operator')
);
