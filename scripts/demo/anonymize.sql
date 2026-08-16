-- 演示数据脱敏（T5）—— 在 build-demo-subset.sql 之后跑
--
--   psql "$NEON_DIRECT" -v commit=0 -f scripts/demo/anonymize.sql   # dry-run
--   psql "$NEON_DIRECT" -v commit=1 -f scripts/demo/anonymize.sql   # 真改
--
-- ⛔ 客户名/员工名在这个库里是**冗余存储**的：改完主表还必须同步 7 处快照列，
--    其中两处埋在 jsonb 里（Trip.restaurants[].restaurantName）。
--    只改主表的话，发票 PDF、送货单、配送中心上照样显示真名。

\set ON_ERROR_STOP on

BEGIN;

-- ── 假名词库 ──────────────────────────────────────────────
CREATE TEMP TABLE _vocab AS SELECT
  ARRAY['Golden','Silver','Royal','Green','Blue','Old','New','Grand','Little','Corner',
        'Riverside','Harbour','Garden','Sunny','Lucky','Jade','Pearl','Crown','Orchard','Copper'] AS adj,
  ARRAY['Kitchen','Bistro','Garden','House','Palace','Grill','Table','Spoon','Pot','Wok',
        'Terrace','Yard','Deli','Canteen','Larder','Pantry','Fork','Plate','Oven','Hearth'] AS noun,
  ARRAY['Leinster','Munster','Connacht','Ulster','Meath','Kildare','Wicklow','Louth','Carlow','Kilkenny'] AS region,
  ARRAY['Produce','Fresh Foods','Wholesale','Supplies','Trading','Farms','Imports','Distribution'] AS biz,
  ARRAY['Aoife','Cian','Niamh','Sean','Ciara','Liam','Saoirse','Conor','Roisin','Darragh',
        'Eoin','Maeve','Padraig','Sinead','Fergus','Orla','Ruairi','Nuala','Declan','Grainne'] AS first_n,
  ARRAY['Murphy','Kelly','Byrne','Ryan','O''Brien','Walsh','Doyle','Dunne','Nolan','Casey',
        'Quinn','Moore','Healy','Brennan','Lynch','Fitzgerald','Kavanagh','Duffy','Gallagher','Boyle'] AS last_n;

-- ── 客户/供应商假名映射 ───────────────────────────────────
-- 纯供应商给公司式名字，其余给餐厅式名字（该表用 isCustomer/isVendor 同时装两类）
CREATE TEMP TABLE _map_customer AS
WITH r AS (
  SELECT id, "isVendor", "isCustomer",
         ROW_NUMBER() OVER (PARTITION BY ("isCustomer") ORDER BY id) AS rn
  FROM "Customer"
)
SELECT r.id,
  CASE WHEN r."isCustomer" THEN
    v.adj[((r.rn - 1) % 20) + 1] || ' ' || v.noun[((((r.rn - 1) / 20) + (r.rn - 1)) % 20) + 1]
  ELSE
    v.region[((r.rn - 1) % 10) + 1] || ' ' || v.biz[((((r.rn - 1) / 10) + (r.rn - 1)) % 8) + 1] || ' Ltd'
  END AS new_name,
  r.rn,
  -- 全局序号：rn 是按 isCustomer 分区的，客户和供应商各有一个 rn=1，
  -- 直接拿它拼 externalId / email 会撞唯一约束
  ROW_NUMBER() OVER (ORDER BY r.id) AS grn
FROM r CROSS JOIN _vocab v;

