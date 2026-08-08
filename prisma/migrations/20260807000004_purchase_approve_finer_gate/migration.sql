-- 采购审批/收货拆成独立权限点后，把它们补给「改造前就能审批的角色」
--
-- 背景：`PATCH /api/purchase-orders/[id]` 一个端点承载 send / confirm / approve /
-- receive 等全部动作，route-map 只认 URL + method，整体映射到 purchase.order.update。
-- 客户的岗位划分要求「办公室销售能录采购单、不能审批」，所以 20260807 在 handler
-- 里加了更细的判定（FINER_GATE）。
--
-- ⛔ 拆细之后如果不补这两个点，原本靠 update 就能审批的 BOSS / OPERATOR 会**审批不了**
--    —— 那是一次静默的功能中断，不是权限收紧。本迁移保持改造前的可达性不变。
--
-- 只补给已经有 purchase.order.update 的角色，而不是无差别发放：没有 update 的角色
-- 连这个端点都进不来，给了也是一个够不着的权限点。
--
-- ⛔ 而且**只补给预置角色**（isSystem = true）。上一条迁移刚建的 7 个业务角色模板
--    也有 purchase.order.update —— 其中「办公室销售」的定义正是「能录不能批」。
--    少了 isSystem 这个条件，这条迁移会把它刚拆出来的分界线又抹平。
--    （实测过：不加条件时 office_sales 从 43 个权限点变成 45 个，多出来的正是
--     approve 与 receive。）「保持改造前的可达性」这件事只跟平迁进来的 12 个
--    legacy 角色有关，与新建的模板无关。

UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY['purchase.order.approve','purchase.order.receive']) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE "isSystem" = true
  AND 'purchase.order.update' = ANY("permissions");

-- 权限集变了 → 已签发 token 里的位图缺这两位，审批会被 handler 挡下。
-- 只踢受影响角色下的人，不是全员。
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE 'purchase.order.approve' = ANY(r."permissions")
);
