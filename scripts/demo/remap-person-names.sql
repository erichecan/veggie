-- 重新分配人名（T5 补丁）
--
-- 为什么单独一个脚本：anonymize.sql 只能对「真名 → 假名」跑一次。
-- 再跑一遍就是「假名 → 假名」，新旧名字空间重叠，
-- UPDATE 的中间状态会撞 DriverSlot 的 (timeOfDay,batchNum,driverName) 唯一约束
-- （实测报 Key=(am,1,Aoife Murphy) already exists）。
-- 这里改成两阶段：先把 driverName 打散成临时唯一值，再落到目标值。
--
--   psql "$NEON_DIRECT" -v commit=0 -f scripts/demo/remap-person-names.sql

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE _vocab AS SELECT
  ARRAY['Aoife','Cian','Niamh','Sean','Ciara','Liam','Saoirse','Conor','Roisin','Darragh',
        'Eoin','Maeve','Padraig','Sinead','Fergus','Orla','Ruairi','Nuala','Declan','Grainne'] AS first_n,
  ARRAY['Murphy','Kelly','Byrne','Ryan','O''Brien','Walsh','Doyle','Dunne','Nolan','Casey',
        'Quinn','Moore','Healy','Brennan','Lynch','Fitzgerald','Kavanagh','Duffy','Gallagher','Boyle'] AS last_n;

-- 交错取姓氏：只用 floor(rn/20) 会让同一批 20 个人全部同姓
CREATE TEMP TABLE _remap AS
WITH names AS (
          SELECT name            AS old_name FROM "User"        WHERE coalesce(name, '') <> ''
  UNION   SELECT "driverName"    FROM "DriverSlot"  WHERE coalesce("driverName", '') <> ''
  UNION   SELECT "driverName"    FROM "Trip"        WHERE coalesce("driverName", '') <> ''
  UNION   SELECT "driverName"    FROM "PickingWave" WHERE coalesce("driverName", '') <> ''
  UNION   SELECT "createdByName" FROM "Order"       WHERE coalesce("createdByName", '') <> ''
  UNION   SELECT "printedByName" FROM "Order"       WHERE coalesce("printedByName", '') <> ''
),
r AS (SELECT old_name, ROW_NUMBER() OVER (ORDER BY md5(old_name)) AS rn FROM names)
SELECT r.old_name,
  v.first_n[((r.rn - 1) % 20) + 1] || ' ' ||
  v.last_n[((((r.rn - 1) / 20) + (r.rn - 1)) % 20) + 1] AS new_name
FROM r CROSS JOIN _vocab v;

-- 先按 id 记住每行的目标值，因为阶段 1 会把匹配用的旧名冲掉
CREATE TEMP TABLE _slot_target AS
  SELECT s.id, m.new_name FROM "DriverSlot" s JOIN _remap m ON s."driverName" = m.old_name;
CREATE TEMP TABLE _wave_target AS
  SELECT w.id, m.new_name FROM "PickingWave" w JOIN _remap m ON w."driverName" = m.old_name;
CREATE TEMP TABLE _trip_target AS
  SELECT t.id, m.new_name FROM "Trip" t JOIN _remap m ON t."driverName" = m.old_name;

-- 阶段 1：打散到临时唯一值，解开唯一约束的中间态冲突
UPDATE "DriverSlot" SET "driverName" = 'TMP_' || id;

-- 阶段 2：落到目标值
UPDATE "DriverSlot" s  SET "driverName" = t.new_name FROM _slot_target t WHERE s.id = t.id;
UPDATE "PickingWave" w SET "driverName" = t.new_name FROM _wave_target t WHERE w.id = t.id;
UPDATE "Trip" tr       SET "driverName" = t.new_name FROM _trip_target t WHERE tr.id = t.id;

-- 无唯一约束的表直接按旧名映射
UPDATE "User" u  SET name = m.new_name FROM _remap m WHERE u.name = m.old_name;
UPDATE "Order" o SET "createdByName" = m.new_name FROM _remap m WHERE o."createdByName" = m.old_name;
UPDATE "Order" o SET "printedByName" = m.new_name FROM _remap m WHERE o."printedByName" = m.old_name;

-- 自检
SELECT 'tmp_leftover' AS chk, count(*) FROM "DriverSlot" WHERE "driverName" LIKE 'TMP\_%'
UNION ALL SELECT 'distinct_surnames', count(DISTINCT split_part(name, ' ', 2)) FROM "User"
UNION ALL SELECT 'user_slot_name_mismatch', count(*) FROM "DriverSlot" s
  JOIN "User" u ON u.id = s."userId" WHERE s."driverName" IS DISTINCT FROM u.name;

\if :commit
  COMMIT;
\else
  ROLLBACK;
\endif
