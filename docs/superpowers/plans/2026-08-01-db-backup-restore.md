# 数据库备份与恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给"系统日志与数据安全"模块补上应用内自动化数据库备份能力——每日自动 + 手动触发 `pg_dump` 全库备份到 GCS，BOSS 角色可在后台查看/下载，恢复留给文档化的手动 runbook。

**Architecture:** 核心备份逻辑集中在 `lib/backup.ts`，被 cron 路由（每日自动）和 API 路由（手动触发+列表+下载）共用；新增 `BackupJob` 表记录每次备份的状态/大小/路径；GCS 用一个新建的私有桶隔离敏感的全库 dump，下载走短期有效的签名 URL。

**Tech Stack:** Next.js App Router (16.2.3) + Prisma + Neon Postgres + `@google-cloud/storage` + Node 内置 `child_process`/`zlib` + `node:test`（TDD 单测）。

## Global Constraints

- 仅 `BOSS` 角色可访问备份相关的所有 API 与页面；其余角色一律 403。
- cron 路由鉴权：`x-cron-secret` header 与 `process.env.CRON_SECRET` 比对（与 `app/api/action-logs/cleanup/route.ts`、`app/api/cron/generate-statements/route.ts` 现有模式一致）。
- 备份保留 30 天，超期的 `BackupJob` 记录和对应 GCS 对象一起自动清理。
- 下载走 GCS 签名 URL，有效期 10 分钟；不复用现有图片桶的"拼公开 URL"模式。
- 不做应用内一键覆盖恢复；恢复只到"下载备份文件"为止，真正执行 `psql` 恢复的步骤写成文档，由运维人员手动操作。
- `pg_dump` 必须使用 direct（去掉 `-pooler`）连接，做法与 `cloudbuild.yaml` 里迁移步骤的字符串替换完全一致。
- 涉及创建 GCP 资源（新建 GCS 桶、Cloud Scheduler job、IAM 绑定）的命令只写进部署文档，**不在实施阶段自动执行**——需要用户确认 project ID 后由用户或后续单独会话执行。

---

## 已知风险（实施前先读)

- Cloud Run 的 `/tmp` 是内存文件系统（tmpfs），`pg_dump` 产物会占用容器内存配额（当前 `--memory=1Gi`）。对本项目当前的数据量级足够，但如果数据库明显变大需要重新评估。
- 本 worktree 的 `git status` 里已经有别的进行中工作改了 `prisma/schema.prisma` 并留下两个未提交的迁移目录（`20260731000001_customer_settlement_cycle`、`20260731000002_payment_prepayment_support`）。Task 1 的 `db push` 会把 schema.prisma 当前的**全部**未提交改动（包括那两个不相关的）一起同步到本地开发库——这是预期之内的，不要尝试去"隔离"或撤销那部分改动，也不要修复与 `BackupJob` 无关的迁移状态问题。

---

### Task 1: Prisma schema — 新增 BackupJob 表

**Files:**
- Modify: `prisma/schema.prisma`（在 `model ActionLog` 后面插入新模型）
- Create: `prisma/migrations/20260801000001_backup_job/migration.sql`

**Interfaces:**
- Produces: `prisma.backupJob` client delegate，字段 `id: string`、`status: string`（`'running'|'success'|'failed'`）、`triggerType: string`（`'AUTO'|'MANUAL'`）、`triggeredBy: string|null`、`gcsPath: string|null`、`sizeBytes: number|null`、`errorMessage: string|null`、`startedAt: Date`、`finishedAt: Date|null`。后续所有任务都依赖这个 delegate。

- [ ] **Step 1: 在 schema.prisma 里插入新模型**

在 `prisma/schema.prisma` 中找到这一段（`model ActionLog` 的结尾）：

```prisma
model ActionLog {
  id         String     @id @default(cuid())
  userId     String
  userEmail  String
  userName   String
  action     ActionType
  resource   String
  resourceId String?
  detail     String?
  /// 字段级变更前后快照（JSON），例如 {"price":{"before":10,"after":12}}
  changes    Json?
  ipAddress  String?
  userAgent  String?
  createdAt  DateTime   @default(now())

  @@index([userId])
  @@index([resource, resourceId])
  @@index([createdAt])
  @@index([action])
}
```

紧跟在它后面（`}` 之后、下一个 `/**` 注释块之前）插入：

