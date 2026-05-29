-- Seed UomCategory and Uom with common units used in food wholesale
-- Categories
INSERT INTO "UomCategory" ("id", "name", "nameZh") VALUES
  ('uomcat-weight',   'Weight',   '重量'),
  ('uomcat-volume',   'Volume',   '容量'),
  ('uomcat-unit',     'Unit',     '件数'),
  ('uomcat-length',   'Length',   '长度'),
  ('uomcat-time',     'Time',     '时间')
ON CONFLICT ("id") DO NOTHING;

-- Units of Measure
-- Weight group: reference = kg
INSERT INTO "Uom" ("id", "name", "nameZh", "categoryId", "factor", "rounding", "type", "active", "updatedAt") VALUES
  ('uom-kg',   'kg',  '千克', 'uomcat-weight', 1.0,    0.001, 'REFERENCE', true, NOW()),
  ('uom-g',    'g',   '克',   'uomcat-weight', 0.001,  0.001, 'SMALLER',   true, NOW()),
  ('uom-t',    't',   '吨',   'uomcat-weight', 1000.0, 0.001, 'BIGGER',    true, NOW()),
  ('uom-lb',   'lb',  '磅',   'uomcat-weight', 0.4536, 0.001, 'SMALLER',   true, NOW())
ON CONFLICT ("id") DO NOTHING;

-- Volume group: reference = L
INSERT INTO "Uom" ("id", "name", "nameZh", "categoryId", "factor", "rounding", "type", "active", "updatedAt") VALUES
  ('uom-l',    'L',   '升',   'uomcat-volume', 1.0,    0.001, 'REFERENCE', true, NOW()),
  ('uom-ml',   'mL',  '毫升', 'uomcat-volume', 0.001,  0.001, 'SMALLER',   true, NOW())
ON CONFLICT ("id") DO NOTHING;

-- Unit group: reference = 件
INSERT INTO "Uom" ("id", "name", "nameZh", "categoryId", "factor", "rounding", "type", "active", "updatedAt") VALUES
  ('uom-pcs',  '件',  '件',   'uomcat-unit',   1.0,    1.0,   'REFERENCE', true, NOW()),
  ('uom-box',  '箱',  '箱',   'uomcat-unit',   1.0,    1.0,   'BIGGER',    true, NOW()),
  ('uom-bag',  '袋',  '袋',   'uomcat-unit',   1.0,    1.0,   'BIGGER',    true, NOW()),
  ('uom-crate','筐',  '筐',   'uomcat-unit',   1.0,    1.0,   'BIGGER',    true, NOW()),
  ('uom-bunch','捆',  '捆',   'uomcat-unit',   1.0,    1.0,   'BIGGER',    true, NOW())
ON CONFLICT ("id") DO NOTHING;

-- Length group: reference = m
INSERT INTO "Uom" ("id", "name", "nameZh", "categoryId", "factor", "rounding", "type", "active", "updatedAt") VALUES
  ('uom-m',    'm',   '米',   'uomcat-length', 1.0,    0.01,  'REFERENCE', true, NOW()),
  ('uom-cm',   'cm',  '厘米', 'uomcat-length', 0.01,   0.01,  'SMALLER',   true, NOW())
ON CONFLICT ("id") DO NOTHING;

-- Time group: reference = h
INSERT INTO "Uom" ("id", "name", "nameZh", "categoryId", "factor", "rounding", "type", "active", "updatedAt") VALUES
  ('uom-h',    'h',   '小时', 'uomcat-time',   1.0,    0.01,  'REFERENCE', true, NOW()),
  ('uom-day',  'day', '天',   'uomcat-time',   8.0,    1.0,   'BIGGER',    true, NOW())
ON CONFLICT ("id") DO NOTHING;
