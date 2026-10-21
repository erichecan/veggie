-- 20261021 作废测试采购单 PO-00224（客户 20261020：「直接作废 PO-00224」；20261021 再次提出「这个问题还没有解决」）
-- ============================================================================
-- 背景（docs/20261014-veggie-deploy-log.md 第七批）：TEST VENDOR 的测试单，Mushroom 订购 50 箱 @€5，
-- 收货误填 500 被直接收下，再退 450 时旧逻辑把下单数量减成 0、金额 €0。代码已在 #46 修复，
-- 但这张单的数据停在：下单 0、已收 50（流水里净入库 50）、草稿账单 VB-00213 €250。
--
-- 应用里的「取消」对已收过货的单会拒绝（取消不回退库存），这里按「先退回剩余已收、再取消」一次做完：
--   1. 每行把流水里净入库的量退回供应商：流水「仓库 → 供应商」，先扣这张单自己的批次，
--      在手量同步减少，出凭证 Dr 2150 已收货未开票 / Cr 1300 存货（按收货时的单位成本）；
--   2. 行已收量清 0，采购单 → CANCELLED；草稿账单 → CANCELLED；
--   3. 商品平均成本：这张单确认之后该商品没有别的采购收货、也没有别的采购单确认，才恢复为确认前的成本；
--      否则不动，只在日志里写明请人工核对。
-- 只在完全明确时动手：PO-00224 恰好 1 张、供应商名以 TEST VENDOR 开头、未取消、没有已过账/已付账单；
-- 否则一个数都不改，只在采购单操作日志里写原因。重复执行无副作用（已取消就直接返回）。
DO $$
DECLARE
  v_cnt INT;
  v_po RECORD;
  v_supplier TEXT;
  v_line RECORD;
  v_net NUMERIC;
  v_left NUMERIC;
  v_take NUMERIC;
  v_cost NUMERIC;
  v_lot RECORD;
  v_value NUMERIC;
  v_total_value NUMERIC := 0;
  v_detail TEXT := '';
  v_inv TEXT;
  v_grni TEXT;
  v_entry TEXT;
  v_jename TEXT;
  v_other INT;
  v_bills TEXT;
