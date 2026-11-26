ALTER TABLE "OrderReturn" ADD COLUMN "preservedOriginalOrder" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StockMove" ADD COLUMN "physicalQty" DECIMAL(14,3);

INSERT INTO "StockLocation" (id, code, name, "nameZh", usage, "parentId")
VALUES ('loc_wh_return_quarantine', 'WH/Return Quarantine', 'Return Quarantine', '退货待检仓', 'INTERNAL', 'loc_wh_stock');
