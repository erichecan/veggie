-- AI 问数 v2：明细钻取/quotation 域按 Order.confirmationDate 直接过滤，
-- 此前只有 status 索引，靠先筛小 status 再 join OrderLine；明细模式绕过
-- status 收窄时在 133 万行 OrderLine 上有全表扫风险。
CREATE INDEX IF NOT EXISTS "Order_confirmationDate_idx" ON "Order"("confirmationDate");
