ALTER TABLE "Order" ADD COLUMN "legacyCode" TEXT;
ALTER TABLE "Statement" ADD COLUMN "totalCredits" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Statement" ADD COLUMN "creditNoteIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Statement" ADD COLUMN "invoiceSnapshot" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Retain every previously visible order reference as a search alias, then
-- assign a single D-YYMMDD-NNN sequence per Dublin business date.
UPDATE "Order" SET "legacyCode" = "code" WHERE "code" IS NOT NULL AND "legacyCode" IS NULL;
UPDATE "Order" SET "code" = NULL;

WITH numbered AS (
  SELECT id,
         to_char(("createdAt" AT TIME ZONE 'Europe/Dublin'), 'YYMMDD') AS day_code,
         row_number() OVER (
           PARTITION BY to_char(("createdAt" AT TIME ZONE 'Europe/Dublin'), 'YYMMDD')
           ORDER BY "createdAt", id
         ) AS seq
  FROM "Order"
)
UPDATE "Order" o
SET "code" = 'D-' || n.day_code || '-' || lpad(n.seq::text, 3, '0')
FROM numbered n
WHERE o.id = n.id;
