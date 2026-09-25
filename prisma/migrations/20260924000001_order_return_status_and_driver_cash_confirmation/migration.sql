-- 会计核销重构（2026-09-24）：把 Order.orderReturn 这个布尔字段换成三态枚举，
-- 加一张「司机收款确认」表。三步都在同一个迁移文件里做完（加列→回填→删旧列），
-- 不拆成两个迁移——20260825 的教训：跨迁移的回填背靠背执行会把数据永久丢光。

-- 1. 新枚举 + 新列（先允许 NULL，回填完再收紧）
CREATE TYPE "OrderReturnStatus" AS ENUM ('PENDING', 'RETURNED', 'ISSUE');

ALTER TABLE "Order" ADD COLUMN "returnStatus" "OrderReturnStatus";
ALTER TABLE "Order" ADD COLUMN "returnIssueNote" TEXT;

-- 2. 用旧列回填新列：true → RETURNED，false/NULL → PENDING
UPDATE "Order" SET "returnStatus" = CASE WHEN "orderReturn" THEN 'RETURNED' ELSE 'PENDING' END::"OrderReturnStatus";

-- 3. 收紧非空约束 + 默认值，删掉旧列
ALTER TABLE "Order" ALTER COLUMN "returnStatus" SET NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "returnStatus" SET DEFAULT 'PENDING';
ALTER TABLE "Order" DROP COLUMN "orderReturn";

-- 4. 新表：司机收款确认（会计核销页「钱」板块）
CREATE TABLE "DriverCashConfirmation" (
    "id" TEXT NOT NULL,
    "driverName" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "cashTotal" DECIMAL(12,2) NOT NULL,
    "transferTotal" DECIMAL(12,2) NOT NULL,
    "orderIds" TEXT[],
    "paymentIds" TEXT[],
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedById" TEXT NOT NULL,
    "confirmedByName" TEXT NOT NULL,

    CONSTRAINT "DriverCashConfirmation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DriverCashConfirmation_driverName_businessDate_key" ON "DriverCashConfirmation"("driverName", "businessDate");
CREATE INDEX "DriverCashConfirmation_businessDate_idx" ON "DriverCashConfirmation"("businessDate");
