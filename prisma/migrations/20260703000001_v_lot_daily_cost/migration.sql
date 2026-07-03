-- 商品 × 日 加权平均批次成本视图（毛利/损耗计算用）
-- 口径：按 Lot.arrivedAt 归日，initialQty 加权；无 unitCost 的批次不参与
CREATE OR REPLACE VIEW v_lot_daily_cost AS
SELECT
    "productId"                                    AS product_id,
    (date_trunc('day', "arrivedAt"))::date         AS cost_date,
    SUM("initialQty" * "unitCost") / NULLIF(SUM("initialQty"), 0) AS unit_cost,
    SUM("initialQty")                              AS total_qty
FROM "Lot"
WHERE "unitCost" IS NOT NULL
GROUP BY "productId", (date_trunc('day', "arrivedAt"))::date;