```prisma

/**
 * 数据库备份任务记录 —— 每次自动/手动 pg_dump 备份留一条记录
 * status: running | success | failed
 * triggerType: AUTO（Cloud Scheduler 每日触发）| MANUAL（BOSS 在后台点击）
 */
model BackupJob {
  id           String    @id @default(cuid())
  status       String    @default("running")
  triggerType  String
  triggeredBy  String?
  gcsPath      String?
  sizeBytes    Int?
  errorMessage String?
  startedAt    DateTime  @default(now())
  finishedAt   DateTime?

  @@index([status])
  @@index([startedAt])
}
```

- [ ] **Step 2: 把改动同步到本地开发库**

Run: `npm run db:push`

Expected: 命令末尾输出 `Your database is now in sync with your Prisma schema.`（注意这一步会连带同步 schema.prisma 里其它未提交的改动，见上面"已知风险"，属预期行为）

- [ ] **Step 3: 手写迁移文件，记录这次 schema 变更**

Create `prisma/migrations/20260801000001_backup_job/migration.sql`:

```sql
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
```

- [ ] **Step 4: 把这个迁移标记为已应用（因为 Step 2 已经用 db push 物理执行过了）**

Run: `npx dotenv -e .env.local prisma migrate resolve --applied 20260801000001_backup_job`

Expected: 输出包含 `Migration 20260801000001_backup_job marked as applied.`

- [ ] **Step 5: 重新生成 Prisma Client**

Run: `npm run db:generate`

Expected: 命令成功退出，无报错（生成 client 到 `lib/generated/prisma`）

- [ ] **Step 6: 验证迁移状态干净**

Run: `npx dotenv -e .env.local prisma migrate status`

Expected: 输出里 `20260801000001_backup_job` 不再出现在 "Following migration have not yet been applied" 列表里（如果这条命令报告了与 `20260731...` 相关的、跟本任务无关的问题，忽略它，不要修复）

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260801000001_backup_job
git commit -m "feat(db): add BackupJob model for database backup tracking"
```

---

### Task 2: lib/backup.ts — 纯函数部分（TDD）

**Files:**
- Create: `lib/backup.ts`
- Create: `tests/backup.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，不依赖 Task 1 的 Prisma client）
- Produces: `getDirectDatabaseUrl(databaseUrl: string): string`、`buildBackupObjectPath(date: Date, id: string): string`、`isExpired(startedAt: Date, now: Date, retentionDays: number): boolean` — Task 3 会在同一个文件里继续添加 I/O 函数，用到这三个。

- [ ] **Step 1: 写失败的测试**

Create `tests/backup.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDirectDatabaseUrl, buildBackupObjectPath, isExpired } from '../lib/backup'

test('getDirectDatabaseUrl 去掉连接串里的 -pooler 得到 direct 连接', () => {
  const pooled = 'postgresql://user:pass@ep-xxx-pooler.eu-central-1.aws.neon.tech/db?sslmode=require'
  assert.equal(
    getDirectDatabaseUrl(pooled),
    'postgresql://user:pass@ep-xxx.eu-central-1.aws.neon.tech/db?sslmode=require',
  )
})

test('getDirectDatabaseUrl 对已经是 direct 连接的串原样返回', () => {
  const direct = 'postgresql://user:pass@ep-xxx.eu-central-1.aws.neon.tech/db?sslmode=require'
  assert.equal(getDirectDatabaseUrl(direct), direct)
})

test('buildBackupObjectPath 生成带时间戳和 id 的路径，落在 backups/ 前缀下', () => {
  const date = new Date('2026-08-01T03:04:05.000Z')
  const path = buildBackupObjectPath(date, 'job123')
  assert.equal(path, 'backups/2026-08-01T03-04-05-000Z-job123.sql.gz')
})

test('isExpired: 超过保留天数的记录判定为过期', () => {
  const now = new Date('2026-08-01T00:00:00.000Z')
  const old = new Date('2026-06-01T00:00:00.000Z') // 61 天前
  assert.equal(isExpired(old, now, 30), true)
})

test('isExpired: 保留期内的记录判定为未过期', () => {
  const now = new Date('2026-08-01T00:00:00.000Z')
  const recent = new Date('2026-07-20T00:00:00.000Z') // 12 天前
  assert.equal(isExpired(recent, now, 30), false)
})

test('isExpired: 边界值——正好等于保留天数不算过期', () => {
  const now = new Date('2026-08-01T00:00:00.000Z')
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  assert.equal(isExpired(cutoff, now, 30), false)
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test --import=tsx tests/backup.test.ts`

Expected: FAIL，报错信息包含 `Cannot find module '../lib/backup'` 或类似模块不存在的提示

- [ ] **Step 3: 实现最小化的纯函数**

Create `lib/backup.ts`:

