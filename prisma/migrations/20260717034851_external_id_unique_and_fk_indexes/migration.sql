-- 幂等导入前置：externalId 补唯一约束，Odoo 风格补齐外键索引覆盖
-- 唯一约束（NULL 值互不冲突，不影响非 Odoo 来源的手工记录）
CREATE UNIQUE INDEX "Customer_externalId_key" ON "Customer"("externalId");
CREATE UNIQUE INDEX "Product_externalId_key" ON "Product"("externalId");
CREATE UNIQUE INDEX "ProductCategory_externalId_key" ON "ProductCategory"("externalId");
CREATE UNIQUE INDEX "ProductTemplate_externalId_key" ON "ProductTemplate"("externalId");

-- 外键索引覆盖补齐
CREATE INDEX "CategoryGroup_ownerUserId_idx" ON "CategoryGroup"("ownerUserId");
CREATE INDEX "ProductAttributeValue_attributeId_idx" ON "ProductAttributeValue"("attributeId");
CREATE INDEX "ProductTemplate_uomId_idx" ON "ProductTemplate"("uomId");
CREATE INDEX "ProductTemplate_purchaseUomId_idx" ON "ProductTemplate"("purchaseUomId");
CREATE INDEX "ProductSaleUom_uomId_idx" ON "ProductSaleUom"("uomId");
CREATE INDEX "CustomerPricelist_pricelistId_idx" ON "CustomerPricelist"("pricelistId");
CREATE INDEX "OrderDiscrepancy_orderLineId_idx" ON "OrderDiscrepancy"("orderLineId");
CREATE INDEX "OrderAuditLog_userId_idx" ON "OrderAuditLog"("userId");
CREATE INDEX "PurchaseSuggestion_supplierId_idx" ON "PurchaseSuggestion"("supplierId");
CREATE INDEX "PurchaseSuggestion_purchaseOrderId_idx" ON "PurchaseSuggestion"("purchaseOrderId");
CREATE INDEX "CreditNoteLine_sourceTripId_idx" ON "CreditNoteLine"("sourceTripId");
