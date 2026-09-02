-- 客户预付款支持（20260902）
--
-- Payment.invoiceId 放开为可选：登记"收到预收款"（source=PREPAYMENT_RECEIVED）
-- 这个事件时还没有对应发票，跟"用预收款冲抵发票"（source=PREPAYMENT_APPLIED）
-- 是两笔记账方向相反的分录，不能用同一个布尔字段区分，改用三态 source 字段。
-- 原有的普通收款不受影响，source 默认 CASH，含义与改造前完全一致。
ALTER TABLE "Payment" ALTER COLUMN "invoiceId" DROP NOT NULL;
ALTER TABLE "Payment" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'CASH';
CREATE INDEX "Payment_source_idx" ON "Payment"("source");

-- 新增会计科目 2300 客户预收款（LIABILITY）。STANDARD_ACCOUNTS 只在 prisma/seed.ts
-- 里被消费，生产库不会重新跑 seed，所以这里必须手写一条数据迁移，否则
-- 预付款过账逻辑在生产上会因为找不到这个科目而失败。
INSERT INTO "Account" ("id", "code", "name", "nameZh", "type", "active", "allowManual", "createdAt")
VALUES (gen_random_uuid()::TEXT, '2300', 'Customer Prepayments', '客户预收款', 'LIABILITY', true, false, NOW())
ON CONFLICT ("code") DO NOTHING;
