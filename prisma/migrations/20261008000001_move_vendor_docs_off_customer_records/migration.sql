-- 20261008 客户/供应商彻底分开（续 20261007000004，同一方案，客户已确认）
-- ============================================================================
-- 客户反馈：客户列表里删 China Wholesale / K.Y Veg & Fruits Company LTD 被拒——
-- 「61 / 4 张采购单」。这些档案没有供应商标记(isVendor=false)，但历史采购单(Odoo 导入时
-- 按 Odoo partner 对上的)直接挂在了这条**客户**档案上。20261007000004 只拆了
-- "既是客户又是供应商"的档案，这一类没覆盖到。
--
-- 处理：凡是 isVendor=false 却挂着采购侧单据的档案，把采购侧单据搬到一条供应商档案上：
--   - 已有**唯一一条**同名(忽略大小写/首尾空格)的纯供应商档案 → 搬到那条上；
--   - 否则新建一条供应商档案(新编号；复制名称/地址/电话/邮箱/税号/采购税率/付款条款/
--     备注/状态 + 联系人)，再搬过去。
-- 搬的范围与 20261007000004 相同：采购单、供应商账单、供应商付款、采购记录、采购建议、
-- 商品-供应商关联、供应商账单/供应商付款生成的会计分录行。客户侧数据一律不动。
-- 每条处理写 ActionLog(新旧 id 对照)；没有这类档案时什么都不做(可重复执行)。

CREATE TEMP TABLE _src AS
SELECT c.id AS old_id, c.name, c."createdAt"
FROM "Customer" c
WHERE c."isVendor" = false
  AND (
       EXISTS (SELECT 1 FROM "PurchaseOrder" t WHERE t."supplierId" = c.id)
    OR EXISTS (SELECT 1 FROM "VendorBill" t WHERE t."supplierId" = c.id)
    OR EXISTS (SELECT 1 FROM "VendorPayment" t WHERE t."supplierId" = c.id)
    OR EXISTS (SELECT 1 FROM "PurchaseRecord" t WHERE t."supplierId" = c.id)
    OR EXISTS (SELECT 1 FROM "ProductSupplierInfo" t WHERE t."supplierId" = c.id)
    OR EXISTS (SELECT 1 FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e.id = l."entryId"
               WHERE l."partnerId" = c.id AND e."sourceType" IN ('vendor_bill', 'vendor_payment'))
  );

-- 同名纯供应商档案(只认唯一一条；不止一条时不猜，走新建)
CREATE TEMP TABLE _match AS
SELECT s.old_id, MIN(v.id) AS vendor_id
FROM _src s
JOIN "Customer" v
  ON v."isVendor" = true AND v."isCustomer" = false
 AND lower(btrim(v.name)) = lower(btrim(s.name))
GROUP BY s.old_id
HAVING COUNT(*) = 1;

CREATE TEMP TABLE _move AS
SELECT s.old_id,
       COALESCE(m.vendor_id, 'vs' || replace(gen_random_uuid()::text, '-', '')) AS new_id,
       (m.vendor_id IS NULL) AS is_new,
       ROW_NUMBER() OVER (ORDER BY s."createdAt", s.old_id) AS rn
FROM _src s
LEFT JOIN _match m ON m.old_id = s.old_id;

-- 1. 没有现成供应商的，新建一条
INSERT INTO "Customer" (
  id, "individualOrCompany", mobile, name, address, street, street2, state, zip, country,
  phone, email, "vatNumber", "updatedBy", tags, city, notes, "isActive",
  "isCustomer", "isVendor", "vendorTaxRate", "supplierPaymentTerm", latitude, longitude,
  "createdAt", "updatedAt"
)
SELECT mv.new_id, c."individualOrCompany", c.mobile, c.name, c.address, c.street, c.street2, c.state, c.zip, c.country,
       c.phone, c.email, c."vatNumber", 'system: customer/vendor split', c.tags, c.city, c.notes, c."isActive",
       false, true, c."vendorTaxRate", c."supplierPaymentTerm", c.latitude, c.longitude,
       c."createdAt", NOW()
FROM _move mv
JOIN "Customer" c ON c.id = mv.old_id
WHERE mv.is_new
ORDER BY mv.rn;

INSERT INTO "CustomerContact" (id, "customerId", name, email, role, phone, "isPrimary", "isActive", notes, "createdAt", "updatedAt")
SELECT 'vc' || replace(gen_random_uuid()::text, '-', ''), mv.new_id, cc.name, cc.email, cc.role, cc.phone,
       cc."isPrimary", cc."isActive", cc.notes, cc."createdAt", NOW()
FROM _move mv
JOIN "CustomerContact" cc ON cc."customerId" = mv.old_id
WHERE mv.is_new;

-- 2. 商品-供应商关联：(productId, supplierId) 唯一——目标供应商已有同一商品的报价时保留目标那条，
--    源档案上的重复行删掉；其余改指向目标
DELETE FROM "ProductSupplierInfo" t
USING _move mv
WHERE t."supplierId" = mv.old_id
  AND EXISTS (SELECT 1 FROM "ProductSupplierInfo" x WHERE x."supplierId" = mv.new_id AND x."productId" = t."productId");
UPDATE "ProductSupplierInfo" t SET "supplierId" = mv.new_id FROM _move mv WHERE t."supplierId" = mv.old_id;

-- 3. 其余采购侧单据改指向供应商档案
UPDATE "PurchaseOrder" t SET "supplierId" = mv.new_id FROM _move mv WHERE t."supplierId" = mv.old_id;
UPDATE "VendorBill" t SET "supplierId" = mv.new_id FROM _move mv WHERE t."supplierId" = mv.old_id;
UPDATE "VendorPayment" t SET "supplierId" = mv.new_id FROM _move mv WHERE t."supplierId" = mv.old_id;
UPDATE "PurchaseRecord" t SET "supplierId" = mv.new_id FROM _move mv WHERE t."supplierId" = mv.old_id;
UPDATE "PurchaseSuggestion" t SET "supplierId" = mv.new_id FROM _move mv WHERE t."supplierId" = mv.old_id;
UPDATE "JournalEntryLine" l
SET "partnerId" = mv.new_id
FROM _move mv, "JournalEntry" e
WHERE l."partnerId" = mv.old_id
  AND e.id = l."entryId"
  AND e."sourceType" IN ('vendor_bill', 'vendor_payment');

-- 4. 留痕
INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
SELECT 'al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'UPDATE', 'customer', mv.old_id,
       '客户/供应商拆分：采购单等采购侧单据迁到供应商档案 ' || mv.new_id || CASE WHEN mv.is_new THEN '(新建)' ELSE '(同名已有供应商)' END, NOW()
FROM _move mv;
INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
SELECT 'al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System',
       CASE WHEN mv.is_new THEN 'CREATE'::"ActionType" ELSE 'UPDATE'::"ActionType" END, 'customer', mv.new_id,
       '客户/供应商拆分：接收客户档案 ' || mv.old_id || ' 上的采购侧单据', NOW()
FROM _move mv;

DROP TABLE _move;
DROP TABLE _match;
DROP TABLE _src;
