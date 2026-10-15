-- 20261015 补扣 Pepper Green 测试单（客户确认：「只扣掉那张测试单」）
-- ============================================================================
-- 背景：修复前 Place Order 页「确认」直接建成 CONFIRMED、不扣库存（见 docs/20261014-veggie-deploy-log.md）。
-- 客户用 Pepper Green（PGC）走了一遍销售流程验证，那张单走到完成也没扣库存，在手量停在 1220。
-- 「统一补扣」按钮只处理未送达的单；这张已完成，按「历史不补」不会自动补，客户要求单独扣掉。
--
-- 只在条件完全明确时动手，否则一个数都不改，只在 Pepper Green 商品页的操作日志里留下候选单号：
--   - internalRef = 'PGC' 的实物商品恰好 1 个；
--   - 候选单：已完成/已锁定、含 PGC 行、从未有过订单库存流水、
--     创建于 2026-10-13 至修复上线（2026-10-15 02:54 UTC）之间 —— 恰好 1 张才扣。
-- 扣法与确认订单一致：只扣这张单的 PGC 行（按行单位换算成基础单位），流水「仓库 → 客户」挂在这张订单下，
-- 出凭证 Dr 5100 销售成本 / Cr 1300 存货（按平均成本）。不动批次余量（流水不挂批次，批次台账不受影响）。
DO $$
DECLARE
  v_pcount INT;
  v_pid TEXT;
  v_pname TEXT;
  v_ptype TEXT;
  v_cost NUMERIC;
  v_cnt INT;
  v_codes TEXT;
  v_oid TEXT;
  v_ocode TEXT;
  v_partner TEXT;
  v_total NUMERIC := 0;
  v_qty NUMERIC;
  v_line RECORD;
  v_value NUMERIC;
  v_inv TEXT;
  v_cogs TEXT;
  v_entry TEXT := 'je' || replace(gen_random_uuid()::text, '-', '');
  v_jename TEXT;
