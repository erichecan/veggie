-- Drop the old free-text salesman columns now that all read/write paths use
-- Order.salesUserId / Customer.salesUserId (FK to User). Historical text values were
-- backfilled into salesUserId first (see 20260702000000_order_customer_sales_user_id);
-- 100% of non-null rows matched (810 orders, 409 customers) before this drop ran.

ALTER TABLE "Order" DROP COLUMN IF EXISTS "salesman";
ALTER TABLE "Customer" DROP COLUMN IF EXISTS "salesman";
