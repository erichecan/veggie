-- ============================================================================
-- AI 问数（数据分析聊天中台）20260906：提问日志 + 常用报表
-- ============================================================================

BEGIN;

CREATE TABLE "AnalysisQueryLog" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "rawQuestion" TEXT NOT NULL,
  "dsl" JSONB,
  "confirmedParams" JSONB,
  "status" TEXT NOT NULL,
  "rowCount" INTEGER,
  "durationMs" INTEGER,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AnalysisQueryLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AnalysisQueryLog_userId_idx" ON "AnalysisQueryLog"("userId");
CREATE INDEX "AnalysisQueryLog_createdAt_idx" ON "AnalysisQueryLog"("createdAt");
CREATE INDEX "AnalysisQueryLog_status_idx" ON "AnalysisQueryLog"("status");

ALTER TABLE "AnalysisQueryLog" ADD CONSTRAINT "AnalysisQueryLog_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SavedAnalysisReport" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "dsl" JSONB NOT NULL,
  "useCount" INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SavedAnalysisReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SavedAnalysisReport_userId_name_key" ON "SavedAnalysisReport"("userId", "name");
CREATE INDEX "SavedAnalysisReport_userId_idx" ON "SavedAnalysisReport"("userId");

ALTER TABLE "SavedAnalysisReport" ADD CONSTRAINT "SavedAnalysisReport_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
