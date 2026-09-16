-- 拣货单「按客户展开」改为按计量单位可配置（20260916）
-- ============================================================================
-- 背景：此前展开与否由 Uom.goodsType 兼任 —— LOOSE 恒全展开、BULK 只在有留言时展开。
-- 生产实测这个耦合是错的：散货表里 86% 的行是可数包装（PACK/PKT/PACKET/TRAY…），
-- 它们留在散货表是对的（分表＝哪个组在哪个区域拣），但不该逐客户展开。
-- 客户给的判定标准：配货时现切现称、每份贴客户标签的要展开；提前备好按包数拿的不展开。

ALTER TABLE "Uom" ADD COLUMN "expandByCustomer" BOOLEAN NOT NULL DEFAULT false;

-- 只有真·现切现称单位需要按客户展开。其余 27 个 LOOSE 单位都是定量包装，保持 false。
-- 按 name 而非 id 匹配：本地开发库与生产库的 Uom 行不同源（本地 27 行 / 生产 38 行），
-- 按 id 写死在本地回填不到。已实测 KG / g / LOOSE 三个名字在生产库唯一，
-- upper() 精确匹配不会命中 1KG / 500g / UK 4KG 这类定量包装。
UPDATE "Uom" SET "expandByCustomer" = true
WHERE "goodsType" = 'LOOSE' AND upper(btrim("name")) IN ('KG', 'G', 'LOOSE');

-- PALLET 分类纠正：托盘是最大的整装单位，不该出现在零散货拣货单。
-- 它已被停用（active=false），但停用只影响新建/编辑时的下拉选项 —— 历史订单行仍按 uomId
-- 解析到它，打印时照样分进散货表。所以必须改 goodsType，靠停用解决不了。
-- ⛔ 只改分类，不动任何订单数据：那 3 条 Transport PALLET 行所在的两张单里
--    还有 11 条真实商品行（OP-260721-001 九条 / OP-260718-001 两条）。
UPDATE "Uom" SET "goodsType" = 'BULK' WHERE upper(btrim("name")) = 'PALLET';
