-- 20261008 客户要求：采购模块里除了供应商，其他数据全部清空（范围已与客户逐项确认）
-- ============================================================================
-- 清空：
--   - 采购单 PurchaseOrder（明细 PurchaseOrderLine、收货记录 GoodsReceipt 随之级联删除）
--   - 采购建议 PurchaseSuggestion（次日生鲜 / 干货年度计划 / 采购建议页的数据）
--   - 旧进货单 PurchaseRecord
--   - 供应商账单 VendorBill、供应商付款 VendorPayment，以及它们生成的会计分录
--     （JournalEntry.sourceType = 'vendor_bill' / 'vendor_payment'，分录行随之级联删除）
-- 保留（客户确认）：
--   - 供应商档案（Customer.isVendor）及其联系人
--   - 商品的供应商报价 ProductSupplierInfo
--   - 库存：收货产生的库存数量、库存流水 StockMove、批次 Lot 都不动（货实际在仓库里），
--     只是流水/批次上的来源采购单号对应不到单据了
--
-- 备份：删除前把上面每张表被删的数据整表复制到独立的 schema "backup_20261008_purchases"，
-- 不在 public 里、不影响系统运行和 Prisma；需要时可以从那里恢复，确认无误后可整个 DROP SCHEMA。

CREATE SCHEMA IF NOT EXISTS backup_20261008_purchases;

CREATE TABLE backup_20261008_purchases."PurchaseOrder" AS SELECT * FROM "PurchaseOrder";
CREATE TABLE backup_20261008_purchases."PurchaseOrderLine" AS SELECT * FROM "PurchaseOrderLine";
CREATE TABLE backup_20261008_purchases."GoodsReceipt" AS SELECT * FROM "GoodsReceipt";
CREATE TABLE backup_20261008_purchases."PurchaseSuggestion" AS SELECT * FROM "PurchaseSuggestion";
CREATE TABLE backup_20261008_purchases."PurchaseRecord" AS SELECT * FROM "PurchaseRecord";
CREATE TABLE backup_20261008_purchases."VendorBill" AS SELECT * FROM "VendorBill";
CREATE TABLE backup_20261008_purchases."VendorPayment" AS SELECT * FROM "VendorPayment";
CREATE TABLE backup_20261008_purchases."JournalEntry" AS
  SELECT * FROM "JournalEntry" WHERE "sourceType" IN ('vendor_bill', 'vendor_payment');
CREATE TABLE backup_20261008_purchases."JournalEntryLine" AS
  SELECT l.* FROM "JournalEntryLine" l
  JOIN "JournalEntry" e ON e.id = l."entryId"
  WHERE e."sourceType" IN ('vendor_bill', 'vendor_payment');

-- 删除（按依赖顺序：分录 → 付款 → 账单 → 采购单 → 其它）
DELETE FROM "JournalEntry" WHERE "sourceType" IN ('vendor_bill', 'vendor_payment');
DELETE FROM "VendorPayment";
DELETE FROM "VendorBill";
DELETE FROM "PurchaseSuggestion";
DELETE FROM "PurchaseOrder";
DELETE FROM "PurchaseRecord";

-- 留痕
INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
SELECT 'al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'DELETE', 'purchase-order', 'bulk',
       '清空采购模块数据(保留供应商/供应商报价/库存)：采购单 ' || (SELECT COUNT(*) FROM backup_20261008_purchases."PurchaseOrder")
       || '、采购建议 ' || (SELECT COUNT(*) FROM backup_20261008_purchases."PurchaseSuggestion")
       || '、旧进货单 ' || (SELECT COUNT(*) FROM backup_20261008_purchases."PurchaseRecord")
       || '、供应商账单 ' || (SELECT COUNT(*) FROM backup_20261008_purchases."VendorBill")
       || '、供应商付款 ' || (SELECT COUNT(*) FROM backup_20261008_purchases."VendorPayment")
       || '、会计分录 ' || (SELECT COUNT(*) FROM backup_20261008_purchases."JournalEntry")
       || '；备份在 schema backup_20261008_purchases',
       NOW();