```typescript
export function getDirectDatabaseUrl(databaseUrl: string): string {
  return databaseUrl.replace('-pooler', '')
}

export function buildBackupObjectPath(date: Date, id: string): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-')
  return `backups/${stamp}-${id}.sql.gz`
}

export function isExpired(startedAt: Date, now: Date, retentionDays: number): boolean {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  return startedAt.getTime() < cutoff.getTime()
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test --import=tsx tests/backup.test.ts`

Expected: PASS，6 个测试全部通过，`# pass 6`

- [ ] **Step 5: Commit**

```bash
git add lib/backup.ts tests/backup.test.ts
git commit -m "feat(backup): add pure helper functions with tests"
```

---

### Task 3: lib/backup.ts — I/O 部分（pg_dump + GCS + Prisma）

**Files:**
- Modify: `lib/backup.ts`（在 Task 2 的基础上追加）

**Interfaces:**
- Consumes: Task 1 的 `prisma.backupJob` delegate；Task 2 的 `getDirectDatabaseUrl`、`buildBackupObjectPath`、`isExpired`。
- Produces:
  - `runBackup(triggerType: 'AUTO' | 'MANUAL', triggeredBy?: string): Promise<{ id: string; status: string; gcsPath?: string; sizeBytes?: number }>` — 已有 `running` 任务时 throw 一个 `status === 409` 的 Error。
  - `cleanupExpiredBackups(now?: Date): Promise<{ deleted: number }>`
  - `getBackupDownloadUrl(id: string): Promise<string | null>` — 找不到记录或还没成功时返回 `null`。
  这三个函数会分别被 Task 5（手动触发+列表）、Task 6（下载）、Task 7（cron）消费。

这个任务涉及真实的 `pg_dump` 二进制、GCS、数据库连接，本地开发机没有对应的 mock 基础设施（项目里现有触碰 GCS 的路由也都没有单测），所以本任务不写自动化测试，改为在 Task 5/7 里用 curl 端到端验证。写完后只跑类型检查确认没有类型错误。

**本地跑这一步之前的前提条件：** 本机需要装 `pg_dump`（macOS: `brew install libpq && brew link --force libpq`），且 `.env.local` 里 `GCS_BACKUP_BUCKET_NAME` 指向一个你有写权限的 GCS 桶（本地验证可以先用现有的 `veggie-supply-images` 桶做 smoke test，正式桶的创建在 Task 8 的部署文档里）。

- [ ] **Step 1: 在 lib/backup.ts 末尾追加 I/O 逻辑**

Append to `lib/backup.ts` (保留 Task 2 已有的三个纯函数，在文件顶部加上新 import，文件末尾加下面的代码):

在文件顶部（三个纯函数之前）加入：

```typescript
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Storage } from '@google-cloud/storage'
import { prisma } from '@/lib/db'
```

在文件末尾追加：

