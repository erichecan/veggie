-- Adds User.roles for multi-role accounts (e.g. OPERATOR + SALES).
-- The legacy single role column stays as the fallback / primary role;
-- runtime auth checks BOTH role and roles[].

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill: every existing row gets [role] so withAuth keeps working.
UPDATE "User"
SET "roles" = ARRAY[role::text]
WHERE cardinality("roles") = 0;
