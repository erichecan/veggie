-- Odoo-style journals for incoming customer payments.
CREATE TYPE "PaymentJournalType" AS ENUM ('BANK', 'CASH', 'CREDIT_CARD');

CREATE TABLE "PaymentJournal" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PaymentJournalType" NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "accountId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 10,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentJournal_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Payment" ADD COLUMN "paymentJournalId" TEXT;
ALTER TABLE "JournalEntry" ADD COLUMN "paymentJournalId" TEXT;

CREATE UNIQUE INDEX "PaymentJournal_code_key" ON "PaymentJournal"("code");
CREATE INDEX "PaymentJournal_active_sequence_idx" ON "PaymentJournal"("active", "sequence");
CREATE INDEX "Payment_paymentJournalId_idx" ON "Payment"("paymentJournalId");
CREATE INDEX "JournalEntry_paymentJournalId_idx" ON "JournalEntry"("paymentJournalId");

ALTER TABLE "PaymentJournal"
    ADD CONSTRAINT "PaymentJournal_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment"
    ADD CONSTRAINT "Payment_paymentJournalId_fkey"
    FOREIGN KEY ("paymentJournalId") REFERENCES "PaymentJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JournalEntry"
    ADD CONSTRAINT "JournalEntry_paymentJournalId_fkey"
    FOREIGN KEY ("paymentJournalId") REFERENCES "PaymentJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Keep the existing bank account (1200), and add dedicated asset accounts for
-- physical cash and payment methods that await bank settlement/reconciliation.
INSERT INTO "Account" ("id", "code", "name", "nameZh", "type", "active", "allowManual", "createdAt")
VALUES
    ('acct_1200_bank', '1200', 'Bank', '银行', 'ASSET', true, true, CURRENT_TIMESTAMP),
    ('acct_1205_cash_on_hand', '1205', 'Cash on Hand', '库存现金', 'ASSET', true, false, CURRENT_TIMESTAMP),
    ('acct_1210_cheques_outstanding', '1210', 'Outstanding Cheques', '待兑现支票', 'ASSET', true, false, CURRENT_TIMESTAMP),
    ('acct_1220_card_clearing', '1220', 'Card Clearing', '银行卡待结算', 'ASSET', true, false, CURRENT_TIMESTAMP),
    ('acct_1230_direct_debit_clearing', '1230', 'Direct Debit Clearing', '直接借记待结算', 'ASSET', true, false, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Each journal debits the corresponding asset/clearing account and credits A/R.
-- Codes and IDs are stable so these defaults can be safely seeded on every environment.
INSERT INTO "PaymentJournal" ("id", "code", "name", "type", "currencyCode", "accountId", "sequence", "active")
SELECT seed.id, seed.code, seed.name, seed.type::"PaymentJournalType", 'EUR', account."id", seed.sequence, true
FROM (VALUES
    ('payjournal_bank_eur', 'BANK', 'Bank (EUR)', 'BANK', '1200', 10),
    ('payjournal_cheque_eur', 'CHEQUE', 'Cheque (EUR)', 'BANK', '1210', 20),
    ('payjournal_pos_card_eur', 'POS', 'POS Card (EUR)', 'CREDIT_CARD', '1220', 30),
    ('payjournal_cash_eur', 'CASH', 'Cash (EUR)', 'CASH', '1205', 40),
    ('payjournal_direct_debit_eur', 'DIRECT_DEBIT', 'Direct Debit (EUR)', 'BANK', '1230', 50)
) AS seed(id, code, name, type, account_code, sequence)
JOIN "Account" account ON account."code" = seed.account_code
ON CONFLICT ("code") DO NOTHING;
