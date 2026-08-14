-- 手动改价权限点（台账 X1/X2）
--
-- 背景：客户 20260814 反馈「订单详情改了单价，操作日志记下了，行却没变」。
-- 查下来是定价引擎根本不接受手动价：前端传的价只用来比对，超容差就记条 warning，
-- 然后照价格表价入库。而那条 warning 前端没有任何代码消费 —— 于是操作员看到的是
-- 「保存成功」，日志还写着「€22.50 → €35.00」，只有数据库里什么都没发生。
--
-- 用户 20260814 决策：允许手动改价，但要显式 —— 落库标 MANUAL、留痕写明当时的价格表价、
-- 并用独立权限点控制谁有权改。
--
-- ⛔ 为什么必须发给**所有**原本能改单的角色：
-- 这是从 `sales.order.update` 里拆出来的子动作，不是新功能。改价这个操作今天对
-- 所有角色都「点得下去」（只是结果被静默换掉）。如果只发给一部分人，等于把一个
-- 一直存在的入口对其余人关掉，而他们不会收到任何提示 —— I2 查出的 13 个「假开关」
-- 与 H3 的教训都指向同一条：拆细动作时漏发权限，功能就对那部分人静默中断。
-- 所以这里按「当前谁有 sales.order.update 就给谁」发放，一个不多一个不少。
--
-- ⛔ RESTAURANT / 客户门户一定不在此列：门户下单走同一个定价引擎，但调用方不传
--    allowManualPrice，餐厅无论如何都填不了自己的价。这条迁移也不会给它权限。
--
-- 收窄留给客户自己：权限配置页可以随时把某个角色的这一项取消（I2 已写了操作指南）。
-- 在这里替客户决定「外部销售不许改价」是越界的 —— 我们不知道他们的商务约定。

UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY['sales.order.override_price']) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE 'sales.order.update' = ANY("permissions")
  AND 'sales.order.override_price' <> ALL("permissions");

-- 权限集变了 → 已签发 token 的位图里缺这一位，改价会被当成无权限而回落到价格表价。
-- 只踢受影响角色下的人。
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE 'sales.order.override_price' = ANY(r."permissions")
);