-- ── 人名映射：按「原名字符串」而不是 userId ────────────────
-- 两个原因必须这么做：
--   ① DriverSlot 70 条只对应 13 个 user（同一人同档期有多个 slot），
--      按 userId 映射会把它们改成同名，直接撞 (timeOfDay,batchNum,driverName) 唯一约束；
--   ② 其中 5 条 slot 的 userId 是空的 —— 按 userId 映射根本覆盖不到，真名会留在库里。
-- 按原名映射则「同名同假名、异名异假名」，两个问题一起解决。全库共 53 个不同人名，
-- 20×20 词库足够保证唯一。
CREATE TEMP TABLE _map_person AS
WITH names AS (
          SELECT name            AS old_name FROM "User"        WHERE coalesce(name, '') <> ''
  UNION   SELECT "driverName"    FROM "DriverSlot"  WHERE coalesce("driverName", '') <> ''
  UNION   SELECT "driverName"    FROM "Trip"        WHERE coalesce("driverName", '') <> ''
  UNION   SELECT "driverName"    FROM "PickingWave" WHERE coalesce("driverName", '') <> ''
  UNION   SELECT "createdByName" FROM "Order"       WHERE coalesce("createdByName", '') <> ''
  UNION   SELECT "printedByName" FROM "Order"       WHERE coalesce("printedByName", '') <> ''
),
r AS (SELECT old_name, ROW_NUMBER() OVER (ORDER BY old_name) AS rn FROM names)
SELECT r.old_name,
  -- 姓氏索引若只取 floor(rn/20)，同一批 20 个人会全部同姓（实测 8 个演示账号清一色 Byrne）。
  -- 加上 rn 做交错既打散姓氏，又保持 (名,姓) 组合唯一。
  v.first_n[((r.rn - 1) % 20) + 1] || ' ' || v.last_n[((((r.rn - 1) / 20) + (r.rn - 1)) % 20) + 1] AS new_name
FROM r CROSS JOIN _vocab v;

-- email 按角色编号生成，方便演示时知道用哪个账号登录；passwordHash 不动，原密码继续有效
CREATE TEMP TABLE _map_user AS
WITH r AS (
  SELECT id, role, ROW_NUMBER() OVER (PARTITION BY role ORDER BY id) AS rn FROM "User"
)
SELECT r.id,
  lower(r.role::text) || CASE WHEN r.rn = 1 THEN '' ELSE r.rn::text END || '@demo.local' AS new_email
FROM r;

-- ── 1. Customer 本体 ──────────────────────────────────────
UPDATE "Customer" c SET
  name        = m.new_name,
  email       = 'contact' || m.grn || '@demo.local',
  phone       = '+353 1 555 ' || lpad(((m.grn * 137) % 10000)::text, 4, '0'),
  "vatNumber" = 'IE' || lpad(((m.grn * 8237) % 10000000)::text, 7, '0') || 'A',
  address     = m.grn || ' Demo Street, Dublin ' || (1 + (m.grn % 24)),
  street      = m.grn || ' Demo Street',
  street2     = '',
  city        = 'Dublin',
  state       = '',
  zip         = 'D' || lpad((1 + (m.grn % 24))::text, 2, '0') || ' XY' || lpad((m.grn % 100)::text, 2, '0'),
  -- 真实经纬度能直接在地图上定位到客户店址 —— 换成都柏林范围内的确定性伪随机点
  latitude    = 53.30 + (('x' || substr(md5(c.id), 1, 8))::bit(32)::bigint % 12000) / 100000.0,
  longitude   = -6.35 + (('x' || substr(md5(c.id), 9, 8))::bit(32)::bigint % 20000) / 100000.0,
  notes         = NULL,
  "externalNote" = NULL,
  "externalId"  = 'demo_partner_' || m.grn
FROM _map_customer m WHERE c.id = m.id;

-- ── 2. User 本体 ──────────────────────────────────────────
UPDATE "User" u SET name = p.new_name FROM _map_person p WHERE u.name = p.old_name;
UPDATE "User" u SET email = m.new_email  FROM _map_user   m WHERE u.id   = m.id;

-- ── 3. 客户名快照同步（漏一处就在 PDF 上露真名）────────────
UPDATE "Order" o        SET "restaurantName" = m.new_name FROM _map_customer m WHERE o."restaurantId" = m.id;
UPDATE "Invoice" i      SET "customerName"   = m.new_name FROM _map_customer m WHERE i."customerId"   = m.id;
UPDATE "CreditNote" cn  SET "customerName"   = m.new_name FROM _map_customer m WHERE cn."customerId"  = m.id;
UPDATE "DeliverySlip" d SET "customerName"   = m.new_name FROM _map_customer m WHERE d."customerId"   = m.id;

