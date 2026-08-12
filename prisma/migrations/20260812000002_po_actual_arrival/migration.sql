-- 采购单实际到货日（台账 E7）
--
-- 存**两个**日期而不是一个，因为它们回答的是两个问题，而且都是免费维护的：
--   firstArrivedAt = 首次到货 → 供应商有没有按期「开始」交付
--   lastArrivedAt  = 最近一次到货 → 分批收齐的完成日
-- 准时率按 lastArrivedAt（收齐日）对比 expectedDate，且只统计**已收齐**的单
-- （未收齐的若算进分母，一张永远收不齐的单会被静默算成准时）。
-- 客户日后若要改用「首次到货」口径，数据已经在了，不用回头补。
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "firstArrivedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "lastArrivedAt" TIMESTAMP(3);

-- 存量回填：完全由已有的收货单派生，确定且幂等，重复执行结果相同。
-- 不猜、不用创建时间顶替 —— 没有收货单的采购单就保持 NULL。
UPDATE "PurchaseOrder" po
SET "firstArrivedAt" = gr.first_at,
    "lastArrivedAt"  = gr.last_at
FROM (
  SELECT "purchaseOrderId" AS po_id, MIN("arrivedAt") AS first_at, MAX("arrivedAt") AS last_at
  FROM "GoodsReceipt" GROUP BY "purchaseOrderId"
) gr
WHERE gr.po_id = po.id
  AND (po."firstArrivedAt" IS DISTINCT FROM gr.first_at OR po."lastArrivedAt" IS DISTINCT FROM gr.last_at);
