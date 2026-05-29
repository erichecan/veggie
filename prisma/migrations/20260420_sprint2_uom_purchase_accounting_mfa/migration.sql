-- ============================================================================
-- Sprint 2 Migration
-- 2026-04-20
-- ============================================================================
-- 内容：
--   1. UoM + UoMCategory 表（计量单位）+ ProductTemplate.uomId / purchaseUomId
--   2. PurchaseOrder + PurchaseOrderLine + GoodsReceipt + VendorBill（完整采购工作流）
--   3. Account + JournalEntry + JournalEntryLine（会计最小模块）
--   4. 新枚举：UomType, PurchaseOrderStatus, VendorBillStatus, AccountType, JournalEntryStatus
-- ============================================================================

BEGIN;

-- ─── 枚举 ────────────────────────────────────────────────────────────────
CREATE TYPE "UomType" AS ENUM ('REFERENCE', 'SMALLER', 'BIGGER');
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'SENT', 'CONFIRMED', 'RECEIVED', 'INVOICED', 'CANCELLED');
CREATE TYPE "VendorBillStatus" AS ENUM ('DRAFT', 'POSTED', 'PAID', 'CANCELLED');
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE', 'RECEIVABLE', 'PAYABLE');
CREATE TYPE "JournalEntryStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');

