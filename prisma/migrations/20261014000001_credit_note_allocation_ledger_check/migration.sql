-- 20261014 复式改造 L1/L2（docs/20261014-double-entry-ledger-plan.md）
-- ============================================================================
-- 1. Invoice.amountCredited：贷记单抵扣金额（缓存，真相是 CreditNoteAllocation）
-- 2. CreditNoteAllocation：贷记单抵扣发票 / 退款的明细（只追加，撤销 = 负数冲正行）
-- 3. LedgerCheckRun：每日账本核对的结果
-- 5. 发票期初：见文件末尾。
-- 4. 标准会计科目补齐：总账只认科目代码，缺科目时自动凭证会被静默跳过。
--    以前只有 prisma/seed.ts 会建科目，生产库是否齐全没人保证；这里幂等补齐（已存在不动）。
-- 只加表加列；唯一的数据写入是第 5 步给发票补「期初」两个新列，不改任何已有列的值。

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "amountCredited" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "openingCredited" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "openingPaid" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CreditNoteAllocation" (
    "id" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'INVOICE',
    "invoiceId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" TEXT,
    "reversalOfId" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNoteAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerCheckRun" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'AUTO',
    "ok" BOOLEAN NOT NULL,
    "results" JSONB NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerCheckRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteAllocation_reversalOfId_key" ON "CreditNoteAllocation"("reversalOfId");

-- CreateIndex
CREATE INDEX "CreditNoteAllocation_creditNoteId_idx" ON "CreditNoteAllocation"("creditNoteId");

-- CreateIndex
CREATE INDEX "CreditNoteAllocation_invoiceId_idx" ON "CreditNoteAllocation"("invoiceId");

-- CreateIndex
CREATE INDEX "LedgerCheckRun_createdAt_idx" ON "LedgerCheckRun"("createdAt");

-- AddForeignKey
ALTER TABLE "CreditNoteAllocation" ADD CONSTRAINT "CreditNoteAllocation_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteAllocation" ADD CONSTRAINT "CreditNoteAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 标准科目（与 lib/accounting.ts STANDARD_ACCOUNTS 一致）
INSERT INTO "Account" ("id", "code", "name", "nameZh", "type", "active", "allowManual", "createdAt") VALUES
  (gen_random_uuid()::TEXT, '1100', 'Accounts Receivable',  '应收账款',   'RECEIVABLE', true, false, NOW()),
  (gen_random_uuid()::TEXT, '1110', 'VAT Receivable',       'VAT 进项',   'ASSET',      true, false, NOW()),
  (gen_random_uuid()::TEXT, '1200', 'Bank',                 '银行',       'ASSET',      true, true,  NOW()),
  (gen_random_uuid()::TEXT, '2100', 'Accounts Payable',     '应付账款',   'PAYABLE',    true, false, NOW()),
  (gen_random_uuid()::TEXT, '2200', 'VAT Payable',          'VAT 销项',   'LIABILITY',  true, false, NOW()),
  (gen_random_uuid()::TEXT, '2300', 'Customer Prepayments', '客户预收款', 'LIABILITY',  true, false, NOW()),
  (gen_random_uuid()::TEXT, '3000', 'Retained Earnings',    '未分配利润', 'EQUITY',     true, false, NOW()),
  (gen_random_uuid()::TEXT, '4000', 'Sales Revenue',        '销售收入',   'INCOME',     true, false, NOW()),
  (gen_random_uuid()::TEXT, '5000', 'Purchases / COGS',     '采购成本',   'EXPENSE',    true, false, NOW()),
  (gen_random_uuid()::TEXT, '6000', 'Operating Expenses',   '运营费用',   'EXPENSE',    true, true,  NOW()),
  -- 永续盘存（复式改造 L5，客户 20261014 确认库存金额进总账）
  (gen_random_uuid()::TEXT, '1300', 'Inventory',                   '存货',         'ASSET',     true, false, NOW()),
  (gen_random_uuid()::TEXT, '2150', 'Goods Received Not Invoiced', '已收货未开票', 'LIABILITY', true, false, NOW()),
  (gen_random_uuid()::TEXT, '5100', 'Cost of Goods Sold',          '销售成本',     'EXPENSE',   true, false, NOW()),
  (gen_random_uuid()::TEXT, '5200', 'Inventory Loss',              '存货损耗',     'EXPENSE',   true, false, NOW())
ON CONFLICT ("code") DO NOTHING;

-- 5. 发票期初已收 / 期初已冲减（新列，原有列一个不改）
-- ----------------------------------------------------------------------------
-- 从此发票余额由明细重算：amountPaid = openingPaid + Σ Payment，
-- amountCredited = openingCredited + Σ CreditNoteAllocation，amountDue = 总额 − 两者。
-- Odoo 导入的历史发票有已收金额却没有 Payment 行（Odoo 里用退款单冲掉的部分也一样），
-- 不把这部分记成期初，第一次重算就会把它们打回「未付」。这里按迁移这一刻的值算出期初，
-- 使「期初 + 明细」恰好等于现有的 amountPaid / amountDue —— 重算前后数字不变。
WITH pay AS (
  SELECT "invoiceId", SUM(amount) AS s FROM "Payment" WHERE "invoiceId" IS NOT NULL GROUP BY "invoiceId"
), calc AS (
  SELECT i.id,
         GREATEST(0, i."amountPaid" - COALESCE(pay.s, 0)) AS op,
         COALESCE(pay.s, 0) AS paid_rows
  FROM "Invoice" i LEFT JOIN pay ON pay."invoiceId" = i.id
)
UPDATE "Invoice" i
SET "openingPaid" = calc.op,
    "openingCredited" = CASE WHEN i.status IN ('POSTED', 'PAID')
      THEN GREATEST(0, i."totalIncTax" - i."amountDue" - (calc.op + calc.paid_rows))
      ELSE 0 END
FROM calc
WHERE calc.id = i.id
  AND (calc.op > 0.005 OR (i.status IN ('POSTED', 'PAID') AND i."totalIncTax" - i."amountDue" - (calc.op + calc.paid_rows) > 0.005));

-- 留痕：补了多少张、合计多少
INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
SELECT 'al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'UPDATE', 'invoice', 'bulk',
       '复式改造 L1：为 ' || COUNT(*) || ' 张历史发票记录期初已收 €' || COALESCE(SUM("openingPaid"), 0)
       || '、期初已冲减 €' || COALESCE(SUM("openingCredited"), 0) || '（只写新列，原有金额不变）', NOW()
FROM "Invoice" WHERE "openingPaid" > 0 OR "openingCredited" > 0;
