# 部署指南

> 目标：从零到 Cloud Run 上线、能登录、能下单、不出错。
> 本文假设你在本机开发 (macOS/Linux)，生产跑 GCP Cloud Run + Neon Postgres。

---

## 一、前置要求

| 工具 | 最低版本 | 用途 |
|------|---------|------|
| Node.js | ≥ 18 (推荐 22) | 运行 Next.js |
| npm | 配套 | 包管理 |
| Neon 账号 | 免费版即可 | 生产 Postgres |
| GCP 项目 | 有 Cloud Run 配额 | 部署目标 |

---

## 二、第一次本机部署（10 分钟）

```bash
# 1. 克隆代码
git clone <repo>
cd veggie-demo

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env.local
# 编辑 .env.local，至少填 DATABASE_URL 和 JWT_SECRET

# 4. Prisma 生成客户端类型
npm run db:generate

# 5. 应用两个迁移（Sprint1 + Sprint2）
npm run db:migrate    # 会跑 prisma migrate deploy

# 6. 导入种子数据（9 个测试账号 + 1,681 个商品 + 价格表 + UoM + 会计科目）
npm run db:seed

# 7. 跑类型检查 + 测试
npm run typecheck     # 应该 0 错误
npm run test          # 应该 57 条全绿

# 8. 启动
npm run dev
# → 访问 http://localhost:3000
# → 默认密码：Demo1234!  账号见 DEV-REPORT.md
```

---

## 三、生产部署（GCP Cloud Run）

### 1. 准备 Secret Manager

```bash
gcloud secrets create VEGGIE_DATABASE_URL --data-file=- <<< "postgresql://..."
gcloud secrets create VEGGIE_JWT_SECRET   --data-file=- <<< "$(openssl rand -base64 48)"
gcloud secrets create VEGGIE_RESEND_API_KEY --data-file=- <<< "re_xxx"
gcloud secrets create VEGGIE_SENTRY_DSN   --data-file=- <<< "https://xxx@sentry.io/xxx"

# 授权默认 Compute SA 读取 Secret
PROJECT_ID=$(gcloud config get-value project)
PROJECT_NUM=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUM}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
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

### 3. 触发部署

```bash
# 首次：手动触发
gcloud builds submit --config=cloudbuild.yaml .

# 或接入 GitHub Trigger，推代码自动构建
```

### 4. 首次生产迁移

部署后第一次必须在**生产数据库**上跑迁移（Cloud Run 不自动跑）：

```bash
# 用生产 DATABASE_URL 临时覆盖
DATABASE_URL="postgresql://prod..." npm run db:migrate
DATABASE_URL="postgresql://prod..." npm run db:seed
```

### 5. 验证

```bash
# 健康检查
curl https://veggie-demo-xxxx.run.app/api/health
# → {"status":"ok","db":"ok",...}

# E2E 脚本（需要服务已启动）
HOST=https://veggie-demo-xxxx.run.app bash scripts/e2e-verify.sh
```

---

## 四、上线前 Checklist

运营验收、上线前逐项确认：

### 🔐 安全

- [ ] `JWT_SECRET` ≥ 32 字符，已配置在 Secret Manager（生产若缺失会拒绝启动）
- [ ] `.env.local` **没有**提交到 git（见 `.gitignore`）
- [ ] Neon DATABASE_URL 使用专门的生产分支，不是 dev 分支
- [ ] 默认种子账号的密码已全部改掉（或通过 `/api/users/:id/reset-password`）
- [ ] Sentry DSN 已配置 → 错误能自动上报
- [ ] 速率限制已生效（登录 10/min，上传 30/min）

### 📊 数据

- [ ] Prisma 迁移应用成功（`prisma migrate deploy` 输出 "All migrations have been successfully applied."）
- [ ] 种子数据导入完成（users / 产品 / pricelist / UoM / 会计科目）
- [ ] Neon 数据库已建备份分支
- [ ] `veggie-db-backups` GCS 私有桶已创建，Cloud Scheduler 每日备份 job 已配置，`GET /api/backups` 能看到至少一条 `success` 记录
- [ ] 关键表都有索引（Sprint 1 的迁移已加 40+ 个）

### 🌐 基础设施

- [ ] Cloud Run `--min-instances=1` 消除冷启动
- [ ] `/api/health` 在负载均衡健康检查能通过（200）
- [ ] GCS Bucket 权限正确（运行时 SA 能写，allUsers 能读）
- [ ] 域名 + HTTPS 证书已挂（Cloud Run 自带或 Cloud Load Balancer）

### ✅ 功能验证

运营手工走一遍这几个流程：

1. [ ] 登录（operator@veggie.com / Demo1234!）→ 进入运营后台
2. [ ] 新建客户 → 绑定一张 pricelist
3. [ ] 用餐馆账号登录 → 下单（验证价格服务端重算）
4. [ ] 运营生成拣货波次 → 分配司机
5. [ ] 司机看到行程，扫码收货
6. [ ] 运营生成发票 → 查看
7. [ ] 图片上传成功（商品编辑）

### 📱 移动端

- [ ] 司机手机（iOS + Android）能登录并完成签收
- [ ] 餐馆老板手机能下单
- [ ] 横屏/竖屏都可用

---

## 五、监控 & 告警

### 常用运维命令

```bash
# 看最近日志
gcloud run services logs read veggie-demo --region=europe-west1 --limit=100

