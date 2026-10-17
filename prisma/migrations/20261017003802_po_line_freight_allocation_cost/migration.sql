-- 采购运费分摊成本联动（20261017 客户需求）：确认采购时按行分摊运费并写入落地成本，
-- 取消时用快照回滚 Product.standardPrice。
ALTER TABLE "PurchaseOrderLine"
  ADD COLUMN "allocatedFreightEur" DECIMAL(12,2),
  ADD COLUMN "landedUnitCostEur" DECIMAL(12,4),
  ADD COLUMN "standardPriceBeforeConfirmEur" DECIMAL(12,4);
