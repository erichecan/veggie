-- ============================================================================
-- Migration: Float → Decimal 金额精度迁移 + Partner 统一模型 + ProductSupplierInfo
-- Date: 2026-04-19
-- ============================================================================
-- 本迁移做四件事：
--   1. 所有金额/税率/数量字段 DOUBLE PRECISION → NUMERIC(x,y)
--   2. Customer 表增加 isCustomer / isVendor / commissionFixed / vendorTaxRate / supplierPaymentTerm
--   3. 新建 ProductSupplierInfo 表（商品-供应商多对多）
--   4. 补齐 40+ 索引（按审计报告的清单）
--
-- 兼容性：
--   - PostgreSQL 自动把 DOUBLE 转 NUMERIC，小数部分按 ROUND 截断
--   - 现有数据最多损失 1 分钱精度，已经是 Float 的精度极限，不会比之前更差
--
-- 回滚：见本文件末尾注释掉的回滚脚本
-- ============================================================================

BEGIN;

-- ─── ProductTemplate ───────────────────────────────────────────────────────
ALTER TABLE "ProductTemplate"
  ALTER COLUMN "listPrice"        TYPE NUMERIC(12, 2) USING ROUND("listPrice"::numeric, 2),
  ALTER COLUMN "standardPrice"    TYPE NUMERIC(12, 2) USING ROUND("standardPrice"::numeric, 2),
  ALTER COLUMN "customerTaxRate"  TYPE NUMERIC(6, 4)  USING ROUND("customerTaxRate"::numeric, 4),
  ALTER COLUMN "weight"           TYPE NUMERIC(10, 3) USING ROUND("weight"::numeric, 3),
  ALTER COLUMN "volume"           TYPE NUMERIC(10, 3) USING ROUND("volume"::numeric, 3),
  ALTER COLUMN "commissionPrice"  TYPE NUMERIC(12, 2) USING ROUND("commissionPrice"::numeric, 2),
  ALTER COLUMN "vendorTaxRate"    TYPE NUMERIC(6, 4)  USING ROUND("vendorTaxRate"::numeric, 4),
  ALTER COLUMN "forecastQty"      TYPE NUMERIC(14, 3) USING ROUND("forecastQty"::numeric, 3);

CREATE INDEX IF NOT EXISTS "ProductTemplate_categoryId_idx" ON "ProductTemplate"("categoryId");
CREATE INDEX IF NOT EXISTS "ProductTemplate_sequence_idx"   ON "ProductTemplate"("sequence");
CREATE INDEX IF NOT EXISTS "ProductTemplate_status_idx"     ON "ProductTemplate"("status");

-- ─── Product ──────────────────────────────────────────────────────────────
ALTER TABLE "Product"
  ALTER COLUMN "listPrice"        TYPE NUMERIC(12, 2) USING ROUND("listPrice"::numeric, 2),
  ALTER COLUMN "standardPrice"    TYPE NUMERIC(12, 2) USING ROUND("standardPrice"::numeric, 2),
  ALTER COLUMN "qtyOnHand"        TYPE NUMERIC(14, 3) USING ROUND("qtyOnHand"::numeric, 3),
  ALTER COLUMN "customerTaxRate"  TYPE NUMERIC(6, 4)  USING ROUND("customerTaxRate"::numeric, 4),
  ALTER COLUMN "commissionPrice"  TYPE NUMERIC(12, 2) USING ROUND("commissionPrice"::numeric, 2),
  ALTER COLUMN "price"            TYPE NUMERIC(12, 2) USING ROUND("price"::numeric, 2),
  ALTER COLUMN "stock"            TYPE NUMERIC(14, 3) USING ROUND("stock"::numeric, 3);

CREATE INDEX IF NOT EXISTS "Product_templateId_idx" ON "Product"("templateId");
CREATE INDEX IF NOT EXISTS "Product_categoryId_idx" ON "Product"("categoryId");
CREATE INDEX IF NOT EXISTS "Product_sequence_idx"   ON "Product"("sequence");

-- ─── Customer + Partner 字段 ──────────────────────────────────────────────
ALTER TABLE "Customer"
  ALTER COLUMN "creditLimit"      TYPE NUMERIC(12, 2) USING ROUND("creditLimit"::numeric, 2),
  ALTER COLUMN "commissionRate"   TYPE NUMERIC(6, 4)  USING ROUND("commissionRate"::numeric, 4),
  ADD COLUMN IF NOT EXISTS "isCustomer"          BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "isVendor"            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "commissionFixed"     NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS "vendorTaxRate"       NUMERIC(6, 4),
  ADD COLUMN IF NOT EXISTS "supplierPaymentTerm" TEXT;