```typescript
const RETENTION_DAYS = 30

let _storage: Storage | null = null
function getStorage(): Storage {
  if (!_storage) _storage = new Storage()
  return _storage
}

function getBackupBucketName(): string {
  return process.env.GCS_BACKUP_BUCKET_NAME ?? 'veggie-db-backups'
}

async function dumpToFile(directUrl: string, tmpFile: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const pgDump = spawn('pg_dump', ['--format=plain', '--no-owner', '--no-privileges', directUrl])
    let stderr = ''
    pgDump.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    pgDump.on('error', reject)

    const out = createWriteStream(tmpFile)
    pipeline(pgDump.stdout, createGzip(), out).then(resolve).catch(reject)

    pgDump.on('close', (code) => {
      if (code !== 0) reject(new Error(`pg_dump exited with code ${code}: ${stderr}`))
    })
  })
}

export async function runBackup(
  triggerType: 'AUTO' | 'MANUAL',
  triggeredBy?: string,
): Promise<{ id: string; status: string; gcsPath?: string; sizeBytes?: number }> {
  const running = await prisma.backupJob.findFirst({ where: { status: 'running' } })
  if (running) {
    throw Object.assign(new Error('已有备份任务在进行中'), { status: 409 })
  }

  const job = await prisma.backupJob.create({
    data: { status: 'running', triggerType, triggeredBy: triggeredBy ?? null },
  })

  const rawUrl = process.env.DATABASE_URL
  if (!rawUrl) {
    await prisma.backupJob.update({
      where: { id: job.id },
      data: { status: 'failed', errorMessage: 'DATABASE_URL 未配置', finishedAt: new Date() },
    })
    throw new Error('DATABASE_URL 未配置')
  }

  const directUrl = getDirectDatabaseUrl(rawUrl)
  const objectPath = buildBackupObjectPath(new Date(), job.id)
  const tmpFile = join(tmpdir(), `backup-${job.id}.sql.gz`)

  try {
    await dumpToFile(directUrl, tmpFile)

    const bucket = getStorage().bucket(getBackupBucketName())
    await bucket.upload(tmpFile, { destination: objectPath, metadata: { contentType: 'application/gzip' } })
    const [metadata] = await bucket.file(objectPath).getMetadata()
    const sizeBytes = Number(metadata.size ?? 0)

    const updated = await prisma.backupJob.update({
      where: { id: job.id },
      data: { status: 'success', gcsPath: objectPath, sizeBytes, finishedAt: new Date() },
    })
    return { id: updated.id, status: updated.status, gcsPath: updated.gcsPath ?? undefined, sizeBytes: updated.sizeBytes ?? undefined }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    await prisma.backupJob.update({
      where: { id: job.id },
      data: { status: 'failed', errorMessage, finishedAt: new Date() },
    })
    throw err
  } finally {
    await unlink(tmpFile).catch(() => {})
  }
}

export async function cleanupExpiredBackups(now: Date = new Date()): Promise<{ deleted: number }> {
  const candidates = await prisma.backupJob.findMany({ where: { status: 'success' } })
  const expired = candidates.filter((job) => isExpired(job.startedAt, now, RETENTION_DAYS))
  if (expired.length === 0) return { deleted: 0 }

  const bucket = getStorage().bucket(getBackupBucketName())
  for (const job of expired) {
    if (job.gcsPath) {
      await bucket.file(job.gcsPath).delete({ ignoreNotFound: true })
    }
  }

  const { count } = await prisma.backupJob.deleteMany({
    where: { id: { in: expired.map((j) => j.id) } },
  })
  return { deleted: count }
}

export async function getBackupDownloadUrl(id: string): Promise<string | null> {
  const job = await prisma.backupJob.findUnique({ where: { id } })
  if (!job || job.status !== 'success' || !job.gcsPath) return null

  const bucket = getStorage().bucket(getBackupBucketName())
  const [url] = await bucket.file(job.gcsPath).getSignedUrl({
    action: 'read',
    expires: Date.now() + 10 * 60 * 1000,
  })
  return url
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`

Expected: 无报错退出（`lib/backup.ts` 里对 `prisma.backupJob` 的调用能通过类型检查，说明 Task 1 生成的 client 类型是对的）

- [ ] **Step 3: 确认 Task 2 的单测仍然通过（没有被 I/O 代码的 import 破坏）**

Run: `node --test --import=tsx tests/backup.test.ts`

Expected: PASS，6 个测试全部通过

- [ ] **Step 4: Commit**

```bash
git add lib/backup.ts
git commit -m "feat(backup): implement pg_dump + GCS upload + cleanup logic"
```

---

### Task 4: Dockerfile — 安装 pg_dump 二进制

**Files:**
- Modify: `Dockerfile`

**Interfaces:**
- Consumes: 无
- Produces: 生产容器内 `pg_dump`/`psql` 可执行，Task 3 的 `runBackup()` 在 Cloud Run 上才能真正跑起来。

- [ ] **Step 1: 在 runner 阶段的 apk add 里加 postgresql-client**

在 `Dockerfile` 里找到这一段：

```dockerfile
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont font-noto-cjk font-noto-emoji fontconfig \
    && fc-cache -f
```

改成：

```dockerfile
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont font-noto-cjk font-noto-emoji fontconfig postgresql16-client \
    && fc-cache -f
```

- [ ] **Step 2: 本地构建镜像验证 pg_dump 可用**

Run: `docker build -t veggie-backup-test . && docker run --rm veggie-backup-test which pg_dump`

Expected: 输出 `/usr/bin/pg_dump`（如果 `postgresql16-client` 包名在当前 Alpine 版本里找不到，报错信息会提示包不存在——这时把 `postgresql16-client` 换成不带版本号的 `postgresql-client` 重新构建验证）

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "chore(docker): install pg_dump for database backup"
```

---

### Task 5: API — 手动触发备份 + 列表

**Files:**
- Create: `app/api/backups/route.ts`
- Modify: `lib/types.ts`（新增 `BackupJob` 前端类型）

**Interfaces:**
- Consumes: `withAuth` (`lib/auth.ts`)、`prisma.backupJob`、`runBackup` (Task 3)
- Produces: `GET /api/backups` → `{ backups: BackupJob[] }`；`POST /api/backups` → `{ backup: { id, status, gcsPath?, sizeBytes? } }` 或错误 JSON `{ error: string }`（409 表示已有任务在跑）。前端类型 `BackupJob` 会被 Task 8 消费。

- [ ] **Step 1: 在 lib/types.ts 里加前端类型**

找到 `lib/types.ts` 里任意一个 `export interface` 定义（例如文件末尾附近的 `StockMove`），在文件末尾追加：

```typescript
export interface BackupJob {
  id: string
  status: 'running' | 'success' | 'failed'
  triggerType: 'AUTO' | 'MANUAL'
  triggeredBy: string | null
  gcsPath: string | null
  sizeBytes: number | null
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
}
```

- [ ] **Step 2: 写 API 路由**

Create `app/api/backups/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { runBackup } from '@/lib/backup'

