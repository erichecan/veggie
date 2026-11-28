-- Keep the standalone delivery-signature endpoint limited to driver accounts.
INSERT INTO "Permission" ("id", "module", "action", "labelZh", "labelEn", "sortKey")
VALUES ('dispatch.trip.sign_delivery', 'dispatch.trip', 'sign_delivery', '客户签收', 'Save Delivery Signature', 198)
ON CONFLICT ("id") DO UPDATE SET
  "module" = EXCLUDED."module",
  "action" = EXCLUDED."action",
  "labelZh" = EXCLUDED."labelZh",
  "labelEn" = EXCLUDED."labelEn",
  "sortKey" = EXCLUDED."sortKey";

UPDATE "AppRole"
SET "permissions" = array_append("permissions", 'dispatch.trip.sign_delivery'),
    "updatedAt" = NOW()
WHERE "code" = 'driver'
  AND 'dispatch.trip.sign_delivery' <> ALL("permissions");

-- Invalidate existing driver tokens so the new permission bitmap is issued on login.
UPDATE "User"
SET "permVersion" = "permVersion" + 1
WHERE "id" IN (
  SELECT link."userId"
  FROM "UserRoleLink" link
  JOIN "AppRole" role ON role."id" = link."roleId"
  WHERE role."code" = 'driver'
);
