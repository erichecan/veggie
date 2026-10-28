-- 给 BOSS 补发退货登记/审核权限（20261028，用户要求）
--
-- 20261027230000_dispatch_goods_return_grant 发 dispatch.goods_return.* 时 BOSS 没在名单里
-- （「BOSS 本轮不发」），结果老板账号进日销售中心看不到「退货登记」tab、
-- 库存页退货看板也不能审核。
--
-- 按那条迁移的同一规则补齐：持有 dispatch.trip.returns 的角色 → register + review。
-- BOSS 持有 dispatch.trip.returns，不持有 dispatch.trip.warehouse_verify，
-- 所以只发 register + review，不发 warehouse_verify（仓库核实仍是 WAREHOUSE 的活）。
-- 幂等：已有的权限点不会重复追加。

UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY[
          'dispatch.goods_return.register',
          'dispatch.goods_return.review'
        ]) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE "isSystem" = true
  AND "code" = 'boss';

-- 权限集变了 → 已签发 token 的位图里缺这两位，bump permVersion 让 boss 角色下的人重新登录拿新位图。
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE r."isSystem" = true AND r."code" = 'boss'
);
