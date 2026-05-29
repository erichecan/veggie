-- 业务订单编号 + 创建者
-- code: 创建者缩写-YYMMDD-NNN（例：CJ-260424-001），唯一，新订单填充，历史订单保持 NULL
-- createdById: 创建者用户 ID（FK -> User.id），可空（历史订单为空）
-- createdByName: 创建时的姓名快照，避免日后改名影响显示

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "code" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "createdById" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "createdByName" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Order_code_key" ON "Order"("code");
CREATE INDEX IF NOT EXISTS "Order_createdById_idx" ON "Order"("createdById");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Order_createdById_fkey'
  ) THEN
    ALTER TABLE "Order"
      ADD CONSTRAINT "Order_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
