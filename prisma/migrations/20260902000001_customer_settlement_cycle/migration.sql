-- 客户对账单生成周期（20260902）
--
-- 财务中心补全第一步：给客户加一个结算周期标记，供定时任务
-- （POST /api/cron/generate-statements）按周期批量生成对账单。
-- 值域 NONE | WEEKLY | MONTHLY，应用层校验，风格同现有 Customer.priceType 字段，
-- 不建数据库 CHECK 约束。默认 NONE：存量客户不会被定时任务纳入，需手动开启。
ALTER TABLE "Customer" ADD COLUMN "settlementCycle" TEXT NOT NULL DEFAULT 'NONE';
