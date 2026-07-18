-- 补齐 Odoo 优化自查里标注为"低优先级"的 5 处外键索引缺口
-- （docs/20260717-odoo-single-source-migration-plan.md 第五节第 2 条）
CREATE INDEX "OrderLine_uomId_idx" ON "OrderLine"("uomId");
CREATE INDEX "OrderDiscrepancy_productId_idx" ON "OrderDiscrepancy"("productId");
CREATE INDEX "OrderDiscrepancy_substituteProductId_idx" ON "OrderDiscrepancy"("substituteProductId");
CREATE INDEX "PurchaseOrderLine_uomId_idx" ON "PurchaseOrderLine"("uomId");
CREATE INDEX "Order_printedById_idx" ON "Order"("printedById");
