-- Keep purchase-line descriptions, product specs, and UOM labels as purchase-time snapshots.
ALTER TABLE "PurchaseOrderLine"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "productSpec" TEXT,
  ADD COLUMN "uomName" TEXT;
