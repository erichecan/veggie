-- Order/Customer.salesman (free text) -> salesUserId (FK to User)
-- Historical data backfilled manually against production (Odoo import names matched to
-- User.name, with 2 manual exceptions: "Administrator" -> Minshou Jiang, "Xuan Li" -> new
-- placeholder SALES user). The old "salesman" text column is dropped in a follow-up migration
-- once all read/write code paths have moved to salesUserId.

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "salesUserId" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "salesUserId" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_salesUserId_fkey') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_salesUserId_fkey"
      FOREIGN KEY ("salesUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_salesUserId_fkey') THEN
    ALTER TABLE "Customer" ADD CONSTRAINT "Customer_salesUserId_fkey"
      FOREIGN KEY ("salesUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Order_salesUserId_idx" ON "Order"("salesUserId");
CREATE INDEX IF NOT EXISTS "Customer_salesUserId_idx" ON "Customer"("salesUserId");
