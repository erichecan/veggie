-- 司机每日回传（台账 C8）
--
-- 只存「提交那一刻的快照」，不是这四个数字的真相 —— 真相仍在 Trip 上，查询时实时派生。
-- 提交之后行程被改（退货审核、补录收款），快照与实时值就会不一样，那个差额正是对账
-- 要看见的东西。与 H3 的「冻结提成 vs 重算提成」同一个模式。

CREATE TABLE "DriverDailyReport" (
  "id"              TEXT NOT NULL,
  "driverId"        TEXT NOT NULL,
  "reportDate"      DATE NOT NULL,
  "cashCollected"   DECIMAL(12,2) NOT NULL,
  "orderTotal"      DECIMAL(12,2) NOT NULL,
  "returnCount"     INTEGER NOT NULL,
  "exchangeCount"   INTEGER NOT NULL,
  "tripIds"         TEXT[],
  "note"            TEXT,
  "status"          TEXT NOT NULL DEFAULT 'submitted',
  "submittedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submittedById"   TEXT NOT NULL,
  "submittedByName" TEXT NOT NULL,
  "confirmedAt"     TIMESTAMP(3),
  "confirmedById"   TEXT,
  "confirmedByName" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DriverDailyReport_pkey" PRIMARY KEY ("id")
);

-- ⛔ 防重复提交靠数据库唯一约束，不靠应用层先查后写 ——
-- 后者在并发下必然漏（G2 的分批付款就是这么丢过钱的）
CREATE UNIQUE INDEX "DriverDailyReport_driverId_reportDate_key"
  ON "DriverDailyReport"("driverId", "reportDate");
CREATE INDEX "DriverDailyReport_reportDate_idx" ON "DriverDailyReport"("reportDate");
CREATE INDEX "DriverDailyReport_status_idx" ON "DriverDailyReport"("status");

ALTER TABLE "DriverDailyReport"
  ADD CONSTRAINT "DriverDailyReport_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
