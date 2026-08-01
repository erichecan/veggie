-- 数据库备份任务记录表
CREATE TABLE "BackupJob" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "triggerType" TEXT NOT NULL,
    "triggeredBy" TEXT,
    "gcsPath" TEXT,
    "sizeBytes" INTEGER,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BackupJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BackupJob_status_idx" ON "BackupJob"("status");
CREATE INDEX "BackupJob_startedAt_idx" ON "BackupJob"("startedAt");