-- ─── UomCategory ─────────────────────────────────────────────────────────
CREATE TABLE "UomCategory" (
  "id"        TEXT PRIMARY KEY,
  "name"      TEXT NOT NULL UNIQUE,
  "nameZh"    TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─── Uom ─────────────────────────────────────────────────────────────────
CREATE TABLE "Uom" (
  "id"         TEXT PRIMARY KEY,
  "name"       TEXT NOT NULL,
  "nameZh"     TEXT,
  "categoryId" TEXT NOT NULL REFERENCES "UomCategory"("id") ON DELETE CASCADE,
  "type"       "UomType" NOT NULL DEFAULT 'BIGGER',
  "factor"     NUMERIC(14, 6) NOT NULL DEFAULT 1,
  "rounding"   NUMERIC(14, 6) NOT NULL DEFAULT 0.01,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("categoryId", "name")
);
CREATE INDEX "Uom_categoryId_idx" ON "Uom"("categoryId");
CREATE INDEX "Uom_active_idx"     ON "Uom"("active");

-- ─── ProductTemplate.uomId / purchaseUomId ───────────────────────────────
ALTER TABLE "ProductTemplate"
  ADD COLUMN IF NOT EXISTS "uomId"         TEXT REFERENCES "Uom"("id"),
  ADD COLUMN IF NOT EXISTS "purchaseUomId" TEXT REFERENCES "Uom"("id");

CREATE INDEX IF NOT EXISTS "ProductTemplate_uomId_idx"         ON "ProductTemplate"("uomId");
CREATE INDEX IF NOT EXISTS "ProductTemplate_purchaseUomId_idx" ON "ProductTemplate"("purchaseUomId");

-- ─── PurchaseOrder ───────────────────────────────────────────────────────
CREATE TABLE "PurchaseOrder" (
  "id"           TEXT PRIMARY KEY,
  "name"         TEXT NOT NULL UNIQUE,
  "supplierId"   TEXT NOT NULL,
  "status"       "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "orderDate"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expectedDate" TIMESTAMP(3),
  "currency"     TEXT NOT NULL DEFAULT 'EUR',
  "subtotalExTax" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "totalTax"     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "totalIncTax"  NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "notes"        TEXT,
  "createdBy"    TEXT,
  "confirmedAt"  TIMESTAMP(3),
  "cancelledAt"  TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PurchaseOrder_supplierId_idx" ON "PurchaseOrder"("supplierId");
CREATE INDEX "PurchaseOrder_status_idx"     ON "PurchaseOrder"("status");
CREATE INDEX "PurchaseOrder_orderDate_idx"  ON "PurchaseOrder"("orderDate");

-- ─── PurchaseOrderLine ───────────────────────────────────────────────────
CREATE TABLE "PurchaseOrderLine" (
  "id"              TEXT PRIMARY KEY,
  "purchaseOrderId" TEXT NOT NULL REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE,
  "productId"       TEXT NOT NULL,
  "productName"     TEXT NOT NULL,
  "uomId"           TEXT,
  "orderedQty"      NUMERIC(14, 3) NOT NULL,
  "receivedQty"     NUMERIC(14, 3) NOT NULL DEFAULT 0,
  "invoicedQty"     NUMERIC(14, 3) NOT NULL DEFAULT 0,
  "unitCost"        NUMERIC(12, 4) NOT NULL,
  "taxRate"         NUMERIC(6, 4)  NOT NULL DEFAULT 0,
  "subtotalExTax"   NUMERIC(12, 2) NOT NULL,
  "taxAmount"       NUMERIC(12, 2) NOT NULL,
  "subtotalIncTax"  NUMERIC(12, 2) NOT NULL,
  "sequence"        INTEGER NOT NULL DEFAULT 10,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PurchaseOrderLine_purchaseOrderId_idx" ON "PurchaseOrderLine"("purchaseOrderId");
CREATE INDEX "PurchaseOrderLine_productId_idx"       ON "PurchaseOrderLine"("productId");

-- ─── GoodsReceipt ────────────────────────────────────────────────────────
CREATE TABLE "GoodsReceipt" (
  "id"              TEXT PRIMARY KEY,
  "name"            TEXT NOT NULL UNIQUE,
  "purchaseOrderId" TEXT NOT NULL REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE,
  "arrivedAt"       TIMESTAMP(3) NOT NULL,
  "receivedBy"      TEXT,
  "lines"           JSONB NOT NULL DEFAULT '[]',
  "notes"           TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "GoodsReceipt_purchaseOrderId_idx" ON "GoodsReceipt"("purchaseOrderId");
CREATE INDEX "GoodsReceipt_arrivedAt_idx"       ON "GoodsReceipt"("arrivedAt");

-- ─── VendorBill ──────────────────────────────────────────────────────────
CREATE TABLE "VendorBill" (
  "id"              TEXT PRIMARY KEY,
  "name"            TEXT NOT NULL UNIQUE,
  "purchaseOrderId" TEXT REFERENCES "PurchaseOrder"("id"),
  "supplierId"      TEXT NOT NULL,
  "billDate"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dueDate"         TIMESTAMP(3),
  "lines"           JSONB NOT NULL DEFAULT '[]',
  "subtotalExTax"   NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "totalTax"        NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "totalIncTax"     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "amountPaid"      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "amountDue"       NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "status"          "VendorBillStatus" NOT NULL DEFAULT 'DRAFT',
  "notes"           TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "postedAt"        TIMESTAMP(3),
  "paidAt"          TIMESTAMP(3)
);
CREATE INDEX "VendorBill_supplierId_idx"      ON "VendorBill"("supplierId");
CREATE INDEX "VendorBill_purchaseOrderId_idx" ON "VendorBill"("purchaseOrderId");
CREATE INDEX "VendorBill_status_idx"          ON "VendorBill"("status");
CREATE INDEX "VendorBill_billDate_idx"        ON "VendorBill"("billDate");

-- ─── Account（会计科目） ────────────────────────────────────────────────
CREATE TABLE "Account" (
  "id"          TEXT PRIMARY KEY,
  "code"        TEXT NOT NULL UNIQUE,
  "name"        TEXT NOT NULL,
  "nameZh"      TEXT,
  "type"        "AccountType" NOT NULL,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "allowManual" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Account_type_idx"   ON "Account"("type");
CREATE INDEX "Account_active_idx" ON "Account"("active");

-- ─── JournalEntry（日记账凭证） ────────────────────────────────────────
CREATE TABLE "JournalEntry" (
  "id"          TEXT PRIMARY KEY,
  "name"        TEXT NOT NULL UNIQUE,
  "date"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "narration"   TEXT NOT NULL,
  "sourceType"  TEXT,
  "sourceId"    TEXT,
  "status"      "JournalEntryStatus" NOT NULL DEFAULT 'DRAFT',
  "totalDebit"  NUMERIC(14, 2) NOT NULL DEFAULT 0,
  "totalCredit" NUMERIC(14, 2) NOT NULL DEFAULT 0,
  "createdBy"   TEXT,
  "postedAt"    TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "JournalEntry_date_idx"                    ON "JournalEntry"("date");
CREATE INDEX "JournalEntry_sourceType_sourceId_idx"     ON "JournalEntry"("sourceType", "sourceId");
CREATE INDEX "JournalEntry_status_idx"                  ON "JournalEntry"("status");

-- ─── JournalEntryLine ───────────────────────────────────────────────────
CREATE TABLE "JournalEntryLine" (
  "id"          TEXT PRIMARY KEY,
  "entryId"     TEXT NOT NULL REFERENCES "JournalEntry"("id") ON DELETE CASCADE,
  "accountId"   TEXT NOT NULL REFERENCES "Account"("id"),
  "description" TEXT,
  "debit"       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  "credit"      NUMERIC(14, 2) NOT NULL DEFAULT 0,
  "partnerId"   TEXT,
  "sequence"    INTEGER NOT NULL DEFAULT 10
);
CREATE INDEX "JournalEntryLine_entryId_idx"   ON "JournalEntryLine"("entryId");
CREATE INDEX "JournalEntryLine_accountId_idx" ON "JournalEntryLine"("accountId");
CREATE INDEX "JournalEntryLine_partnerId_idx" ON "JournalEntryLine"("partnerId");

COMMIT;
