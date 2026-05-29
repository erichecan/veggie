-- Adds Order.salesman to align with the application code that has been
-- writing this field since Sprint 3 but never had a migration generated.
-- Without this column, POST /api/orders fails with PrismaClientValidationError
-- → HTTP 500.

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "salesman" TEXT;
