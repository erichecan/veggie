-- 20261022 PO-00224 的退货流水挪回它自己的批次（客户 20261022：「50 箱 Mushroom 误收成 500 箱进了 LOT-01106，
-- 退 450 箱应该也是从 LOT-01106 里退，不是先退旧的批次 LOT-01105」）
-- ============================================================================
-- 当时的采购退货按 FEFO 扣批次（代码已改为先扣这张单自己收进来的批次，见 lib/inventory.ts consumeLotsPreferring），
-- 那 450 箱扣到了更早的、别的采购单收进来的批次上：那些批次余量被凭空扣掉，PO-00224 自己的批次反倒留着
-- 实际早已退回供应商的余量。商品总在手量是对的，错的只是「扣在了哪个批次」。
--
-- 这里只做批次层面的改挂，数量、金额、凭证一概不动：
--   对 PO-00224 每一笔挂在「非本单批次」上的退货流水，把它（或其中一部分）改挂到本单批次上——
--   本单批次余量减少、原先被误扣的批次余量加回，批次余量 = Σ 批次流水 的关系保持不变。
--   本单批次余量不够（这批货后来真被卖掉了一部分）就只改挂够的那部分，其余照旧，在日志里写明。
-- 防护：PO-00224 恰好 1 张、供应商名以 TEST VENDOR 开头，否则一个数都不改。重复执行无副作用
-- （改挂完就没有挂在别的批次上的退货流水了）。
DO $$
DECLARE
  v_cnt INT;
  v_po RECORD;
  v_supplier TEXT;
  v_m RECORD;
  v_own RECORD;
  v_orig NUMERIC;
  v_left NUMERIC;
  v_take NUMERIC;
  v_whole BOOLEAN;
  v_from_lot TEXT;
  v_to_lot TEXT;
  v_detail TEXT := '';
  v_moved NUMERIC := 0;
BEGIN
  SELECT COUNT(*) INTO v_cnt FROM "PurchaseOrder" WHERE name = 'PO-00224';
  IF v_cnt <> 1 THEN RETURN; END IF;
  SELECT * INTO v_po FROM "PurchaseOrder" WHERE name = 'PO-00224';
  SELECT name INTO v_supplier FROM "Customer" WHERE id = v_po."supplierId";
  IF v_supplier IS NULL OR v_supplier NOT ILIKE 'TEST VENDOR%' THEN RETURN; END IF;

  FOR v_m IN SELECT m.* FROM "StockMove" m
              WHERE m."sourceId" = v_po.id AND m."sourceType" = 'PURCHASE_RETURN'
                AND m.qty < 0 AND m."lotId" IS NOT NULL
                AND m."lotId" NOT IN (SELECT id FROM "Lot" WHERE "sourceId" = v_po.id)
              ORDER BY m."createdAt" LOOP
    v_orig := -v_m.qty;
    v_left := v_orig;
    SELECT "lotNumber" INTO v_from_lot FROM "Lot" WHERE id = v_m."lotId";
    FOR v_own IN SELECT id, "lotNumber", "currentQty" FROM "Lot"
                  WHERE "sourceId" = v_po.id AND "productId" = v_m."productId" AND "currentQty" > 0
                  ORDER BY "arrivedAt" DESC, "createdAt" DESC LOOP
      EXIT WHEN v_left <= 0.0005;
      v_take := LEAST(v_left, v_own."currentQty");
      v_whole := (v_take = v_orig);
      v_to_lot := v_own."lotNumber";

      UPDATE "Lot" SET "currentQty" = "currentQty" - v_take,
                       status = CASE WHEN "currentQty" - v_take <= 0 THEN 'DEPLETED' ELSE status END
        WHERE id = v_own.id;
      UPDATE "Lot" SET "currentQty" = "currentQty" + v_take, status = 'AVAILABLE'
        WHERE id = v_m."lotId";

      IF v_whole THEN
        UPDATE "StockMove" SET "lotId" = v_own.id WHERE id = v_m.id;
      ELSE
        -- 拆成两笔：原流水留下没改挂的部分，新流水挂本单批次（业务单位数量、金额按比例拆）
        INSERT INTO "StockMove" (id, "productId", "productName", type, qty, note, "sourceType", "sourceId", "sourceRef",
                                 "lotId", "lossStage", "lossReason", "movedAt", "createdAt", "createdBy", "fromLocationId",
                                 "orderLineId", "partnerId", "purchaseOrderLineId", "toLocationId", "unitCost", "uomId",
                                 "uomQty", value)
        SELECT 'smv' || replace(gen_random_uuid()::text, '-', ''), "productId", "productName", type, -v_take, note,
               "sourceType", "sourceId", "sourceRef", v_own.id, "lossStage", "lossReason", "movedAt", "createdAt",
               "createdBy", "fromLocationId", "orderLineId", "partnerId", "purchaseOrderLineId", "toLocationId",
               "unitCost", "uomId",
               CASE WHEN "uomQty" IS NULL THEN NULL ELSE ROUND("uomQty" * v_take / v_orig, 3) END,
               CASE WHEN "unitCost" IS NULL THEN NULL ELSE ROUND(v_take * "unitCost", 2) END
          FROM "StockMove" WHERE id = v_m.id;
        UPDATE "StockMove"
           SET qty = qty + v_take,
               "uomQty" = CASE WHEN "uomQty" IS NULL THEN NULL ELSE ROUND("uomQty" - "uomQty" * v_take / v_orig, 3) END,
               value = CASE WHEN "unitCost" IS NULL THEN NULL ELSE ROUND((-(qty + v_take)) * "unitCost", 2) END
         WHERE id = v_m.id;
        -- 后续再拆按剩下的量算比例
        v_orig := v_orig - v_take;
      END IF;

      v_left := v_left - v_take;
      v_moved := v_moved + v_take;
      v_detail := v_detail || v_m."productName" || ' ' || v_take || ' 从 ' || COALESCE(v_from_lot, '?') || ' 改挂到 ' || v_to_lot || '；';
    END LOOP;
    IF v_left > 0.0005 THEN
      v_detail := v_detail || v_m."productName" || ' 还有 ' || v_left || ' 留在 ' || COALESCE(v_from_lot, '?')
                  || '（本单批次余量不够，这批货已被出库用掉一部分），请人工核对；';
    END IF;
  END LOOP;

  IF v_detail <> '' THEN
    INSERT INTO "ActionLog" (id, "userId", "userEmail", "userName", action, resource, "resourceId", detail, "createdAt")
    VALUES ('al' || replace(gen_random_uuid()::text, '-', ''), 'system', 'system', 'System', 'UPDATE', 'purchase_order', v_po.id,
            'PO-00224 退货流水改挂回本单批次（客户确认，数量/金额/凭证不变）：' || v_detail, NOW());
  END IF;
END $$;
