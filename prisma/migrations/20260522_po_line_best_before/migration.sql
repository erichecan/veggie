-- Add bestBefore (best-before date) to PurchaseOrderLine
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "bestBefore" TIMESTAMP(3);
