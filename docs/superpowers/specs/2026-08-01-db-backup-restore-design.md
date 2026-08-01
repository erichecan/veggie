# 数据库备份与恢复设计

**日期**：2026-08-01
**背景**：产品文档差距分析中"系统日志与数据安全"模块被标记为"部分完成"——操作日志/登录日志已完整，但系统本身没有内置的备份恢复功能，现有备份都是数据迁移时的一次性手工快照。本设计补全这个缺口。

## 现状

- 部署：GCP Cloud Run + Neon Postgres（非 Cloud SQL），`cloudbuild.yaml` 里 `DATABASE_URL` 是 Neon pooler 连接串，迁移步骤靠字符串替换去掉 `-pooler` 得到 direct 连接。
- Neon 本身提供 PITR/分支能力，但完全依赖运维人员手动登录 Neon 控制台操作，应用内没有任何自助能力。
- 现有 cron 路由模式（`app/api/cron/generate-statements/route.ts`、`app/api/action-logs/cleanup/route.ts`）：外部 Cloud Scheduler POST，`x-cron-secret` header 对比 `process.env.CRON_SECRET`。
- 现有 GCS 用法（`app/api/upload-image/route.ts`、`app/api/purchase-orders/pdf-extract/route.ts`）：`Storage` 客户端懒加载单例，直接拼公开读 URL——备份数据敏感，本设计不复用该公开桶/公开 URL 模式。
- API 鉴权标准写法：`lib/auth.ts` 的 `withAuth(request, handler, allowedRoles?)`。
- `boss` 侧边栏（`app/[locale]/classic/boss/layout.tsx`）目前是无分组扁平数组；`operator/layout.tsx` 有分组写法可参考（`{href:'', label:'│'}` 作分隔符）。

## 范围确认（brainstorming 阶段已与用户逐项确认）

1. 备份层面：**应用内自动化备份 + 管理员自助下载**（不是单纯依赖 Neon 控制台文档化）。
2. 备份范围：**全库物理备份**（`pg_dump`，非按业务表选择性 JSON 导出）。
3. 恢复方式：**只做到"下载备份文件" + 文档化恢复步骤**，不在应用内做一键覆盖生产库的高危操作。
4. 触发频率：**每日自动 1 次 + 支持手动立即备份**。
5. 保留策略：**保留最近 30 天**，超期自动清理（GCS 对象 + DB 记录一起删）。
6. 访问权限：**仅 BOSS** 角色可查看备份列表、手动触发、下载。

## 架构总览

- 自动与手动备份共用同一段核心逻辑 `lib/backup.ts`，避免逻辑分叉。
- 每日自动：Cloud Scheduler → `POST /api/cron/backup-database`（`x-cron-secret` 校验，复用现有 `CRON_SECRET`）→ 执行备份 → 成功后顺带清理 30 天前的旧备份，不需要再单独配一个 Scheduler job。
- 手动：BOSS 在后台点"立即备份" → `POST /api/backups`（`withAuth(['BOSS'])`）→ 同步执行、返回结果。
- 备份产物：`pg_dump --format=plain` 输出 gzip 压缩后上传到**新建的私有 GCS 桶** `veggie-db-backups`（与现有公开读的图片桶隔离）。
- 下载走**签名 URL**（5~10 分钟有效期），不复用现有拼接公开 URL 的模式。
- 恢复不做应用内入口，只在部署文档里写清楚 `psql` 恢复步骤，运维人员手动执行。

## 数据模型

新增 `BackupJob` 表，风格参照 `ActionLog`/`Statement`：

```prisma
model BackupJob {
  id           String    @id @default(cuid())
  status       String    @default("running") // running | success | failed
  triggerType  String    // AUTO | MANUAL
  triggeredBy  String?   // 手动触发时记录 userId，自动触发为 null
  gcsPath      String?   // 成功后的对象路径
  sizeBytes    Int?
  errorMessage String?
  startedAt    DateTime  @default(now())
  finishedAt   DateTime?

  @@index([status])
  @@index([startedAt])
}
```

## API 路由

| 路由 | 方法 | 鉴权 | 说明 |
|------|------|------|------|
| `/api/cron/backup-database` | POST | `x-cron-secret` | Cloud Scheduler 每日触发；备份成功后清理过期备份 |
| `/api/backups` | POST | `withAuth(['BOSS'])` | 手动立即备份，同步等待完成并返回结果 |
| `/api/backups` | GET | `withAuth(['BOSS'])` | 分页列出最近的 `BackupJob` |
| `/api/backups/[id]/download` | GET | `withAuth(['BOSS'])` | 生成签名 URL（5~10 分钟有效期）返回 |

