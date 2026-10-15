-- 20261014 复式改造 L3/L5：库位 + 复式库存流水 + 期初（docs/20261014-double-entry-ledger-plan.md）
-- ============================================================================
-- 1. StockLocation 表与 6 个固定库位（id 与 lib/stock-locations.ts 一致）
-- 2. StockMove 加 from/to 库位、订单行/采购行、业务单位数量、单位成本/金额、客户/供应商、经手人
-- 3. 历史流水按 type / sourceType / qty 符号回填 from/to（只写新列，qty 一个不改）
-- 4. 期初（客户 20261014 确认：历史库存不补流水，以迁移这一刻的数为准）：
--    批次余量 ≠ Σ该批次流水、在手量 ≠ Σ流水 的差额，各补一笔「期初」流水对平，
--    从此「Lot.currentQty = Σ批次流水」「qtyOnHand = Σ流水」对每个商品严格成立。
-- 5. 存货期初凭证：Dr 1300 存货 / Cr 3000 未分配利润 = Σ 在手量(>0) × 平均成本（永续盘存起点）
-- Product.qtyOnHand / Lot.currentQty 一个都不改。

-- AlterTable
ALTER TABLE "StockMove" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "fromLocationId" TEXT,
ADD COLUMN     "orderLineId" TEXT,
ADD COLUMN     "partnerId" TEXT,
ADD COLUMN     "purchaseOrderLineId" TEXT,
ADD COLUMN     "toLocationId" TEXT,
ADD COLUMN     "unitCost" DECIMAL(12,4),
ADD COLUMN     "uomId" TEXT,
ADD COLUMN     "uomQty" DECIMAL(14,3),
ADD COLUMN     "value" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "StockLocation" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameZh" TEXT,
    "usage" TEXT NOT NULL,
    "parentId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_code_key" ON "StockLocation"("code");

-- CreateIndex
CREATE INDEX "StockMove_fromLocationId_idx" ON "StockMove"("fromLocationId");

-- CreateIndex
CREATE INDEX "StockMove_toLocationId_idx" ON "StockMove"("toLocationId");

-- CreateIndex
CREATE INDEX "StockMove_purchaseOrderLineId_idx" ON "StockMove"("purchaseOrderLineId");

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- 1. 固定库位
INSERT INTO "StockLocation" ("id", "code", "name", "nameZh", "usage") VALUES
  ('loc_wh_stock',          'WH/Stock',                     'WH/Stock',                     '仓库/库存', 'INTERNAL'),
  ('loc_partner_vendors',   'Partners/Vendors',             'Partners/Vendors',             '供应商',    'SUPPLIER'),
  ('loc_partner_customers', 'Partners/Customers',           'Partners/Customers',           '客户',      'CUSTOMER'),
  ('loc_virtual_inventory', 'Virtual/Inventory adjustment', 'Virtual/Inventory adjustment', '盘点调整',  'INVENTORY'),
  ('loc_virtual_scrap',     'Virtual/Scrap',                'Virtual/Scrap',                '报废',      'SCRAP'),
  ('loc_virtual_opening',   'Virtual/Opening balance',      'Virtual/Opening balance',      '期初',      'OPENING')
ON CONFLICT ("id") DO NOTHING;

-- 3. 历史流水回填 from/to：qty > 0 进仓（对方 → WH/Stock），qty ≤ 0 出仓（WH/Stock → 对方）
UPDATE "StockMove" SET
  "fromLocationId" = CASE
    WHEN qty > 0 THEN CASE
      WHEN "sourceType" IN ('PURCHASE_RECEIVE', 'GOODS_RECEIPT', 'PO', 'PURCHASE') THEN 'loc_partner_vendors'
      WHEN "sourceType" IN ('ORDER', 'SO') OR type = 'RETURN' OR "sourceType" = 'RETURN' THEN 'loc_partner_customers'
      WHEN "sourceType" IN ('ODOO_IMPORT', 'IMPORT', 'TEST_OPENING', 'OPENING') THEN 'loc_virtual_opening'
      WHEN type = 'SCRAP' THEN 'loc_virtual_scrap'
      ELSE 'loc_virtual_inventory' END
    ELSE 'loc_wh_stock' END,
  "toLocationId" = CASE
    WHEN qty > 0 THEN 'loc_wh_stock'
    ELSE CASE
      WHEN type = 'SCRAP' OR "sourceType" IN ('SCRAP', 'RETURN_SCRAP') THEN 'loc_virtual_scrap'
      WHEN "sourceType" IN ('ORDER', 'SO') THEN 'loc_partner_customers'
      WHEN "sourceType" = 'PURCHASE_RETURN' THEN 'loc_partner_vendors'
      WHEN "sourceType" IN ('ODOO_IMPORT', 'IMPORT', 'TEST_OPENING', 'OPENING') THEN 'loc_virtual_opening'
      ELSE 'loc_virtual_inventory' END
    END
WHERE "fromLocationId" IS NULL OR "toLocationId" IS NULL;

-- 4a. 批次期初：Lot.currentQty − Σ该批次流水
INSERT INTO "StockMove" (id, "productId", "productName", type, qty, note, "sourceType", "sourceRef", "lotId",
                         "movedAt", "createdAt", "fromLocationId", "toLocationId", "unitCost", "value", "createdBy")