CREATE INDEX IF NOT EXISTS "Customer_isCustomer_idx"  ON "Customer"("isCustomer");
CREATE INDEX IF NOT EXISTS "Customer_isVendor_idx"    ON "Customer"("isVendor");
CREATE INDEX IF NOT EXISTS "Customer_pricelistId_idx" ON "Customer"("pricelistId");

-- ─── CustomerSpecialPrice ─────────────────────────────────────────────────
ALTER TABLE "CustomerSpecialPrice"
  ALTER COLUMN "minQty"     TYPE NUMERIC(14, 3) USING ROUND("minQty"::numeric, 3),
  ALTER COLUMN "fixedPrice" TYPE NUMERIC(12, 2) USING ROUND("fixedPrice"::numeric, 2);

CREATE INDEX IF NOT EXISTS "CustomerSpecialPrice_customerId_idx" ON "CustomerSpecialPrice"("customerId");
CREATE INDEX IF NOT EXISTS "CustomerSpecialPrice_productId_idx"  ON "CustomerSpecialPrice"("productId");

-- ─── Order ────────────────────────────────────────────────────────────────
ALTER TABLE "Order"
  ALTER COLUMN "totalAmount"    TYPE NUMERIC(12, 2) USING ROUND("totalAmount"::numeric, 2),
  ADD COLUMN IF NOT EXISTS "commissionRate" NUMERIC(6, 4);

CREATE INDEX IF NOT EXISTS "Order_restaurantId_idx" ON "Order"("restaurantId");
CREATE INDEX IF NOT EXISTS "Order_status_idx"       ON "Order"("status");
CREATE INDEX IF NOT EXISTS "Order_createdAt_idx"    ON "Order"("createdAt");
CREATE INDEX IF NOT EXISTS "Order_pricelistId_idx"  ON "Order"("pricelistId");

-- ─── Trip ─────────────────────────────────────────────────────────────────
ALTER TABLE "Trip"
  ALTER COLUMN "totalPayment" TYPE NUMERIC(12, 2) USING ROUND("totalPayment"::numeric, 2),
  ADD COLUMN IF NOT EXISTS "driverCommission" NUMERIC(12, 2);

CREATE INDEX IF NOT EXISTS "Trip_driverId_idx" ON "Trip"("driverId");
CREATE INDEX IF NOT EXISTS "Trip_status_idx"   ON "Trip"("status");
CREATE INDEX IF NOT EXISTS "Trip_waveId_idx"   ON "Trip"("waveId");

-- ─── Invoice ──────────────────────────────────────────────────────────────
ALTER TABLE "Invoice"
  ALTER COLUMN "subtotalExTax" TYPE NUMERIC(12, 2) USING ROUND("subtotalExTax"::numeric, 2),
  ALTER COLUMN "totalTax"      TYPE NUMERIC(12, 2) USING ROUND("totalTax"::numeric, 2),
  ALTER COLUMN "totalIncTax"   TYPE NUMERIC(12, 2) USING ROUND("totalIncTax"::numeric, 2),
  ALTER COLUMN "amountPaid"    TYPE NUMERIC(12, 2) USING ROUND("amountPaid"::numeric, 2),
  ALTER COLUMN "amountDue"     TYPE NUMERIC(12, 2) USING ROUND("amountDue"::numeric, 2);

CREATE INDEX IF NOT EXISTS "Invoice_customerId_idx" ON "Invoice"("customerId");
CREATE INDEX IF NOT EXISTS "Invoice_status_idx"     ON "Invoice"("status");
CREATE INDEX IF NOT EXISTS "Invoice_createdAt_idx"  ON "Invoice"("createdAt");
-- 发票号唯一（重名会失败，若有重复需先清理）
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_name_key" ON "Invoice"("name");

-- ─── StockMove ────────────────────────────────────────────────────────────
ALTER TABLE "StockMove"
  ALTER COLUMN "qty" TYPE NUMERIC(14, 3) USING ROUND("qty"::numeric, 3);

CREATE INDEX IF NOT EXISTS "StockMove_productId_idx" ON "StockMove"("productId");
CREATE INDEX IF NOT EXISTS "StockMove_createdAt_idx" ON "StockMove"("createdAt");
CREATE INDEX IF NOT EXISTS "StockMove_type_idx"      ON "StockMove"("type");

