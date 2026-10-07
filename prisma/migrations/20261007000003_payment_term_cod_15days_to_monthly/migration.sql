-- 20261007 客户确认：Odoo 遗留的 COD(货到付款) 与 15 Days 也统一改成月结(monthly)，
-- 与 20261007000001(30 Net Days → monthly) 同一批清理。之后客户账期只剩
-- lib/payment-terms.ts 的标准五档(或空白)。
-- 注意：COD 以前在送货单上会红字提示「当场收款」(paymentTermPrintLabel)，改成月结后不再提示。
UPDATE "Customer"
SET "paymentTerm" = 'monthly',
    "updatedAt"   = NOW()
WHERE "paymentTerm" ~* '^\s*(cod|c\.o\.d\.?|cash\s+on\s+delivery|15\s*(net\s*)?days?(\s*net)?|net\s*-?\s*15(\s*days?)?)\s*$';
