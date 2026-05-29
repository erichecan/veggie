-- Add orderReturn and deliveryBatch to Order
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "orderReturn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "deliveryBatch" TEXT;
