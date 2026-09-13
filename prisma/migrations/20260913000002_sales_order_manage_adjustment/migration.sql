-- 订单调整行权限点（DEV-PLAN.md：订单调整行体系）
--
-- 背景：生产库长期靠虚构商品（price difference/Small Offer Set/Discount/
-- Deliver Service）将就实现差价调整/促销赠品/折扣/配送费，见
-- docs/20260913-consu-missing-uom-checklist.md。新增 OrderAdjustment 模型 +
-- OrderLine.isGift 字段承接这四类需求，用统一权限点 sales.order.manage_adjustment
-- 控制谁能增删调整行 / 标记赠品行。
--
-- 默认发放对象：与 sales.order.override_price（台账 X1/X2）同一理由——这是
-- 新增能力而非从既有权限拆分，但同样应该给「本来就能改订单内容」的角色，
-- 否则会出现「能加行删行改单价，唯独不能加一笔折扣」这种不自洽的权限面。
-- 按「当前谁有 sales.order.update 就给谁」发放，客户可在权限配置页随时收窄。

UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY['sales.order.manage_adjustment']) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE 'sales.order.update' = ANY("permissions")
  AND 'sales.order.manage_adjustment' <> ALL("permissions");

-- 权限集变了 → 已签发 token 的位图里缺这一位，加调整行会被当成无权限拒绝。
-- 只踢受影响角色下的人。
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE 'sales.order.manage_adjustment' = ANY(r."permissions")
);
