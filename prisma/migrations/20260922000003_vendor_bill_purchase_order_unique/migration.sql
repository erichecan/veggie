-- 一个采购单至多一张账单：加 DB 约束兜底（20260922 code review 发现）
-- ============================================================================
-- lib/vendor-bill-from-po.ts 的自动生成幂等检查、以及新加的
-- veggie_purchasing_report 视图对 VendorBill 的 LEFT JOIN，都假定
-- "一个 purchaseOrderId 至多挂一张 VendorBill"，但此前只是注释里的约定，
-- POST /api/vendor-bills 直接接受任意 purchaseOrderId 且不查重。
-- 一旦出现第二张账单，视图 JOIN 会把该 PO 的金额/数量翻倍且没有任何报错。
--
-- 生产库(20260922 SSH 实测)与本地开发库均确认目前没有重复 purchaseOrderId，
-- 加这个唯一索引不会失败。Postgres 唯一索引允许任意多行 NULL，
-- 不影响没有关联采购单的手工账单（newSupplierId 那条创建路径）。

DROP INDEX IF EXISTS "VendorBill_purchaseOrderId_idx";
CREATE UNIQUE INDEX "VendorBill_purchaseOrderId_key" ON "VendorBill"("purchaseOrderId");
