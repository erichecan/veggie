-- 给 Order.externalRef 加数据库层面的唯一约束，补齐 Odoo 外部 ID 幂等导入惯例
-- （ProductCategory/ProductTemplate/Product/Customer/OdooPricelist 的 externalId 早已有 @unique，
-- Order.externalRef 是唯一漏网的一处）。
-- 前置清理：生产库唯一一组重复值 externalRef='seed-shortage-demo'（18 条缺货处理演示种子数据）
-- 已在 scripts/fix-seed-shortage-demo-externalref-20260718.ts 里置空。
CREATE UNIQUE INDEX "Order_externalRef_key" ON "Order"("externalRef");
