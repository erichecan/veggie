-- 补一个漏掉的权限点（2026-09-22 当天第二次修正）：
--
-- 上一条迁移（20260923001437）把 POST /api/trips/:id/returns 的司机端提交
-- 切到了走专用接口（此前司机端是绕开这条接口、直接改 Trip.restaurants[].returns
-- 再整份 PUT，没有 unitPrice 快照，见 DEV-PLAN.md），但没注意到 DRIVER 角色
-- 根本没有 dispatch.trip.returns 权限——那条权限只挂给了 boss/operator/sales，
-- 直接切过去会让所有司机 403。
--
-- 拆一个新权限点 dispatch.trip.report_return，只管"上报"（POST），不给"审核"
-- （PUT 仍然只认 dispatch.trip.returns）——司机不能自己批准/拒绝自己报的退货。
-- 已有 dispatch.trip.returns 的角色（boss/operator/sales）不受影响，POST 规则
-- 按「任一权限即可」放行，不需要再单独给他们发这个新点。

INSERT INTO "Permission" ("id","module","action","labelZh","labelEn","sortKey") VALUES
  ('dispatch.trip.report_return','dispatch.trip','report_return','上报退换货','Report Return',190)
ON CONFLICT ("id") DO UPDATE SET
  "module"=EXCLUDED."module","action"=EXCLUDED."action",
  "labelZh"=EXCLUDED."labelZh","labelEn"=EXCLUDED."labelEn","sortKey"=EXCLUDED."sortKey";

UPDATE "AppRole"
SET "permissions" = array_cat(
      "permissions",
      ARRAY(
        SELECT p FROM unnest(ARRAY['dispatch.trip.report_return']) AS p
        WHERE p <> ALL("permissions")
      )
    ),
    "updatedAt" = NOW()
WHERE "code" = 'driver'
  AND 'dispatch.trip.report_return' <> ALL("permissions");

UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT l."userId" FROM "UserRoleLink" l
  JOIN "AppRole" r ON r."id" = l."roleId"
  WHERE r."code" = 'driver'
);
