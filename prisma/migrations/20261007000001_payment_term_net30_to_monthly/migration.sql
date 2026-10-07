-- 20261007 客户反馈第 8 条：Odoo 迁过来的「30 Net Days」(及 NET30 / Net 30 等写法)
-- 系统里没有这一档，客户详情页的付款条款下拉显示成空白，逾期检查也不认它
-- (lib/payment-terms.ts 对未知账期一律不判逾期)。客户确认统一改成月结(monthly，30 天)。
-- 只动「30 天净付」这一类写法；COD / 15 Days 等其它遗留值不在本次范围，原样保留。
UPDATE "Customer"
SET "paymentTerm" = 'monthly',
    "updatedAt"   = NOW()
WHERE "paymentTerm" ~* '^\s*(net\s*-?\s*30(\s*days?)?|30\s*(net\s*)?days?(\s*net)?)\s*$';