# 仅看错误
gcloud run services logs read veggie-demo --region=europe-west1 \
  --log-filter="severity>=ERROR"

# 查看当前实例数 / CPU
gcloud run services describe veggie-demo --region=europe-west1
```

### Sentry 告警配置（推荐）

- 错误率 > 1% → 邮件
- P95 响应 > 3s → Slack
- 特定错误 `INSUFFICIENT_STOCK` → 不告警（业务正常）
- `DATABASE_URL_NOT_SET` → 立即电话

---

## 六、回滚

### Cloud Run 回滚（秒级）

```bash
# 列出所有已部署版本
gcloud run revisions list --service=veggie-demo --region=europe-west1

# 把流量切回上一个版本
gcloud run services update-traffic veggie-demo \
  --region=europe-west1 \
  --to-revisions=veggie-demo-00042-xxx=100
```

### 数据库回滚

Prisma 迁移默认**不可回滚**（不生成 down.sql）。应急方案：

1. 立即在 Neon 控制台创建当前状态的备份分支
2. 切换 DATABASE_URL 指向之前的某个 "known good" 分支
3. Redeploy 对应代码版本

### 数据库恢复（从应用内备份恢复）

应用内的"数据库备份"页面（仅 BOSS 可见，`/classic/boss/system/backups`）只提供下载，不做应用内一键覆盖恢复。真正恢复到生产库需要运维人员手动执行：

1. 在后台下载目标 `.sql.gz` 备份文件（签名 URL 10 分钟内有效，过期重新点下载）。
2. **恢复前**，先在 Neon 控制台给当前生产库开一个备份分支兜底（应急保险，如果恢复出问题还能退回去）。
3. 拿到 direct（非 pooler）连接串，执行：

```bash
gunzip -c backup-xxx.sql.gz | psql "$DIRECT_DATABASE_URL"
```

4. 恢复完成后核对关键表行数、最新几张订单/发票是否符合预期，再切流量/放开访问。

---

## 七、常见问题

### Q: `JWT_SECRET is missing or shorter than 32 chars`

生产环境没设或太短。到 Secret Manager 加一个 ≥32 字符的随机秘钥，绑定到服务。

### Q: Prisma 报 `Failed to fetch the engine file`

沙箱环境或断网环境 Prisma 二进制下载失败。设置 `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1`，或用有网络的开发机先 `npm install` 再打镜像。

### Q: 下单提示 "INSUFFICIENT_STOCK"

库存不足。这是**正确的业务保护**，不是 bug。运营去 `/operator/purchase-orders` 走采购流程补库存，或手工在 `/warehouse` 调整库存。

### Q: 发票 POST 后看不到会计凭证

标准会计科目未导入。跑 `npm run db:seed`（幂等），或去 `/operator/accounts` 手动建。

### Q: 前端显示金额是字符串格式（如 "10.00" 而不是 10）

API 响应没过 `serializeApi()` 序列化。检查对应 route.ts 是否 import 并包装过返回值。Sprint 3 已经给所有主 API 加了包装，若新增 API 记得也加。

---

## 八、应急联系

生产事故升级顺序：

1. 页面挂掉 → 看 Sentry 最近错误
2. Sentry 没发现 → 看 Cloud Run logs
3. Logs 一片 EPIPE / DB 连不上 → 看 Neon 状态页
4. 全挂 → 执行回滚剧本（第六章）
5. 15 分钟内没解决 → 给技术负责人打电话