核心函数 `lib/backup.ts`：
- `getDirectDatabaseUrl()`：对 `process.env.DATABASE_URL` 做 `-pooler` 字符串替换，得到 pg_dump 所需的 direct 连接（同 `cloudbuild.yaml` 迁移步骤的做法）。
- `runBackup(triggerType: 'AUTO'|'MANUAL', triggeredBy?: string)`：落一条 `BackupJob(status='running')` → spawn `pg_dump` 写到 `os.tmpdir()` 临时文件 → gzip → 上传 GCS → 更新 `BackupJob` 为 `success`（含 `gcsPath`/`sizeBytes`）或 `failed`（含 `errorMessage`）→ 清理本地临时文件。
- `cleanupExpiredBackups()`：删除 `startedAt` 早于 30 天前的 `BackupJob` 对应的 GCS 对象和 DB 行。

## 前端页面

- 新页面：`app/[locale]/classic/boss/system/backups/page.tsx`。列表展示时间/触发方式/状态/大小/下载按钮；顶部"立即备份"按钮，点击后禁用+loading，完成后刷新列表。
- 若已有一个 `status='running'` 的任务，手动触发按钮显示"备份进行中"并阻止重复触发（后端 `/api/backups` POST 同样要做并发保护，检测到已有 running 任务时返回 409）。
- 导航：`boss/layout.tsx` 新增一个分组（仿 `operator/layout.tsx` 的分隔符写法），条目"数据库备份"指向该页面；仅 `role === 'BOSS'` 时渲染该入口（比当前 boss layout 放行 BOSS+OPERATOR 更严格的一层判断）。

## 部署 / 基础设施改动

以下涉及创建 GCP 资源的步骤，在进入实施阶段时会先向用户确认 project ID 后再执行，不在设计/编码阶段直接操作：

- `Dockerfile` runner 阶段 `apk add` 增加 `postgresql-client`，获得 `pg_dump`/`psql` 二进制（同现有装 chromium 的做法）。
- 新建 GCS 私有桶 `veggie-db-backups`（建议与 Cloud Run 同 region：europe-west1）。
- Cloud Run 服务账号授予该桶 `roles/storage.objectAdmin`。
- 新建 Cloud Scheduler job，每天固定时间 `POST /api/cron/backup-database`（带 `x-cron-secret`）。
- 新增环境变量 `GCS_BACKUP_BUCKET_NAME`（默认回退 `veggie-db-backups`），走 Secret Manager / Cloud Run env var，与现有 `GCS_BUCKET_NAME` 隔离。

## 恢复 Runbook（文档化）

在 `docs/guides/DEPLOYMENT.md` 新增一节"数据库恢复"：

1. 从后台下载目标 `.sql.gz` 备份文件。
2. 恢复前，先在 Neon 控制台给当前生产库开一个备份分支兜底（应急保险）。
3. 执行：`gunzip -c backup-xxx.sql.gz | psql "$DIRECT_DATABASE_URL"`（direct 连接，去 `-pooler`）。
4. 恢复完成后核对关键表行数/最新单据是否符合预期。

## 错误处理

- `pg_dump` 失败（连接失败/超时）→ `BackupJob.status='failed'` + `errorMessage`，不阻塞下次自动备份。
- GCS 上传失败 → 同上记录失败；本地临时文件无论成功失败都清理，避免容器内堆积。
- 手动触发时如已有 `running` 任务 → 409，提示"已有备份任务在进行中"。

## 测试

- `lib/backup.ts` 单测：mock `child_process.spawn` 和 GCS `Storage`，验证成功/失败路径都正确写 `BackupJob`。
- API 路由测试：
  - `/api/cron/backup-database` 缺失/错误 `x-cron-secret` → 401。
  - `/api/backups` 非 BOSS 角色调用 → 403。
  - `/api/backups/[id]/download` 对不存在的 id → 404。

## 明确排除的范围

- 不做应用内一键恢复（覆盖生产库）。
- 不做按业务表的选择性逻辑导出（只做全库物理备份）。
- 不新增全局操作日志查看页面（该部分已被判定为"完整"，不在本次范围内）。
- 不改动 Neon 现有的 PITR/分支机制，两者是互补关系，不是替代关系。