SELECT 'smo' || replace(gen_random_uuid()::text, '-', ''), l."productId", COALESCE(p.name, ''), 'ADJUSTMENT',
       l."currentQty" - COALESCE(m.s, 0),
       '期初：复式改造前批次余量与流水的差额（' || l."lotNumber" || '）', 'OPENING', 'OPENING-20261014', l.id,
       NOW(), NOW(),
       CASE WHEN l."currentQty" - COALESCE(m.s, 0) > 0 THEN 'loc_virtual_opening' ELSE 'loc_wh_stock' END,
       CASE WHEN l."currentQty" - COALESCE(m.s, 0) > 0 THEN 'loc_wh_stock' ELSE 'loc_virtual_opening' END,
       COALESCE(l."unitCost", p."standardPrice"),
       ROUND(ABS(l."currentQty" - COALESCE(m.s, 0)) * COALESCE(l."unitCost", p."standardPrice", 0), 2),
       'System'
FROM "Lot" l
JOIN "Product" p ON p.id = l."productId"
LEFT JOIN (SELECT "lotId", SUM(qty) s FROM "StockMove" WHERE "lotId" IS NOT NULL GROUP BY "lotId") m ON m."lotId" = l.id
WHERE ABS(l."currentQty" - COALESCE(m.s, 0)) > 0.0005;

-- 4b. 商品期初：qtyOnHand − Σ流水（已含 4a）
INSERT INTO "StockMove" (id, "productId", "productName", type, qty, note, "sourceType", "sourceRef",
                         "movedAt", "createdAt", "fromLocationId", "toLocationId", "unitCost", "value", "createdBy")
SELECT 'smo' || replace(gen_random_uuid()::text, '-', ''), p.id, p.name, 'ADJUSTMENT',
       p."qtyOnHand" - COALESCE(m.s, 0),
       '期初：复式改造前在手量与流水的差额（历史库存不补流水，以迁移时的在手量为准）', 'OPENING', 'OPENING-20261014',
       NOW(), NOW(),
       CASE WHEN p."qtyOnHand" - COALESCE(m.s, 0) > 0 THEN 'loc_virtual_opening' ELSE 'loc_wh_stock' END,
       CASE WHEN p."qtyOnHand" - COALESCE(m.s, 0) > 0 THEN 'loc_wh_stock' ELSE 'loc_virtual_opening' END,
       p."standardPrice",
       ROUND(ABS(p."qtyOnHand" - COALESCE(m.s, 0)) * COALESCE(p."standardPrice", 0), 2),
       'System'
FROM "Product" p
LEFT JOIN (SELECT "productId", SUM(qty) s FROM "StockMove" GROUP BY "productId") m ON m."productId" = p.id
WHERE ABS(p."qtyOnHand" - COALESCE(m.s, 0)) > 0.0005;

-- 5. 存货期初凭证（永续盘存起点）：只算实物商品的正库存
DO $$
DECLARE
  v_total NUMERIC;
  v_inv TEXT;
  v_re TEXT;
  v_name TEXT;
  v_entry TEXT := 'je' || replace(gen_random_uuid()::text, '-', '');
BEGIN
  IF EXISTS (SELECT 1 FROM "JournalEntry" WHERE "sourceType" = 'stock_opening') THEN RETURN; END IF;
  SELECT ROUND(COALESCE(SUM(GREATEST(p."qtyOnHand", 0) * COALESCE(p."standardPrice", 0)), 0), 2) INTO v_total
    FROM "Product" p WHERE p.type = 'PRODUCT';
  SELECT id INTO v_inv FROM "Account" WHERE code = '1300';
  SELECT id INTO v_re FROM "Account" WHERE code = '3000';
  IF v_total IS NULL OR v_total <= 0 OR v_inv IS NULL OR v_re IS NULL THEN RETURN; END IF;
  SELECT 'JE-' || lpad((COALESCE(MAX(NULLIF(regexp_replace(name, '^JE-', ''), '')::INT), 0) + 1)::text, 5, '0') INTO v_name
    FROM "JournalEntry" WHERE name ~ '^JE-[0-9]+$';
  INSERT INTO "JournalEntry" (id, name, date, narration, "sourceType", "sourceId", status, "totalDebit", "totalCredit", "createdBy", "postedAt", "createdAt")
  VALUES (v_entry, v_name, NOW(), 'Opening inventory valuation (perpetual inventory starts 2026-10-14)', 'stock_opening', 'OPENING-20261014',
          'POSTED', v_total, v_total, 'system', NOW(), NOW());
  INSERT INTO "JournalEntryLine" (id, "entryId", "accountId", description, debit, credit, sequence) VALUES
    ('jl' || replace(gen_random_uuid()::text, '-', ''), v_entry, v_inv, 'Opening inventory', v_total, 0, 10),
    ('jl' || replace(gen_random_uuid()::text, '-', ''), v_entry, v_re, 'Opening inventory', 0, v_total, 20);
END $$;

-- 留痕
INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
SELECT 'al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'UPDATE', 'stock-move', 'bulk',
       '复式改造 L3：回填 ' || (SELECT COUNT(*) FROM "StockMove" WHERE "sourceType" IS DISTINCT FROM 'OPENING') || ' 条历史流水的库位；补期初流水 '
       || (SELECT COUNT(*) FROM "StockMove" WHERE "sourceType" = 'OPENING') || ' 条（在手量与批次余量均未改动）', NOW();