BEGIN
  SELECT COUNT(*) INTO v_cnt FROM "PurchaseOrder" WHERE name = 'PO-00224';
  IF v_cnt <> 1 THEN RETURN; END IF;
  SELECT * INTO v_po FROM "PurchaseOrder" WHERE name = 'PO-00224';
  IF v_po.status::text = 'CANCELLED' THEN RETURN; END IF;

  SELECT name INTO v_supplier FROM "Customer" WHERE id = v_po."supplierId";
  IF v_supplier IS NULL OR v_supplier NOT ILIKE 'TEST VENDOR%' THEN
    INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
    VALUES ('al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'UPDATE', 'purchase_order', v_po.id,
            '作废 PO-00224：供应商是「' || COALESCE(v_supplier, '?') || '」，不是 TEST VENDOR 测试单，未自动作废', NOW());
    RETURN;
  END IF;

  SELECT string_agg(name || '(' || status::text || ')', '、') INTO v_bills
    FROM "VendorBill" WHERE "purchaseOrderId" = v_po.id AND status::text IN ('POSTED', 'PAID');
  IF v_bills IS NOT NULL THEN
    INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
    VALUES ('al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'UPDATE', 'purchase_order', v_po.id,
            '作废 PO-00224：已有已过账/已付账单 ' || v_bills || '，需财务先处理，未自动作废', NOW());
    RETURN;
  END IF;

  SELECT id INTO v_inv FROM "Account" WHERE code = '1300';
  SELECT id INTO v_grni FROM "Account" WHERE code = '2150';

  FOR v_line IN SELECT * FROM "PurchaseOrderLine" WHERE "purchaseOrderId" = v_po.id LOOP
    -- 流水里这一行净入库的量（基础单位）：收货为正、退货为负
    SELECT COALESCE(SUM(qty), 0) INTO v_net FROM "StockMove"
      WHERE "purchaseOrderLineId" = v_line.id AND "sourceType" IN ('PURCHASE_RECEIVE', 'PURCHASE_RETURN');
    IF v_net > 0.0005 THEN
      SELECT "unitCost" INTO v_cost FROM "StockMove"
        WHERE "purchaseOrderLineId" = v_line.id AND "sourceType" = 'PURCHASE_RECEIVE' AND "unitCost" IS NOT NULL
        ORDER BY "createdAt" LIMIT 1;
      v_left := v_net;
      -- 先扣这张单自己收进来的批次，流水挂批次（批次余量 = Σ 批次流水）
      FOR v_lot IN SELECT id, "currentQty" FROM "Lot"
                    WHERE "sourceId" = v_po.id AND "productId" = v_line."productId" AND "currentQty" > 0
                    ORDER BY "createdAt" LOOP
        EXIT WHEN v_left <= 0.0005;
        v_take := LEAST(v_left, v_lot."currentQty");
        UPDATE "Lot" SET "currentQty" = "currentQty" - v_take WHERE id = v_lot.id;
        INSERT INTO "StockMove" (id, "productId", "productName", type, qty, note, "sourceType", "sourceId", "sourceRef",
                                 "movedAt", "createdAt", "fromLocationId", "toLocationId", "lotId", "purchaseOrderLineId",
                                 "uomId", "unitCost", value, "partnerId", "createdBy")
        VALUES ('smv' || replace(gen_random_uuid()::text, '-', ''), v_line."productId", v_line."productName", 'OUT', -v_take,
                '采购退货 PO PO-00224 - 20261021 作废测试单（客户确认）', 'PURCHASE_RETURN', v_po.id, v_po.name,
                NOW(), NOW(), 'loc_wh_stock', 'loc_partner_vendors', v_lot.id, v_line.id,
                v_line."uomId", v_cost, ROUND(v_take * COALESCE(v_cost, 0), 2), v_po."supplierId", 'System');
        v_left := v_left - v_take;
      END LOOP;
      IF v_left > 0.0005 THEN
        INSERT INTO "StockMove" (id, "productId", "productName", type, qty, note, "sourceType", "sourceId", "sourceRef",
                                 "movedAt", "createdAt", "fromLocationId", "toLocationId", "purchaseOrderLineId",
                                 "uomId", "unitCost", value, "partnerId", "createdBy")
        VALUES ('smv' || replace(gen_random_uuid()::text, '-', ''), v_line."productId", v_line."productName", 'OUT', -v_left,
                '采购退货 PO PO-00224 - 20261021 作废测试单（客户确认）', 'PURCHASE_RETURN', v_po.id, v_po.name,
                NOW(), NOW(), 'loc_wh_stock', 'loc_partner_vendors', v_line.id,
                v_line."uomId", v_cost, ROUND(v_left * COALESCE(v_cost, 0), 2), v_po."supplierId", 'System');
      END IF;
      UPDATE "Product" SET "qtyOnHand" = "qtyOnHand" - v_net WHERE id = v_line."productId";
      v_value := ROUND(v_net * COALESCE(v_cost, 0), 2);
      v_total_value := v_total_value + v_value;
      v_detail := v_detail || v_line."productName" || ' 退回 ' || v_net || '（€' || v_value || '）；';
    END IF;

    -- 平均成本：确认之后该商品没有别的收货 / 别的采购单确认，才恢复为确认前的成本
    IF v_line."standardPriceBeforeConfirmEur" IS NOT NULL THEN
      SELECT COUNT(*) INTO v_other FROM "StockMove" m
        WHERE m."productId" = v_line."productId" AND m."sourceType" = 'PURCHASE_RECEIVE'
          AND m."sourceId" <> v_po.id AND m."createdAt" > COALESCE(v_po."confirmedAt", v_po."createdAt");
      SELECT v_other + COUNT(*) INTO v_other FROM "PurchaseOrderLine" l JOIN "PurchaseOrder" p ON p.id = l."purchaseOrderId"
        WHERE l."productId" = v_line."productId" AND p.id <> v_po.id
          AND p."confirmedAt" > COALESCE(v_po."confirmedAt", v_po."createdAt");
      IF v_other = 0 THEN
        UPDATE "Product" SET "standardPrice" = v_line."standardPriceBeforeConfirmEur" WHERE id = v_line."productId";
        v_detail := v_detail || v_line."productName" || ' 平均成本恢复为确认前的 €' || v_line."standardPriceBeforeConfirmEur" || '；';
      ELSE
        v_detail := v_detail || v_line."productName" || ' 平均成本此后被别的采购改过，未恢复，请人工核对（确认前为 €'
                    || v_line."standardPriceBeforeConfirmEur" || '）；';
      END IF;
    END IF;
  END LOOP;

  -- 存货估值凭证 Dr 2150 / Cr 1300（冲回收货时剩下的那部分暂估）
  IF v_total_value > 0 AND v_inv IS NOT NULL AND v_grni IS NOT NULL THEN
    v_entry := 'je' || replace(gen_random_uuid()::text, '-', '');
    SELECT 'JE-' || lpad((COALESCE(MAX(NULLIF(regexp_replace(name, '^JE-', ''), '')::INT), 0) + 1)::text, 5, '0') INTO v_jename
      FROM "JournalEntry" WHERE name ~ '^JE-[0-9]+$';
    INSERT INTO "JournalEntry" (id, name, date, narration, "sourceType", "sourceId", status, "totalDebit", "totalCredit", "createdBy", "postedAt", "createdAt")
    VALUES (v_entry, v_jename, NOW(), 'Receipt - PO-00224 voided test order (20261021)', 'stock_move', v_po.id,
            'POSTED', v_total_value, v_total_value, 'system', NOW(), NOW());
    INSERT INTO "JournalEntryLine" (id, "entryId", "accountId", description, debit, credit, "partnerId", sequence) VALUES
      ('jl' || replace(gen_random_uuid()::text, '-', ''), v_entry, v_grni, 'Receipt - PO-00224 voided', v_total_value, 0, v_po."supplierId", 10),
      ('jl' || replace(gen_random_uuid()::text, '-', ''), v_entry, v_inv, 'Receipt - PO-00224 voided', 0, v_total_value, NULL, 20);
  END IF;

  UPDATE "PurchaseOrderLine" SET "receivedQty" = 0 WHERE "purchaseOrderId" = v_po.id;
  UPDATE "PurchaseOrder" SET status = 'CANCELLED', "cancelledAt" = NOW() WHERE id = v_po.id;

  SELECT string_agg(name, '、') INTO v_bills FROM "VendorBill" WHERE "purchaseOrderId" = v_po.id AND status::text = 'DRAFT';
  IF v_bills IS NOT NULL THEN
    INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
    SELECT 'al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'UPDATE', 'vendor_bill', id,
           name || ': 状态 DRAFT → CANCELLED（采购单 PO-00224 作废测试单，客户确认）', NOW()
      FROM "VendorBill" WHERE "purchaseOrderId" = v_po.id AND status::text = 'DRAFT';
    UPDATE "VendorBill" SET status = 'CANCELLED' WHERE "purchaseOrderId" = v_po.id AND status::text = 'DRAFT';
  END IF;

  INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
  VALUES ('al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'UPDATE', 'purchase_order', v_po.id,
          '作废测试单 PO-00224（客户确认）：' || v_detail || '采购单 → CANCELLED' ||
          CASE WHEN v_bills IS NOT NULL THEN '，草稿账单 ' || v_bills || ' → CANCELLED' ELSE '' END, NOW());
END $$;
