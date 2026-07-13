-- 采购模块汇率折算：PurchaseOrder/PurchaseOrderLine 新增欧元折算字段，VendorBill 补币种/汇率快照
ALTER TABLE "PurchaseOrder" ADD COLUMN "exchangeRatePending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PurchaseOrder" ADD COLUMN "subtotalExTaxEur" DECIMAL(12,2);
ALTER TABLE "PurchaseOrder" ADD COLUMN "totalTaxEur" DECIMAL(12,2);
ALTER TABLE "PurchaseOrder" ADD COLUMN "totalIncTaxEur" DECIMAL(12,2);
ALTER TABLE "PurchaseOrder" ADD COLUMN "freightAmountEur" DECIMAL(14,2);

ALTER TABLE "PurchaseOrderLine" ADD COLUMN "unitCostEur" DECIMAL(12,4);
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "subtotalExTaxEur" DECIMAL(12,2);
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "taxAmountEur" DECIMAL(12,2);
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "subtotalIncTaxEur" DECIMAL(12,2);

ALTER TABLE "VendorBill" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'EUR';
ALTER TABLE "VendorBill" ADD COLUMN "exchangeRate" DECIMAL(14,6) DEFAULT 1;
