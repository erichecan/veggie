-- PurchaseOrder：运费录入 + 汇率快照 + 供应商 PDF 原件，支撑采购单新建页整合
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "exchangeRate" DECIMAL(14,6) DEFAULT 1;
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "freightAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "sourceDocumentUrl" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "sourceDocumentName" TEXT;