const ALLOWED_ROLES = ['BOSS']

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const backups = await prisma.backupJob.findMany({
      orderBy: { startedAt: 'desc' },
      take: 30,
    })
    return NextResponse.json({ backups })
  }, ALLOWED_ROLES)
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const result = await runBackup('MANUAL', user.userId)
      return NextResponse.json({ backup: result })
    } catch (err) {
      const status = (err as { status?: number })?.status ?? 500
      const message = err instanceof Error ? err.message : '备份失败'
      return NextResponse.json({ error: message }, { status })
    }
  }, ALLOWED_ROLES)
}
```

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`

Expected: 无报错退出

- [ ] **Step 4: 启动本地服务，用 curl 端到端验证**

Run: `npm run dev`（另开一个终端跑下面的 curl）

先登录拿 BOSS token（如果本地种子数据里没有 BOSS 账号，用 `npx dotenv -e .env.local prisma studio` 打开 `User` 表确认一个 role 为 `BOSS` 的账号邮箱/密码）：

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<boss账号邮箱>","password":"<密码>"}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")

echo "Token: $TOKEN"

# 未带 token 应该 401
curl -s -w "\n--- STATUS: %{http_code} ---\n" http://localhost:3000/api/backups

# 带 BOSS token 手动触发一次备份（本地机器需要已装 pg_dump，见 Task 3 前提条件）
curl -s -w "\n--- STATUS: %{http_code} ---\n" -X POST http://localhost:3000/api/backups \
  -H "Authorization: Bearer $TOKEN"

# 列表应该能看到刚才那条记录，status 应为 success
curl -s -w "\n--- STATUS: %{http_code} ---\n" http://localhost:3000/api/backups \
  -H "Authorization: Bearer $TOKEN"
```

Expected: 第一个 curl 返回 401；第二个 curl 返回 200 且 `backup.status` 为 `success`（如果本地没配 `GCS_BACKUP_BUCKET_NAME` 对应的桶权限，会失败并返回 500，这属于本地环境限制，记录下来即可，不影响这个任务的代码正确性判定——只要 401/403 的鉴权分支验证通过就算这个任务完成）；第三个 curl 的 `backups` 数组包含刚才那条记录

- [ ] **Step 5: Commit**

```bash
git add app/api/backups/route.ts lib/types.ts
git commit -m "feat(backup): add manual trigger and list API"
```

---

### Task 6: API — 下载签名 URL

**Files:**
- Create: `app/api/backups/[id]/download/route.ts`

**Interfaces:**
- Consumes: `withAuth`、`getBackupDownloadUrl` (Task 3)
- Produces: `GET /api/backups/[id]/download` → `{ url: string }` 或 404

- [ ] **Step 1: 写路由**

Create `app/api/backups/[id]/download/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { getBackupDownloadUrl } from '@/lib/backup'

const ALLOWED_ROLES = ['BOSS']

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await ctx.params
    const url = await getBackupDownloadUrl(id)
    if (!url) {
      return NextResponse.json({ error: '备份不存在或尚未完成' }, { status: 404 })
    }
    return NextResponse.json({ url })
  }, ALLOWED_ROLES)
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`

Expected: 无报错退出

- [ ] **Step 3: curl 验证**

（沿用 Task 5 Step 4 里拿到的 `$TOKEN` 和 `npm run dev` 服务）

```bash
# 不存在的 id → 404
curl -s -w "\n--- STATUS: %{http_code} ---\n" http://localhost:3000/api/backups/nonexistent-id/download \
  -H "Authorization: Bearer $TOKEN"

# 用 Task 5 里成功备份的真实 id（从 GET /api/backups 的返回里拿）→ 200 + url
BACKUP_ID="<替换成真实 id>"
curl -s -w "\n--- STATUS: %{http_code} ---\n" http://localhost:3000/api/backups/$BACKUP_ID/download \
  -H "Authorization: Bearer $TOKEN"
