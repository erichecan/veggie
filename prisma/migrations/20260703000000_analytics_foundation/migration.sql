-- 数据分析中心地基：Lot 成本 + 盘点单 + 每日经营快照
-- （实际通过 prisma db push 应用，此文件为迁移历史记录，migrate resolve --applied 标记）

-- Lot 批次成本（参考单位下，收货时从 PO 行 unitCost 写入）
ALTER TABLE "Lot" ADD COLUMN "unitCost" DECIMAL(12,4);

-- 盘点单状态
CREATE TYPE "StockTakeStatus" AS ENUM ('DRAFT', 'DONE', 'CANCELLED');

-- 盘点单
CREATE TABLE "StockTake" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "StockTakeStatus" NOT NULL DEFAULT 'DRAFT',
    "takenAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockTake_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockTake_name_key" ON "StockTake"("name");
CREATE INDEX "StockTake_status_idx" ON "StockTake"("status");
CREATE INDEX "StockTake_takenAt_idx" ON "StockTake"("takenAt");

-- 盘点行
CREATE TABLE "StockTakeLine" (
    "id" TEXT NOT NULL,
    "stockTakeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "systemQty" DECIMAL(14,3) NOT NULL,
    "countedQty" DECIMAL(14,3),
    "diffQty" DECIMAL(14,3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockTakeLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StockTakeLine_stockTakeId_idx" ON "StockTakeLine"("stockTakeId");
CREATE INDEX "StockTakeLine_productId_idx" ON "StockTakeLine"("productId");

ALTER TABLE "StockTakeLine" ADD CONSTRAINT "StockTakeLine_stockTakeId_fkey"
    FOREIGN KEY ("stockTakeId") REFERENCES "StockTake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 每日经营快照
CREATE TABLE "DailyBusinessSnapshot" (
    "id" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "salesExTax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "salesIncTax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grossProfit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "costCoverageRate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "activeCustomers" INTEGER NOT NULL DEFAULT 0,
    "shortageLines" INTEGER NOT NULL DEFAULT 0,
    "orderLines" INTEGER NOT NULL DEFAULT 0,
    "creditNoteAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "scrapAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "purchaseExTax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "arBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "arOverdue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyBusinessSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyBusinessSnapshot_snapshotDate_key" ON "DailyBusinessSnapshot"("snapshotDate");
CREATE INDEX "DailyBusinessSnapshot_snapshotDate_idx" ON "DailyBusinessSnapshot"("snapshotDate");
