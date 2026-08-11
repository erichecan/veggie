-- ============================================================================
-- Order.source：区分「餐厅自助提交」与「业务员代下」
-- ============================================================================
-- 在这之前两者在列表页长得一模一样，来源只埋在
-- OrderAuditLog.changedFields.source 里，列表页够不着。
--
-- 安全性：
--   · 新列带默认值 INTERNAL，加列不破坏任何历史数据
--   · 回填只针对**有确凿证据**的门户单（审计日志里明确记了 customer-portal），
--     其余一律留在默认值。不按「创建者是不是餐厅账号」之类的启发式去猜 ——
--     猜错会让「这单是客户自己下的」这句话失去可信度，而这正是本字段的全部价值
-- ============================================================================

CREATE TYPE "OrderSource" AS ENUM ('PORTAL', 'INTERNAL', 'IMPORT');

ALTER TABLE "Order" ADD COLUMN "source" "OrderSource" NOT NULL DEFAULT 'INTERNAL';

-- 回填：审计日志里明确记录了来自客户门户的订单
UPDATE "Order" o
SET "source" = 'PORTAL'
FROM "OrderAuditLog" l
WHERE l."orderId" = o.id
  AND l."action" = 'created'
  AND l."changedFields"->>'source' = 'customer-portal';

-- 列表页按来源筛选走这个索引
CREATE INDEX "Order_source_idx" ON "Order"("source");