-- ── 4. 员工名快照同步 ─────────────────────────────────────
-- 全部按原名匹配，覆盖 userId 为空的行
UPDATE "Order" o       SET "createdByName" = p.new_name FROM _map_person p WHERE o."createdByName" = p.old_name;
UPDATE "Order" o       SET "printedByName" = p.new_name FROM _map_person p WHERE o."printedByName" = p.old_name;
UPDATE "DriverSlot" s  SET "driverName"    = p.new_name FROM _map_person p WHERE s."driverName"    = p.old_name;
UPDATE "Trip" t        SET "driverName"    = p.new_name FROM _map_person p WHERE t."driverName"    = p.old_name;
UPDATE "PickingWave" w SET "driverName"    = p.new_name FROM _map_person p WHERE w."driverName"    = p.old_name;

-- ── 5. jsonb 内层的餐厅名（最容易漏）──────────────────────
-- 注意是 INNER JOIN：指向已删客户的条目直接丢弃，不能保留。
-- 用 LEFT JOIN「匹配不到就保持原样」会把真名留在库里（实测残留 1 条）。
UPDATE "Trip" t SET restaurants = COALESCE((
  SELECT jsonb_agg(jsonb_set(elem, '{restaurantName}', to_jsonb(m.new_name)) ORDER BY ord)
  FROM jsonb_array_elements(t.restaurants) WITH ORDINALITY AS a(elem, ord)
  JOIN _map_customer m ON m.id = a.elem->>'restaurantId'
), '[]'::jsonb)
WHERE jsonb_typeof(t.restaurants) = 'array' AND jsonb_array_length(t.restaurants) > 0;

-- ── 6. 自由文本一律清空（最易夹带联系人、地址、备注）──────
UPDATE "Order" SET "internalNote" = NULL, "externalNote" = NULL, "deliveryNote" = NULL;
UPDATE "CreditNote"    SET notes = NULL;
UPDATE "Trip"          SET "settlementNote" = NULL;
UPDATE "PurchaseOrder" SET notes = NULL, "sourceDocumentName" = NULL;
UPDATE "VendorBill"    SET notes = NULL;
UPDATE "StockTake"     SET notes = NULL;

-- ── 7. 供应商侧字段 ───────────────────────────────────────
UPDATE "PurchaseSuggestion" ps SET "supplierName" = m.new_name
  FROM _map_customer m WHERE ps."supplierId" = m.id;
UPDATE "ProductSupplierInfo" SET "productName" = 'Supplier Ref ' || substr(md5(id), 1, 6);

-- ── 8. 自检：真实身份信息是否还残留 ───────────────────────
SELECT 'customer_not_renamed' AS chk, count(*) FROM "Customer" c
  WHERE c.name NOT IN (SELECT new_name FROM _map_customer)
UNION ALL SELECT 'user_email_not_demo', count(*) FROM "User" u
  WHERE u.email NOT LIKE '%@demo.local'
UNION ALL SELECT 'person_name_not_renamed', count(*) FROM (
          SELECT name AS n FROM "User"        WHERE coalesce(name, '') <> ''
  UNION   SELECT "driverName" FROM "DriverSlot"  WHERE coalesce("driverName", '') <> ''
  UNION   SELECT "driverName" FROM "Trip"        WHERE coalesce("driverName", '') <> ''
  UNION   SELECT "driverName" FROM "PickingWave" WHERE coalesce("driverName", '') <> ''
  UNION   SELECT "createdByName" FROM "Order"    WHERE coalesce("createdByName", '') <> ''
  UNION   SELECT "printedByName" FROM "Order"    WHERE coalesce("printedByName", '') <> ''
) a WHERE a.n NOT IN (SELECT new_name FROM _map_person)
UNION ALL SELECT 'order_name_mismatch', count(*) FROM "Order" o
  JOIN "Customer" c ON c.id = o."restaurantId" WHERE o."restaurantName" IS DISTINCT FROM c.name
UNION ALL SELECT 'invoice_name_mismatch', count(*) FROM "Invoice" i
  JOIN "Customer" c ON c.id = i."customerId" WHERE i."customerName" IS DISTINCT FROM c.name
UNION ALL SELECT 'trip_json_realname', count(*) FROM "Trip" t,
  jsonb_array_elements(t.restaurants) e
  WHERE jsonb_typeof(t.restaurants) = 'array'
    AND e->>'restaurantName' NOT IN (SELECT new_name FROM _map_customer)
UNION ALL SELECT 'leftover_notes', count(*) FROM "Order"
  WHERE coalesce("internalNote", '') <> '' OR coalesce("externalNote", '') <> '';

\if :commit
  COMMIT;
\else
  ROLLBACK;
\endif