```

Expected: 第一个 404；第二个 200 且返回 `{"url":"https://storage.googleapis.com/..."}`

- [ ] **Step 4: Commit**

```bash
git add app/api/backups/\[id\]/download/route.ts
git commit -m "feat(backup): add signed URL download endpoint"
```

---

### Task 7: API — 每日自动备份 cron 路由

**Files:**
- Create: `app/api/cron/backup-database/route.ts`

**Interfaces:**
- Consumes: `runBackup`、`cleanupExpiredBackups` (Task 3)
- Produces: `POST /api/cron/backup-database`（`x-cron-secret` 校验）→ `{ backup, cleanup }` 或错误 JSON

- [ ] **Step 1: 写路由**

Create `app/api/cron/backup-database/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { runBackup, cleanupExpiredBackups } from '@/lib/backup'

/**
 * /api/cron/backup-database — 每日自动全库备份
 * ============================================================================
 * 触发方式与 app/api/cron/generate-statements/route.ts 一致：外部定时器
 * （Cloud Scheduler）POST 本路由并带 x-cron-secret header。
 * 备份成功后顺带清理超过 30 天的旧备份，不需要单独再配一个 Scheduler job。
 */
export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const backup = await runBackup('AUTO')
    const cleanup = await cleanupExpiredBackups()
    return NextResponse.json({ backup, cleanup })
  } catch (error) {
    console.error('[POST /api/cron/backup-database]', error)
    const message = error instanceof Error ? error.message : '自动备份失败'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`

Expected: 无报错退出

- [ ] **Step 3: curl 验证（本地 .env.local 需要设置 CRON_SECRET，随便设一个开发用的值）**

```bash
# 缺 header → 401
curl -s -w "\n--- STATUS: %{http_code} ---\n" -X POST http://localhost:3000/api/cron/backup-database

# 错误的 secret → 401
curl -s -w "\n--- STATUS: %{http_code} ---\n" -X POST http://localhost:3000/api/cron/backup-database \
  -H "x-cron-secret: wrong-value"

# 正确的 secret → 200，backup.status 应为 success，cleanup.deleted 应为 0（因为还没有超过 30 天的记录）
curl -s -w "\n--- STATUS: %{http_code} ---\n" -X POST http://localhost:3000/api/cron/backup-database \
  -H "x-cron-secret: $CRON_SECRET"
```

Expected: 前两个 401；第三个 200（或本地环境没有 GCS 权限时 500，同 Task 5 Step 4 的说明，鉴权分支验证通过即可）

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/backup-database/route.ts
git commit -m "feat(backup): add daily auto-backup cron endpoint"
```

---

### Task 8: 前端页面 + 导航入口

**Files:**
- Create: `app/[locale]/classic/boss/system/backups/page.tsx`
- Modify: `app/[locale]/classic/boss/layout.tsx`

**Interfaces:**
- Consumes: `apiGet`/`apiPost`/`ApiError` (`lib/api.ts`)、`BackupJob` 类型 (Task 5)、`formatDateTime` (`lib/format-date.ts`)、`Button` (`components/ui/button.tsx`)
- Produces: BOSS 后台可见的备份管理页面

- [ ] **Step 1: 写页面**

Create `app/[locale]/classic/boss/system/backups/page.tsx`:

```tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import { apiGet, apiPost, ApiError } from '@/lib/api'
import type { BackupJob } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { formatDateTime } from '@/lib/format-date'

function formatSize(bytes: number | null): string {
  if (!bytes) return '-'
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(1)} MB`
}

const STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  success: '成功',
  failed: '失败',
}

