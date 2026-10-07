-- 20261007 客户/供应商彻底分开（客户确认方案：拆成两条，编号沿用同一序列）
-- ============================================================================
-- 客户反馈：Customers 和 Purchases → Vendors 里是**同一条记录**——改客户名称，供应商
-- 名称跟着变，编号也一样。原因：客户和供应商共用 Customer 表，从 Odoo 迁过来的联系人
-- (Odoo res.partner 本来就是客户+供应商一体)大量是 isCustomer=true 且 isVendor=true
-- 的同一条档案。20260907 起界面已按"客户/供应商分两条编辑"设计，但这批历史数据一直
-- 没拆，导入/新建供应商的后端逻辑也还在把同名客户并成一条(本次一并改掉)。
--
-- 每条「既是客户又是供应商」的档案拆成两条：
--   - 原记录(id 不变、编号不变)保留为**客户**：订单/发票/收款/送货单/对账单/贷项/
--     价格表/专属价/联系人等客户侧数据全部原样不动；isVendor 置 false。
--   - 新建一条**供应商**档案(新 id、新编号)：复制名称、地址、电话、邮箱、税号、
--     采购税率、供应商付款条款、备注、启用状态，并复制一份联系人。
--   - 供应商侧单据改指向新供应商档案：采购单、供应商账单、供应商付款、采购记录、
--     采购建议、商品-供应商关联，以及供应商账单/供应商付款生成的会计分录行。
-- 每条拆分都在 ActionLog 里留两条记录(新旧 id 对照)，需要追溯时可查。
-- 没有这类档案时整段什么都不做(可重复执行)。

CREATE TEMP TABLE _vendor_split AS
SELECT c.id AS old_id,
       'vs' || replace(gen_random_uuid()::text, '-', '') AS new_id,
       ROW_NUMBER() OVER (ORDER BY c."createdAt", c.id) AS rn
FROM "Customer" c
WHERE c."isCustomer" = true AND c."isVendor" = true;

-- 1. 新供应商档案(customerNo 走序列自动分配新编号；externalId 唯一，留在客户那条上)
INSERT INTO "Customer" (
  id, "individualOrCompany", mobile, name, address, street, street2, state, zip, country,
  phone, email, "vatNumber", "updatedBy", tags, city, notes, "isActive",
  "isCustomer", "isVendor", "vendorTaxRate", "supplierPaymentTerm", latitude, longitude,
  "createdAt", "updatedAt"
)
SELECT s.new_id, c."individualOrCompany", c.mobile, c.name, c.address, c.street, c.street2, c.state, c.zip, c.country,
       c.phone, c.email, c."vatNumber", 'system: customer/vendor split', c.tags, c.city, c.notes, c."isActive",
       false, true, c."vendorTaxRate", c."supplierPaymentTerm", c.latitude, c.longitude,
       c."createdAt", NOW()
FROM _vendor_split s
JOIN "Customer" c ON c.id = s.old_id
ORDER BY s.rn;

-- 2. 联系人复制一份给供应商(客户那份不动；externalId 唯一，不复制)
INSERT INTO "CustomerContact" (id, "customerId", name, email, role, phone, "isPrimary", "isActive", notes, "createdAt", "updatedAt")
SELECT 'vc' || replace(gen_random_uuid()::text, '-', ''), s.new_id, cc.name, cc.email, cc.role, cc.phone,
       cc."isPrimary", cc."isActive", cc.notes, cc."createdAt", NOW()
FROM _vendor_split s
JOIN "CustomerContact" cc ON cc."customerId" = s.old_id;

-- 3. 供应商侧单据改指向新供应商档案
UPDATE "PurchaseOrder" t SET "supplierId" = s.new_id FROM _vendor_split s WHERE t."supplierId" = s.old_id;
UPDATE "VendorBill" t SET "supplierId" = s.new_id FROM _vendor_split s WHERE t."supplierId" = s.old_id;
UPDATE "VendorPayment" t SET "supplierId" = s.new_id FROM _vendor_split s WHERE t."supplierId" = s.old_id;
UPDATE "PurchaseRecord" t SET "supplierId" = s.new_id FROM _vendor_split s WHERE t."supplierId" = s.old_id;
UPDATE "PurchaseSuggestion" t SET "supplierId" = s.new_id FROM _vendor_split s WHERE t."supplierId" = s.old_id;
UPDATE "ProductSupplierInfo" t SET "supplierId" = s.new_id FROM _vendor_split s WHERE t."supplierId" = s.old_id;
UPDATE "JournalEntryLine" l
SET "partnerId" = s.new_id
FROM _vendor_split s, "JournalEntry" e
WHERE l."partnerId" = s.old_id
  AND e.id = l."entryId"
  AND e."sourceType" IN ('vendor_bill', 'vendor_payment');

-- 4. 原记录只保留客户身份
UPDATE "Customer" c
SET "isVendor" = false, "updatedAt" = NOW()
FROM _vendor_split s
WHERE c.id = s.old_id;

-- 5. 留痕(新旧 id 对照)
INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
SELECT 'al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'UPDATE', 'customer', s.old_id,
       '客户/供应商拆分：供应商身份迁到新档案 ' || s.new_id, NOW()
FROM _vendor_split s;
INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
SELECT 'al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'CREATE', 'customer', s.new_id,
       '客户/供应商拆分：由客户档案 ' || s.old_id || ' 拆出的供应商档案', NOW()
FROM _vendor_split s;

DROP TABLE _vendor_split;