-- ─── PurchaseRecord ───────────────────────────────────────────────────────
ALTER TABLE "PurchaseRecord"
  ALTER COLUMN "quantity" TYPE NUMERIC(14, 3) USING ROUND("quantity"::numeric, 3),
  ALTER COLUMN "unitCost" TYPE NUMERIC(12, 4) USING ROUND("unitCost"::numeric, 4),
  ADD COLUMN IF NOT EXISTS "supplierId" TEXT;

CREATE INDEX IF NOT EXISTS "PurchaseRecord_productId_idx"  ON "PurchaseRecord"("productId");
CREATE INDEX IF NOT EXISTS "PurchaseRecord_supplierId_idx" ON "PurchaseRecord"("supplierId");
CREATE INDEX IF NOT EXISTS "PurchaseRecord_createdAt_idx"  ON "PurchaseRecord"("createdAt");

-- ─── PickingWave ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "PickingWave_status_idx"           ON "PickingWave"("status");
CREATE INDEX IF NOT EXISTS "PickingWave_assignedPickerId_idx" ON "PickingWave"("assignedPickerId");
CREATE INDEX IF NOT EXISTS "PickingWave_createdAt_idx"        ON "PickingWave"("createdAt");

-- ─── OdooPricelist ────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "OdooPricelist_externalId_key" ON "OdooPricelist"("externalId");
CREATE INDEX IF NOT EXISTS "OdooPricelist_active_idx"   ON "OdooPricelist"("active");
CREATE INDEX IF NOT EXISTS "OdooPricelist_sequence_idx" ON "OdooPricelist"("sequence");

-- ─── User ─────────────────────────────────────────────────────────────────
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "mfaSecret"   TEXT,
  ADD COLUMN IF NOT EXISTS "mfaEnabled"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "User_role_idx"       ON "User"("role");
CREATE INDEX IF NOT EXISTS "User_customerId_idx" ON "User"("customerId");
CREATE INDEX IF NOT EXISTS "User_isActive_idx"   ON "User"("isActive");

-- ─── ActionLog 字段级 diff + IP/UA ────────────────────────────────────────
ALTER TABLE "ActionLog"
  ADD COLUMN IF NOT EXISTS "changes"   JSONB,
  ADD COLUMN IF NOT EXISTS "ipAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "userAgent" TEXT;

CREATE INDEX IF NOT EXISTS "ActionLog_userId_idx"     ON "ActionLog"("userId");
CREATE INDEX IF NOT EXISTS "ActionLog_resource_idx"   ON "ActionLog"("resource", "resourceId");
CREATE INDEX IF NOT EXISTS "ActionLog_createdAt_idx"  ON "ActionLog"("createdAt");
CREATE INDEX IF NOT EXISTS "ActionLog_action_idx"     ON "ActionLog"("action");

-- ─── 新建表：ProductSupplierInfo ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ProductSupplierInfo" (
  "id"          TEXT PRIMARY KEY,
  "productId"   TEXT NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE,
  "supplierId"  TEXT NOT NULL REFERENCES "Customer"("id") ON DELETE CASCADE,
  "productCode" TEXT,
  "productName" TEXT,
  "price"       NUMERIC(12, 4) NOT NULL,
  "minQty"      NUMERIC(14, 3) NOT NULL DEFAULT 0,
  "delay"       INTEGER NOT NULL DEFAULT 1,
  "sequence"    INTEGER NOT NULL DEFAULT 10,
  "dateStart"   TIMESTAMP(3),
  "dateEnd"     TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ProductSupplierInfo_productId_idx"  ON "ProductSupplierInfo"("productId");
CREATE INDEX IF NOT EXISTS "ProductSupplierInfo_supplierId_idx" ON "ProductSupplierInfo"("supplierId");
CREATE UNIQUE INDEX IF NOT EXISTS "ProductSupplierInfo_productId_supplierId_key"
  ON "ProductSupplierInfo"("productId", "supplierId");

COMMIT;

-- ─── 回滚（仅参考，执行前务必备份） ──────────────────────────────────────
-- BEGIN;
-- DROP TABLE IF EXISTS "ProductSupplierInfo";
-- ALTER TABLE "Customer" DROP COLUMN IF EXISTS "isCustomer",
--                         DROP COLUMN IF EXISTS "isVendor",
--                         DROP COLUMN IF EXISTS "commissionFixed",
--                         DROP COLUMN IF EXISTS "vendorTaxRate",
--                         DROP COLUMN IF EXISTS "supplierPaymentTerm";
-- -- Decimal → Float 反迁移省略（精度已落地，回滚无意义）
-- COMMIT;