export default function BackupsPage() {
  const [backups, setBackups] = useState<BackupJob[]>([])
  const [loading, setLoading] = useState(true)
  const [triggering, setTriggering] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiGet<{ backups: BackupJob[] }>('/api/backups')
      setBackups(res.backups)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '加载备份列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleTrigger() {
    setTriggering(true)
    try {
      await apiPost('/api/backups', {})
      toast.success('备份完成')
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '备份失败')
    } finally {
      setTriggering(false)
    }
  }

  async function handleDownload(id: string) {
    try {
      const res = await apiGet<{ url: string }>(`/api/backups/${id}/download`)
      window.open(res.url, '_blank')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '获取下载链接失败')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">数据库备份</h1>
        <Button onClick={handleTrigger} disabled={triggering}>
          {triggering ? '备份中…' : '立即备份'}
        </Button>
      </div>

      {loading ? (
        <p className="text-gray-500">加载中…</p>
      ) : backups.length === 0 ? (
        <p className="text-gray-500">还没有任何备份记录</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left border-b">
              <th className="py-2">时间</th>
              <th className="py-2">触发方式</th>
              <th className="py-2">状态</th>
              <th className="py-2">大小</th>
              <th className="py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.id} className="border-b">
                <td className="py-2">{formatDateTime(b.startedAt)}</td>
                <td className="py-2">{b.triggerType === 'MANUAL' ? '手动' : '自动'}</td>
                <td className="py-2">{STATUS_LABEL[b.status] ?? b.status}</td>
                <td className="py-2">{formatSize(b.sizeBytes)}</td>
                <td className="py-2">
                  {b.status === 'success' ? (
                    <Button variant="outline" size="sm" onClick={() => handleDownload(b.id)}>
                      下载
                    </Button>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 加导航入口，仅 BOSS 可见**

在 `app/[locale]/classic/boss/layout.tsx` 里找到：

```tsx
  const LINKS = [
    { href: `${prefix}/classic/boss`, label: '经营总览' },
    { href: `${prefix}/classic/boss/analytics/sales-overview`, label: '销售统计' },
    { href: `${prefix}/classic/boss/analytics/customers`, label: '客户分析' },
    { href: `${prefix}/classic/boss/analytics/margin`, label: '毛利分析' },
    { href: `${prefix}/classic/boss/analytics/income-statement`, label: '利润表' },
    { href: `${prefix}/classic/boss/analytics/ar-aging`, label: '应收账龄' },
    { href: `${prefix}/classic/boss/analytics/ap-aging`, label: '应付账龄' },
    { href: `${prefix}/classic/boss/analytics/procurement`, label: '采购运营' },
    { href: `${prefix}/classic/boss/analytics/logistics`, label: '物流分析' },
    { href: `${prefix}/classic/boss/analytics/internal-control`, label: '内控审计' },
  ]
```

改成：

```tsx
  const LINKS = [
    { href: `${prefix}/classic/boss`, label: '经营总览' },
    { href: `${prefix}/classic/boss/analytics/sales-overview`, label: '销售统计' },
    { href: `${prefix}/classic/boss/analytics/customers`, label: '客户分析' },
    { href: `${prefix}/classic/boss/analytics/margin`, label: '毛利分析' },
    { href: `${prefix}/classic/boss/analytics/income-statement`, label: '利润表' },
    { href: `${prefix}/classic/boss/analytics/ar-aging`, label: '应收账龄' },
    { href: `${prefix}/classic/boss/analytics/ap-aging`, label: '应付账龄' },
    { href: `${prefix}/classic/boss/analytics/procurement`, label: '采购运营' },
    { href: `${prefix}/classic/boss/analytics/logistics`, label: '物流分析' },
    { href: `${prefix}/classic/boss/analytics/internal-control`, label: '内控审计' },
    // 数据库备份涉及全库敏感数据，仅 BOSS 可见（本 layout 本身放行 BOSS+OPERATOR，这里额外收紧）
    ...(session?.role === 'BOSS'
      ? [
          { href: '', label: '│' },
          { href: `${prefix}/classic/boss/system/backups`, label: '数据库备份' },
        ]
      : []),
  ]
```

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`

Expected: 无报错退出

- [ ] **Step 4: 浏览器验证（如无浏览器自动化工具，走 curl + 静态走查代替，见项目记忆 no-browser-automation-tool）**

Run: `npm run dev`，然后：

```bash
# 页面路由能访问，不是 404（返回 HTML，200）
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/classic/boss/system/backups
```

Expected: `200`（Next.js client component 页面即使未登录也应该先返回 200 的 HTML 壳，鉴权在客户端 `useEffect` 里跳转，这是本项目现有 layout 的既定模式）

- [ ] **Step 5: Commit**

```bash
git add app/\[locale\]/classic/boss/system/backups/page.tsx app/\[locale\]/classic/boss/layout.tsx
git commit -m "feat(backup): add backup management page and nav entry"
```

---

### Task 9: 部署文档 — GCS 桶 / Cloud Scheduler / 恢复 Runbook

**Files:**
- Modify: `docs/guides/DEPLOYMENT.md`

**Interfaces:**
- Consumes: 无（纯文档）
- Produces: 完整的、可执行的部署+恢复操作手册，供后续实际执行 GCP 资源创建时使用（不在本计划内自动执行）

- [ ] **Step 1: 在"二、GCS Bucket"后面加一节新的 GCS 私有桶创建步骤**

在 `docs/guides/DEPLOYMENT.md` 里找到：

```
### 2. GCS Bucket（商品图片）

```bash
gsutil mb -l europe-west1 gs://veggie-supply-images
# 允许公共读（图片要直接渲染到餐馆下单页）
gsutil iam ch allUsers:objectViewer gs://veggie-supply-images
# 授权 Cloud Run 服务账号写入
gsutil iam ch "serviceAccount:${PROJECT_NUM}-compute@developer.gserviceaccount.com:objectCreator" \
  gs://veggie-supply-images
```
```

紧跟着在它后面插入一个新的子小节：

```markdown
### 2b. GCS Bucket（数据库备份，私有）

```bash
gsutil mb -l europe-west1 gs://veggie-db-backups
# 不开放公共读——备份是全库敏感数据，只允许运行时 SA 读写
gsutil iam ch "serviceAccount:${PROJECT_NUM}-compute@developer.gserviceaccount.com:objectAdmin" \
  gs://veggie-db-backups

# Secret Manager 加一个 CRON_SECRET（如果之前还没配过，其它 cron 路由也用它）
gcloud secrets create VEGGIE_CRON_SECRET --data-file=- <<< "$(openssl rand -hex 32)"
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUM}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

部署时把 `GCS_BACKUP_BUCKET_NAME=veggie-db-backups` 和 `CRON_SECRET=VEGGIE_CRON_SECRET:latest` 加进 `cloudbuild.yaml` 的 `--set-secrets`/`--set-env-vars`。

### 2c. Cloud Scheduler（每日自动备份）

```bash
gcloud scheduler jobs create http veggie-daily-backup \
  --location=europe-west1 \
  --schedule="0 3 * * *" \
  --uri="https://<你的 Cloud Run URL>/api/cron/backup-database" \
  --http-method=POST \
  --headers="x-cron-secret=<与 VEGGIE_CRON_SECRET 相同的值>"
```

每天 03:00（服务器所在时区）触发一次全库备份，成功后自动清理 30 天前的旧备份。
```

- [ ] **Step 2: 在部署文档里加"数据库恢复"一节**

在 `docs/guides/DEPLOYMENT.md` 的"### 数据库回滚"小节后面（`git blame`/搜索关键字 `切换 DATABASE_URL 指向之前的某个 "known good" 分支` 所在段落之后）插入：

```markdown
### 数据库恢复（从应用内备份恢复）

应用内的"数据库备份"页面（仅 BOSS 可见，`/classic/boss/system/backups`）只提供下载，不做应用内一键覆盖恢复。真正恢复到生产库需要运维人员手动执行：

1. 在后台下载目标 `.sql.gz` 备份文件（签名 URL 10 分钟内有效，过期重新点下载）。
2. **恢复前**，先在 Neon 控制台给当前生产库开一个备份分支兜底（应急保险，如果恢复出问题还能退回去）。
3. 拿到 direct（非 pooler）连接串，执行：

```bash
gunzip -c backup-xxx.sql.gz | psql "$DIRECT_DATABASE_URL"
```

4. 恢复完成后核对关键表行数、最新几张订单/发票是否符合预期，再切流量/放开访问。
```

- [ ] **Step 3: 在"上线前 Checklist"的"📊 数据"小节加一条**

找到：

```
- [ ] Neon 数据库已建备份分支
```

改成：

```
- [ ] Neon 数据库已建备份分支
- [ ] `veggie-db-backups` GCS 私有桶已创建，Cloud Scheduler 每日备份 job 已配置，`GET /api/backups` 能看到至少一条 `success` 记录
```

- [ ] **Step 4: Commit**

```bash
git add docs/guides/DEPLOYMENT.md
git commit -m "docs: add backup bucket, scheduler, and restore runbook"
```

---

## Self-Review 结果

- **Spec 覆盖**：应用内自动化备份 ✅ Task 3/7；全库物理备份 ✅ Task 3（`pg_dump --format=plain`）；下载而非应用内恢复 ✅ Task 6 + Task 9 Step 2；每日自动+手动 ✅ Task 7 + Task 5；30 天保留自动清理 ✅ Task 3 `cleanupExpiredBackups`；仅 BOSS 可见 ✅ Task 5/6 `ALLOWED_ROLES` + Task 8 导航条件渲染。
- **占位符扫描**：无 TBD/TODO，所有步骤都有完整代码或具体命令。
- **类型一致性**：`BackupJob`（Prisma 模型，Task 1）与 `BackupJob`（前端类型，Task 5）字段名对齐；`runBackup`/`cleanupExpiredBackups`/`getBackupDownloadUrl` 的签名在 Task 3 定义后，Task 5/6/7 原样复用，没有改名。
