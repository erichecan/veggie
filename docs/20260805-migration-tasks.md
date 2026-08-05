# 迁移台账：GCP + Neon → 客户自有服务器

> **本文是迁移执行阶段的唯一真相。** 每周期：读台账 → 取第一条未完成 → 做 → 验证 → 提交 → 回写。
>
> 前置：服务器基线已就绪（`docs/20260805-server-baseline.md`），阶段 2 除 TLS 外全部完成。
> 台账（阶段 2/3）：`docs/20260804-server-enablement-tasks.md` · 设计：`docs/20260802-private-deployment-migration-design.md`
>
> **本轮范围**：把应用和数据搬到 `167.99.86.19`，跑起来、验证得动。
> **本轮明确不做**（用户 2026-08-05 指示）：域名 / DNS / TLS 证书 / 发信功能。
> 因此访问入口暂时是 `http://167.99.86.19`（Nginx 已 `default_server` 监听 80）。

---

## 迁移前的已知事实

| 项 | 值 | 来源 |
|---|---|---|
| Neon 主机 | `ep-icy-rice-al9r6fgz-pooler.c-3.eu-central-1.aws.neon.tech`（法兰克福） | Secret Manager `VEGGIE_DATABASE_URL` |
| 库名 | `veggie` | 同上 |
| 库大小 | 约 880 MB（`OrderLine` 644MB/133万行 + `Order` 131MB/15万行，索引 375MB） | 20260802 实测 |
| GCS 上传桶 | `gs://veggie-supply-images`，**仅 205 KB**，只有 `purchase-docs/` 一个前缀 | 本次实测 |
| 目标库 | droplet 本机 PostgreSQL 17.10，库 `veggie` owner `veggie`，走 unix socket + peer | `docs/20260805-server-baseline.md` §2.5 |
| 镜像仓库 | `ghcr.io/erichecan/veggie`（**仓库是 PRIVATE → 包也私有**） | `gh repo view` |
| gh CLI | 已认证 `erichecan`，scopes `repo, workflow`（**无 `write:packages`**，但 Actions 内用 `GITHUB_TOKEN` 即可） | `gh auth status` |

---

## M1 数据库迁移（Neon → droplet）

- [ ] **M1.1 在 droplet 上直接 `pg_dump` Neon**（不经本机中转，少一跳）

  ⚠️ 连接串里的 host 带 `-pooler`。**pg_dump 不能走 pooler**（pgbouncer 事务模式不支持
  dump 需要的会话级特性），必须用去掉 `-pooler` 的直连端点。这条不验就跑，会得到
  一个看起来成功、实际不完整或直接报错的结果。

  **验收**：`-Fc` 自定义格式产物存在且 `pg_restore -l` 能列出对象清单；记录字节数与耗时。

- [ ] **M1.2 `pg_restore` 进本地 `veggie` 库**

  **验收**：restore 退出码 0，或仅有可解释的告警（如 owner 不存在）。逐条说明每一类告警。

- [ ] **M1.3 ⛔ 逐表核对，不是"看着像对"**

  **验收**：源库与目标库的**每一张表行数完全一致**（脚本比对，不是抽查）；
  `_prisma_migrations` 条数一致且最后一条相同；序列 `last_value` 已同步；
  `npx prisma migrate status` 显示无待应用迁移。

## M2 应用上机

- [ ] **M2.1 配 GitHub Secrets / Variables**（`gh` CLI 自动配，值见阶段 2 台账）
- [ ] **M2.2 ⛔ 工作流补 droplet 端 GHCR 登录**

  现 `deploy-droplet.yml` 在服务器上直接 `docker compose pull`，**但从没让服务器登录过 GHCR**。
  仓库是 private → 包也是 private → 首次 pull 必然 401。用 job 内的 `GITHUB_TOKEN`
  （有 `packages: read`）在 ssh 里临时 login，不额外存长期 PAT。

- [ ] **M2.3 `/opt/veggie/` 编排 + `/etc/veggie/app.env`**

  ⚠️ `JWT_SECRET` 必须与现生产同值（Secret Manager `VEGGIE_JWT_SECRET`），否则切换瞬间所有已登录用户被登出。

- [ ] **M2.4 首次部署**（`workflow_dispatch`）
- [ ] **M2.5 ⛔ 端到端验证**（不是"端口有响应"）

  **验收**：`/api/health` 含 `db:ok`；能登录拿 token；带 token 读到**真实业务数据**（不是空数组）；
  图片上传落盘且属主 1100；**服务端 Chromium 渲染 PDF**（`HOME=/tmp` 那个坑）；未授权访问返回 401。

## M3 对象存储迁移（GCS → `/data/veggie/uploads`）

- [ ] **M3.1** `gs://veggie-supply-images` → `/data/veggie/uploads`，属主 1100
- [ ] **M3.2** 核对文件数与字节数一致；抽一个文件经 Nginx `/uploads/` 取回

## M4 备份（T3.6）

- [ ] **M4.1** `veggie-backup.service` + `.timer`（header 是 `x-cron-secret`，不是 Bearer）
- [ ] **M4.2** 手工触发一次，**确认备份产物真实生成**（不是只看 200）

## M5 收尾

- [ ] **M5.1** `deploy.yml`（Cloud Run）降为仅 `workflow_dispatch`
- [ ] **M5.2** 回写 `docs/20260805-server-baseline.md` 与本文

---

## 进度回写区

| 任务 | 完成时间 | 证据 | 备注 |
|---|---|---|---|
| （待填） | | | |

## 未解决问题

- 本轮的 dump 是**某一时刻的快照**。真正切流量那天必须重做一次增量/全量 dump，
  否则丢掉两次 dump 之间的生产数据。本轮不处理，但不要忘。