BEGIN
  SELECT COUNT(*) INTO v_pcount FROM "Product" WHERE "internalRef" = 'PGC';
  IF v_pcount <> 1 THEN
    INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
    VALUES ('al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'UPDATE', 'stock-move', 'pgc-test-order',
            '补扣 Pepper Green 测试单：internalRef=PGC 的商品有 ' || v_pcount || ' 个，未自动处理', NOW());
    RETURN;
  END IF;
  SELECT id, name, type::text, "standardPrice" INTO v_pid, v_pname, v_ptype, v_cost FROM "Product" WHERE "internalRef" = 'PGC';
  IF v_ptype <> 'PRODUCT' THEN RETURN; END IF;

  -- 已经补过（重复执行）就不再扣
  IF EXISTS (SELECT 1 FROM "StockMove" WHERE "productId" = v_pid AND note LIKE '%20261015 补扣测试单%') THEN RETURN; END IF;

  SELECT COUNT(*), string_agg(COALESCE(o.code, o.id), '、') INTO v_cnt, v_codes
  FROM "Order" o
  WHERE o.status IN ('COMPLETED', 'LOCKED')
    AND o."createdAt" >= '2026-10-13 00:00:00' AND o."createdAt" < '2026-10-15 02:54:00'
    AND EXISTS (SELECT 1 FROM "OrderLine" l WHERE l."orderId" = o.id AND l."productId" = v_pid AND l."orderedQty" > 0)
    AND NOT EXISTS (SELECT 1 FROM "StockMove" m WHERE m."sourceId" = o.id AND m."sourceType" IN ('ORDER', 'SO'));

  IF v_cnt <> 1 THEN
    INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
    VALUES ('al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'UPDATE', 'product', v_pid,
            '补扣 Pepper Green 测试单：找到 ' || v_cnt || ' 张候选单（' || COALESCE(v_codes, '无') || '），不是恰好 1 张，未自动扣减，请告知要扣哪一张', NOW());
    RETURN;
  END IF;

  SELECT o.id, COALESCE(o.code, o.id), o."restaurantId" INTO v_oid, v_ocode, v_partner
  FROM "Order" o
  WHERE o.status IN ('COMPLETED', 'LOCKED')
    AND o."createdAt" >= '2026-10-13 00:00:00' AND o."createdAt" < '2026-10-15 02:54:00'
    AND EXISTS (SELECT 1 FROM "OrderLine" l WHERE l."orderId" = o.id AND l."productId" = v_pid AND l."orderedQty" > 0)
    AND NOT EXISTS (SELECT 1 FROM "StockMove" m WHERE m."sourceId" = o.id AND m."sourceType" IN ('ORDER', 'SO'));

  FOR v_line IN
    SELECT l.id, l."orderedQty", l."uomId",
           COALESCE((SELECT NULLIF(su.factor, 0) FROM "ProductSaleUom" su
                     WHERE su."productId" = v_pid AND su."uomId" = l."uomId" AND su.active LIMIT 1), 1) AS factor
    FROM "OrderLine" l WHERE l."orderId" = v_oid AND l."productId" = v_pid AND l."orderedQty" > 0
  LOOP
    v_qty := ROUND(v_line."orderedQty" * v_line.factor, 3);
    INSERT INTO "StockMove" (id, "productId", "productName", type, qty, note, "sourceType", "sourceId", "sourceRef",
                             "movedAt", "createdAt", "fromLocationId", "toLocationId", "orderLineId", "uomQty", "uomId",
                             "unitCost", value, "partnerId", "createdBy")
    VALUES ('smo' || replace(gen_random_uuid()::text, '-', ''), v_pid, v_pname, 'OUT', -v_qty,
            '订单 ' || v_ocode || ' 20261015 补扣测试单：修复前完成未扣库存（客户确认）', 'ORDER', v_oid, v_ocode,
            NOW(), NOW(), 'loc_wh_stock', 'loc_partner_customers', v_line.id, v_line."orderedQty", v_line."uomId",
            v_cost, ROUND(v_qty * COALESCE(v_cost, 0), 2), v_partner, 'System');
    v_total := v_total + v_qty;
  END LOOP;

  UPDATE "Product" SET "qtyOnHand" = "qtyOnHand" - v_total WHERE id = v_pid;

  -- 存货估值凭证 Dr 5100 / Cr 1300
  v_value := ROUND(v_total * COALESCE(v_cost, 0), 2);
  SELECT id INTO v_inv FROM "Account" WHERE code = '1300';
  SELECT id INTO v_cogs FROM "Account" WHERE code = '5100';
  IF v_value > 0 AND v_inv IS NOT NULL AND v_cogs IS NOT NULL THEN
    SELECT 'JE-' || lpad((COALESCE(MAX(NULLIF(regexp_replace(name, '^JE-', ''), '')::INT), 0) + 1)::text, 5, '0') INTO v_jename
      FROM "JournalEntry" WHERE name ~ '^JE-[0-9]+$';
    INSERT INTO "JournalEntry" (id, name, date, narration, "sourceType", "sourceId", status, "totalDebit", "totalCredit", "createdBy", "postedAt", "createdAt")
    VALUES (v_entry, v_jename, NOW(), 'COGS - ' || v_pname || ' (' || v_ocode || ', 20261015 test order deduction)', 'stock_move', v_oid,
            'POSTED', v_value, v_value, 'system', NOW(), NOW());
    INSERT INTO "JournalEntryLine" (id, "entryId", "accountId", description, debit, credit, sequence) VALUES
      ('jl' || replace(gen_random_uuid()::text, '-', ''), v_entry, v_cogs, 'COGS - ' || v_pname || ' (' || v_ocode || ')', v_value, 0, 10),
      ('jl' || replace(gen_random_uuid()::text, '-', ''), v_entry, v_inv, 'COGS - ' || v_pname || ' (' || v_ocode || ')', 0, v_value, 20);
  END IF;

  INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
  VALUES ('al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'UPDATE', 'product', v_pid,
          '补扣测试单 ' || v_ocode || '：Pepper Green 在手量 −' || v_total || '（修复前该单走完流程未扣库存；客户 20261015 确认只扣这张）', NOW());
END $$;
