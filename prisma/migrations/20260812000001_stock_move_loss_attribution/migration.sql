-- 损耗归因（台账 E4）：把「环节」与「原因」从 note 拼接串里提出来变成结构化列。
--
-- 为什么必须结构化：损耗看板原先用正则从 StockMove.note 里反解原因
-- （lib/analytics/loss-dashboard.ts 的 parseReasonLabel），任何人改一下写入时的
-- 文案措辞，看板就会静默把它归成一个新的「原因」，而且没有任何报错。
-- 环节（分拣/运输/仓储）则完全无从统计 —— 需求要的正是按环节归因。
--
-- 历史行保持 NULL：不猜。看板对 NULL 行按原因反推出一个「推断环节」并标注出来，
-- 而不是就地回填一个假的确定值（回填之后就再也分不清哪些是真填的）。
ALTER TABLE "StockMove" ADD COLUMN IF NOT EXISTS "lossStage" TEXT;
ALTER TABLE "StockMove" ADD COLUMN IF NOT EXISTS "lossReason" TEXT;
CREATE INDEX IF NOT EXISTS "StockMove_lossStage_idx" ON "StockMove"("lossStage");
