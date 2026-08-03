# 私有化部署与数据库迁移设计（DO droplet）

> 上游：`docs/20260802-private-deployment-server-enablement-plan.md`（服务器摸底与阶段划分）、
> `docs/20260802-single-system-memory-and-perf.md`（单系统内存重算与性能实测）、
> `docs/20260729-api-integration-and-private-deployment-plan.md`（改造方案）。
>
> 本文是**执行级设计**：把「迁到客户自有服务器」从方向落成具体架构、具体改动、具体步骤。
> 上游文档回答「够不够跑」「值不值得迁」；本文回答「怎么迁、按什么顺序、每步怎么验证」。
>
> 决策日期：2026-08-02。前提变更：**Odoo 12 不部署到这台机，只放新系统**，
> 因此上游文档 §2 B2（内存不足需升配）与 §3 目标架构（双系统隔离）在本文中均已作废。

---

## 0. 已确认的决策

| # | 决策项 | 结论 | 说明 |
|---|---|---|---|
| D1 | 服务器区域 | **沿用现有 DO lon1（伦敦）`167.99.86.19:2200`** | 数据出境（EU→UK）需在验收文档补一条书面记录，见 §8 |
| D2 | 镜像交付 | **GitHub Actions 构建 → 推 GHCR → 服务器 pull** | 不在 2 vCPU 机器上构建；GHCR 非 GCP 专有，符合部署铁律 |
| D3 | 数据库切换 | **先完整演练一次，再择日正式冷切** | 880 MB，逻辑复制的复杂度不值得 |
| D4 | 上传文件落点 | **本地磁盘 `/data/veggie/uploads`，备份同步到 S3 兼容存储** | 见 §1.3 的实测：存量为 0，无数据搬迁 |
| D5 | 域名 / TLS | **客户自有域名的子域 + Let's Encrypt** | 子域名待定，是唯一真正卡路径的阻塞项 |
| D6 | 回滚窗口 | **Cloud Run + Neon 保留 2 周**，不接流量、不删 | 出事可在 10 分钟内切回 |
| D7 | 执行方式 | **由 Claude 直接 SSH 执行**，全程记录进部署手册 | 写操作前告知，只读排查不打断 |

---

## 0.5 阶段总表（执行顺序 ≠ 章节顺序）

本文按「先讲清架构、再讲改动」组织，章节顺序与执行顺序不一致。以执行顺序为准：

| 阶段 | 内容 | 详见 | 前置依赖 | 可否并行 |
|---|---|---|---|---|
| **0** | 收齐阻塞项（子域名、GHCR owner、Spaces 凭据、PGDG 可用性核实） | §9 | 无 | — |
| **1** | 代码解耦（db 双驱动、object-store、next.config）+ 本地全链路验证 | §3 | 无 | ✅ **与阶段 0 完全并行，立即可开工** |
| **2** | 服务器基线（swap/docker/PG/Nginx/TLS/告警） | §6 | 阶段 0 的 B1 子域名（仅 2.6 TLS 那步）、B4 | 2.1–2.5 与 2.7–2.8 不等 B1 |
| **3** | 部署流水线（GHCR + deploy-droplet.yml + systemd timer） | §4 | 阶段 1、2；B2 | — |
| **4** | **演练迁移**（dump/restore/三层校验/闭环） | §5.1 | 阶段 3 | — |
| **5** | **正式切换**（302 停写 → 迁移 → 切换 → 观察） | §5.2 | 阶段 4 全绿；B1 | — |
| **6** | 备份与恢复演练 | §7 | 阶段 5；B3 | — |
| **7** | 交接与合规文档 | §8 | 阶段 6 | — |

回滚窗口（§5.3）横跨阶段 5 之后的两周。

---

## 1. 实测前提（本设计依赖的事实，均已核实）

### 1.1 服务器

DO lon1 / Ubuntu 26.04 LTS / 2 vCPU / 3.8 GB RAM / Swap 0 / 磁盘 77 GB（已用 4%）。
仅装 `python3 3.14` + `git`，无 docker / node / nginx / postgresql。
ufw active（放行 2200/80/443），root 登录关闭、仅密钥、fail2ban 运行中。
账号 `jia`(1000) / `dev`(1001) 均在 sudo 组。

### 1.2 数据库

| 项 | 值 |
|---|---|
| Neon 服务端版本 | **PostgreSQL 17.10** |
| 生产库大小 | **880 MB**（`OrderLine` 644MB/133万行、`Order` 131MB/15万行、`Invoice` 69MB/14.8万行，索引 375MB） |
| Prisma 版本 | 7.7.0 |
| 迁移文件数 | 61 |

> **服务器装 PG 17 与源端主版本一致**，`pg_dump`/`pg_restore` 无跨版本兼容风险。
> 这是本设计敢用「一次冷切」的技术前提。

### 1.3 文件存储存量 —— 关键发现

实测生产库：

```
ProductTemplate.images 含 GCS URL 的行数     = 0
Product.images         含 GCS URL 的行数     = 0
两表 images 数组 unnest 后的全部元素          = 空集
PurchaseOrder.sourceDocumentUrl 非空行数     = 1  （purchase-docs/test.pdf，测试文件）
```

**结论：GCS 桶里没有任何真实业务数据。**
文件迁移这件事在本次范围内**不存在**——不需要 rsync 对象、不需要 URL 订正脚本、
不需要为兼容旧绝对 URL 写回退逻辑。只需要把代码从 `@google-cloud/storage` 解耦。

⚠️ 这个结论有**时效性**：一旦客户开始上传商品图，存量就不再是 0。
正式切换当天必须重跑一次上面的计数，若已非 0 则追加一步对象拷贝 + URL 订正。
该复核已写入 §5 正式切换清单。

### 1.4 代码层耦合点（复查后为 3 处，非上游文档说的 2 处）

| 文件 | 耦合 |
|---|---|
| `lib/db.ts` | 写死 `PrismaNeon` + `@neondatabase/serverless`（WebSocket），未装 `@prisma/adapter-pg` |
| `app/api/upload-image/route.ts` | 直连 `@google-cloud/storage`，返回硬编码的 `https://storage.googleapis.com/...` 绝对 URL |
| `app/api/purchase-orders/pdf-extract/route.ts` | 同上 |
| `next.config.ts` | CSP 与 `images.remotePatterns` 硬编码 `storage.googleapis.com`、`wss://*.neon.tech` |

`lib/storage/backup-store.ts`（备份落点）**已完成**三驱动抽象（`local|s3|gcs`），不在本次改造范围。

### 1.5 现有镜像已经具备私有化条件

`Dockerfile` 为 `node:20-alpine` 多阶段 + Next.js `output: 'standalone'`，
运行时层已装 `chromium`、`font-noto-cjk`、`font-noto-emoji`、`postgresql17-client`。
**镜像本身不含任何 GCP 依赖**，可直接在 droplet 上运行，无需为私有化重写 Dockerfile。

---

## 2. 目标架构

```
                        Internet :443
                             │
                  ┌──────────┴──────────┐
                  │  Nginx（宿主机 apt） │   certbot 自动续期
                  │  server_name: app.<客户域名>
                  └──────┬───────┬──────┘
            proxy_pass   │       │  alias（sendfile 直出，不经 Node 进程）
         127.0.0.1:3000  │       │  location /uploads/ → /data/veggie/uploads/
                         ▼       ▼
            ┌────────────────────────────────┐
            │ docker compose project: veggie │
            │  image: ghcr.io/<owner>/veggie │
            │  ports: 127.0.0.1:3000:3000    │  ← 只绑回环，不对外
            │  volumes:                      │
            │    /data/veggie/uploads:/data/uploads
            │    /var/run/postgresql:/var/run/postgresql   ← 宿主机 PG socket
            │  env_file: /etc/veggie/app.env │
            └───────────────┬────────────────┘
                            │ unix socket，无 TCP、无 TLS 握手
            ┌───────────────▼────────────────┐
            │ PostgreSQL 17（宿主机 apt/PGDG）│
            │  listen_addresses = ''          │  ← 完全不监听网络
            │  shared_buffers = 1GB  > 整库 880MB
            │  /var/lib/postgresql/17/main    │
            └─────────────────────────────────┘

   /data/veggie/{uploads,backups}     属主 veggie:veggie，chmod 750
   /etc/veggie/app.env                属主 veggie:veggie，chmod 600
```

### 2.1 为什么 PostgreSQL 装宿主机而不是容器

1. **数据卷不经过 Docker**。换镜像、重装 Docker Engine、compose 版本变更都碰不到 `/var/lib/postgresql`。容器化时数据在 volume 里，多一层间接和一类权限故障。
2. **接手成本**。客户或第三方运维接管时，`sudo -u postgres psql`、`pg_dump`、`systemctl status postgresql` 是通用常识；`docker exec -it veggie-db psql` 需要先理解 compose 项目结构。合同要求「乙方不得以任何方式限制甲方访问、导出、备份或接管」，降低接手门槛是这条的实质落地。
3. **备份脚本更简单**。宿主机 cron 直接 `pg_dump`，不用套 `docker exec`，也不会因为容器没起而静默失败。
4. **unix socket 可用**（见 2.2）。

代价：版本管理靠 apt 而非镜像 tag。用 PGDG 官方源锁 17 主版本即可，`unattended-upgrades` 只会打小版本安全补丁，不会跨主版本。

### 2.2 为什么走 unix socket 而不是 TCP

app 容器挂载宿主机 `/var/run/postgresql`，连接串：

```
DATABASE_URL="postgresql://veggie@localhost/veggie?host=/var/run/postgresql"
```

- 省掉 TCP 握手与 loopback 协议栈开销（相比现在跨机房的 14 ms，这一项已是噪声，但没有理由不要）
- **更重要的是安全**：PostgreSQL 可以配 `listen_addresses = ''`，**完全不监听任何网络端口**。
  数据库的网络攻击面直接归零，ufw 规则、密码强度、`pg_hba` 的 host 段全都变成不适用。
  认证走 socket 的 peer/scram，权限由文件系统属主控制。

⚠️ 实施注意：容器内的 uid 必须能读该 socket 目录。Dockerfile 里运行用户是 `nextjs`(uid 1001)。
宿主机上 `/var/run/postgresql` 属主为 `postgres:postgres` `chmod 2775`。
需要把宿主机 `postgres` 组 gid 传给容器（`group_add:` 或直接令容器以匹配的 gid 运行）。
这一条在阶段 1 的本地 compose 验证里必须先跑通，不留到服务器上试。

### 2.3 Nginx 直接托管 /uploads

上传文件由 Nginx `alias` 直出，不经 Node 进程。理由：静态文件走 sendfile 是 Nginx 的强项，
而 Next.js standalone 进程内存已按 `--max-old-space-size=768` 收紧，没必要让它做文件转发。

对应地，`object-store` 的 local driver 返回的公开 URL 是**相对路径** `/uploads/products/xxx.jpg`，
不是绝对 URL。这样换域名、加 CDN 都不需要改数据。

---

## 3. 代码解耦设计（阶段 1）

三处改动，都不碰服务器，可与阶段 0 的等待完全并行。

> ⚠️ 本项目 Next.js 为 16.2.3，`AGENTS.md` 要求：动代码前先读 `node_modules/next/dist/docs/` 下的相关指南，
> 不要按训练数据里的 Next.js 惯例写。涉及 `next.config.ts` 与路由处理的改动尤其要核对。

### 3.1 `lib/db.ts` 双驱动

```
DATABASE_DRIVER = 'neon' | 'pg'
  未设置时的推断：DATABASE_URL 含 'neon.tech' → neon，否则 pg
```

- `pg` 分支用 `@prisma/adapter-pg`（版本对齐 `^7.7.0`）+ `pg`
- **Neon 分支原样保留**。回滚窗口内 Cloud Run 还要跑，且铁律明确「为 Neon 写的迁就不要提前去掉」
- Prisma schema 不动，`prisma/migrations` 不动

### 3.2 `lib/storage/object-store.ts`（新建）

照抄 `lib/storage/backup-store.ts` 已验证的形状——同样的 driver 枚举、同样的
`ConfigError(缺哪几个环境变量)` 报错风格。这是刻意的 DRY：两个模块解决的是同一类问题，
不该长出两套接口语义。

```
export type ObjectStoreDriver = 'local' | 's3' | 'gcs'

interface ObjectStore {
  put(objectPath: string, body: Buffer, contentType: string,
      meta?: Record<string,string>): Promise<{ url: string }>
  remove(objectPath: string): Promise<void>
  describe(): string
}
```

| driver | 落点 | 返回的 url |
|---|---|---|
| `local` | `${UPLOAD_DIR}/${objectPath}`，默认 `UPLOAD_DIR=/data/uploads` | `/uploads/${objectPath}`（相对路径） |
| `s3` | 复用已有 `S3_*` 四个变量 | 桶的公开 URL 或签名 URL |
| `gcs` | 遗留兼容，仅为不打断 Cloud Run | 现有绝对 URL |

改造调用点：`app/api/upload-image/route.ts`、`app/api/purchase-orders/pdf-extract/route.ts`。
两处的鉴权、限流、类型/大小校验逻辑保持不变，只替换存储调用与 URL 生成。

**local driver 的路径安全**：`objectPath` 必须经白名单校验（只允许 `[A-Za-z0-9._/-]`，
且 resolve 后必须仍在 `UPLOAD_DIR` 内），防止 `../` 穿越。现有代码的 objectPath 由
`Date.now()` + `crypto.randomUUID()` + 扩展名拼出，不含用户输入，但抽象层不能依赖调用方的自觉。

### 3.3 `next.config.ts` 去云化

- CSP 的 `img-src` / `connect-src` 里的 `storage.googleapis.com`、`wss://*.neon.tech`、`https://*.neon.tech` 改为按环境拼接：私有化下两者都不需要，Cloud Run 下仍需要
- `images.remotePatterns` 同理。`/uploads/*` 是同源，不需要 remotePattern
- Sentry / Google Maps / Pexels 的条目不动（与主机无关的 SaaS，铁律豁免）

### 3.4 本地端到端验证（⛔ 硬性关卡）

在**自己机器上**用 docker compose 起「标准 PostgreSQL 17 + `STORAGE_DRIVER=local` +
`DATABASE_DRIVER=pg` + unix socket 挂载」，跑通完整业务闭环：

```
登录 → 下单 → 确认（扣库存）→ 拣货波次 → 派车 → 确认出发
     → 司机签收（手写电子签）→ 生成发票 → 打印 6 类单据（含 PDF/中文字体）
     → 财务确认交账 → 触发一次备份 → 从备份恢复到临时库
```

外加 `npm run build`、`npm run typecheck`、`npm test`、`npm run db:validate`。

**驱动切换的所有问题必须在这一步暴露完。不拿客户服务器当试错环境。**
特别是 2.2 提到的 socket 权限、Prisma 7 的 adapter-pg 行为差异、
以及本地磁盘 driver 下的文件权限，都只有真跑一遍才知道。

---

## 4. 部署链路设计（阶段 3）

### 4.1 新工作流 `.github/workflows/deploy-droplet.yml`

```
on: push to main（paths 过滤沿用现有 deploy.yml 的清单）+ workflow_dispatch
concurrency: deploy-droplet（不取消进行中的部署）

job:
  1. checkout
  2. docker/login-action → ghcr.io（GITHUB_TOKEN，permissions: packages: write）
  3. docker/build-push-action → ghcr.io/<owner>/veggie:${{ github.sha }} + :latest
     （启用 GitHub Actions cache，避免每次全量重建）
  4. appleboy/ssh-action 或原生 ssh：
       set -e
       cd /opt/veggie
       docker compose pull
       docker compose run --rm app npx prisma migrate deploy   ← 先迁移
       docker compose up -d                                     ← 后换镜像
       ./healthcheck.sh                                         ← 失败则回滚（本阶段新建，放服务器 /opt/veggie）
```

**「先迁移后部署」**沿用现有 `cloudbuild.yaml` 已验证的顺序：加列这类增量变更下，
旧代码对多出来的可空列前向兼容，反过来（先部署后迁移）会出
「镜像 client 期望新列、库还没有」的 ColumnNotFound 500。

**Neon pooler 的 `-pooler` 去除 hack 在私有化后不再需要**（无 pgbouncer，
会话级 `pg_advisory_lock` 正常工作），但按铁律现在不动，切换完成后再清理。

**健康检查与回滚**：`up -d` 后轮询 `curl -f localhost:3000/api/health`，
30 秒内不通则 `docker compose up -d` 回上一个 sha tag 并让 job 失败。
镜像用 sha tag 而非 latest，回滚才有确定的目标。

### 4.2 凭据边界

| 东西 | 放哪 | 理由 |
|---|---|---|
| SSH 私钥 | GitHub Secrets `DROPLET_SSH_KEY` | **新建专用 `deploy` 系统用户的独立密钥**，不复用 `dev`/`jia` 的人类密钥。该用户只能操作 `/opt/veggie` 的 compose 与 docker，不给全量 sudo |
| 应用密钥 | 服务器 `/etc/veggie/app.env`（600，属主 veggie） | 无 Secret Manager 依赖，符合铁律；`docker compose` 用 `env_file:` 读取 |
| GHCR 拉取凭据 | 服务器上 `docker login ghcr.io` 用一个只读 PAT | 仓库私有时需要；公开镜像可省 |

仓库内零凭据。

### 4.3 定时任务

现有 cron 路由只有一个：`/api/cron/backup-database`。

服务器上用 **systemd timer**（非 crontab，理由是有 journal 日志、有失败状态、
`systemctl list-timers` 可见）：

```
veggie-backup.timer  →  veggie-backup.service
    ExecStart=/usr/bin/curl -fsS -X POST -H "Authorization: Bearer ${CRON_SECRET}" \
              http://127.0.0.1:3000/api/cron/backup-database
```

路由形状不变——「任何东西都能 POST 触发」，符合铁律对 cron 的要求。

### 4.4 与现有 Cloud Run 链路的关系

回滚窗口的 2 周内**两套工作流并存**：

- `deploy.yml`（Cloud Run）：改为仅 `workflow_dispatch` 手动触发，不再自动跑
- `deploy-droplet.yml`：接管 push to main

窗口结束后删除 `deploy.yml`、`cloudbuild.yaml`，并在 §7 清理清单里一并处理。

---

## 5. 数据迁移设计（阶段 4–5）

### 5.1 演练轮（Neon 只读，不影响生产）

| 步 | 动作 | 验证 |
|---|---|---|
| 1 | droplet 装 `postgresql-client-17`，直连 Neon `pg_dump -Fc --no-owner --no-acl -f veggie.dump` | dump 文件大小合理（预计 200–400 MB 压缩后）；`pg_restore -l` 能列出对象清单 |
| 2 | 本地 PG 建 `veggie` 角色与库，`pg_restore -j2 -d veggie veggie.dump` | 退出码 0；warning 逐条看过（`--no-owner` 下的 owner warning 可忽略，其余不可） |
| 3 | **逐表行数比对**：脚本对两端所有表跑 `count(*)` 并 diff | 零差异。任何一张表对不上就停，不进入下一步 |
| 4 | `prisma migrate status` | 61 个迁移全部 applied，无 pending、无 failed |
| 5 | `npm run db:validate` | 业务不变量与 Neon 端结果一致（已知的 895 个历史不守恒商品属存量问题，比对的是「一致」不是「干净」） |
| 6 | 起应用跑 §3.4 的完整闭环 | 全通过 |
| 7 | 记录每步实际耗时 | → 这就是正式窗口时长的依据，不靠估 |

> 直接在 droplet 上 `pg_dump` 连 Neon（伦敦→法兰克福一跳），
> 比「本地拉下来再传上去」少一跳、少一次落盘。

### 5.2 正式轮

**前置复核（当天必做）**：

1. 重跑 §1.3 的文件存量计数。若 `images` 已非空 → 追加对象拷贝 + URL 订正步骤，
   否则跳过。**这一条不能凭 8 月 2 日的结论跳过**。
2. 确认演练轮之后 `prisma/migrations` 没有新增迁移；有则演练结论需要复核。

**停写方案 —— 本设计与上游文档的关键分歧点**：

> 上游计划写的是「切 DNS」。但客户当前访问的是 Cloud Run 的 `*.run.app` 地址，
> **没有自定义域名，所以「切 DNS」这条路根本不存在**。
> 正式切换必然伴随对外 URL 变更。

处理方式：**在 Cloud Run 上部署一个只做 302 跳转到新域名的极简镜像**。

- 老书签、老链接自动过去，不需要逐个通知用户改地址
- 部署这个镜像的瞬间就是停写点——旧应用不再接受任何写入，天然实现「停写」
- 回滚只需把 Cloud Run 换回上一个正常镜像（Neon 原库始终未动）

窗口内顺序：

```
部署 302 镜像到 Cloud Run   ← 停写点，此后 Neon 只读
  → 重做 5.1 的 1–5 步（dump / restore / 三层校验）
  → 切 app.env 的 DATABASE_URL 指向本地 PG，DATABASE_DRIVER=pg
  → docker compose up -d
  → 跑闭环冒烟
  → 通知客户新地址
```

**回滚判据（必须事先写死，不临场判断）**：
5.1 第 3 步行数比对有任何差异、或第 4 步 migrate status 非全 applied、
或闭环冒烟任一环节失败 → 立即把 Cloud Run 换回正常镜像，本次窗口作废，
Neon 侧零改动所以无损失。

### 5.3 回滚窗口（2 周）

- Neon 生产库：**不删、不改、不停**
- Cloud Run：保留 302 镜像与上一个正常镜像的 tag
- 窗口内若需回滚：Cloud Run 换回正常镜像（约 2 分钟）+ 停掉 droplet 的 Nginx。
  代价是切换后在新系统产生的写入会丢失——所以窗口内每天做一次 droplet → 异地的备份，
  真要回滚时至少有据可查。

---

## 6. 服务器基线（阶段 2）

按顺序执行，每步有验证命令，全程记入《服务器基线配置记录》。

| # | 动作 | 验证 |
|---|---|---|
| 2.1 | 加 2 GB swap 文件，`vm.swappiness=10`，写入 `/etc/fstab` | `free -h` 显示 swap；重启后仍在 |
| 2.2 | 时区设 `Europe/Dublin` | `timedatectl` |
| 2.3 | 装 Docker Engine + compose plugin（官方源） | `docker compose version` |
| 2.4 | 建系统用户 `veggie`、`deploy`；建 `/data/veggie/{uploads,backups}`、`/opt/veggie`、`/etc/veggie`，权限如 §2 图 | `namei -l` 逐级核对属主与权限 |
| 2.5 | 装 PostgreSQL 17（PGDG 源）；建 `veggie` 角色与库；应用调优参数 | `psql -c 'select version()'` 为 17.x；`show shared_buffers` 为 1GB |
| 2.6 | 装 Nginx + certbot，签发证书，配置自动续期 | `curl -I https://<域名>` 200；`certbot renew --dry-run` 通过 |
| 2.7 | ufw 复核：仅 2200/80/443；确认 PG `listen_addresses=''`；容器只绑 127.0.0.1 | 外部 `nmap` 只见 3 个端口；`ss -tulnp` 无 5432 |
| 2.8 | 内存/磁盘告警（超阈值发邮件或 webhook） | 手工触发一次告警，确认收到 |

**PostgreSQL 调优参数**（依据 `docs/20260802-single-system-memory-and-perf.md` 的实测）：

```conf
listen_addresses = ''             # 只走 unix socket，不监听网络
shared_buffers = 1GB              # 大于整库 880MB，预热后稳态零磁盘读
effective_cache_size = 2GB
work_mem = 16MB
maintenance_work_mem = 256MB
random_page_cost = 1.1            # SSD；默认 4.0 是机械盘假设，会让规划器过度偏向 Seq Scan
effective_io_concurrency = 200
max_connections = 50              # 单应用，不需要几百
```

⚠️ **需先核实 PGDG 是否已提供 Ubuntu 26.04（`plucky`/对应代号）的仓库**。
若尚未提供，退路是用上一个 LTS 代号的仓库或改用 PostgreSQL 官方容器——
这一条在阶段 2 开工第一件事就要确认，不要假设可用。

---

## 7. 备份与恢复（阶段 6，合同硬要求）

| 合同条款 | 落地 |
|---|---|
| 数据库定期自动备份 | systemd timer 触发 `/api/cron/backup-database`（每日全量），保留 7 日 + 4 周 + 6 月 |
| 程序文件及上传文件定期备份 | `tar` 打包 `/data/veggie/uploads` + `/etc/veggie/app.env`（加密） |
| 至少一份保存在不同位置 | `BACKUP_DRIVER=s3` → DigitalOcean Spaces（已有 driver 现成可用，见 `docs/20260802-backup-storage-config.md`） |
| 备份可正常恢复 | **必须做一次真实恢复演练**：在临时库里恢复出可登录的实例，跑通闭环，出具报告 |
| 甲方可取得完整备份文件 | 交付备份目录访问方式 + 《备份与恢复操作手册》 |

⛔ 「有备份文件」不等于「备份可恢复」。审计已实测过现有备份**3 次全失败**且错误信息
无法定位（`docs/20260802-contract-feature-audit-tasks.md`）。恢复演练必须写进验收清单。

---

## 8. 交接与合规（阶段 7）

- 《服务器部署与运维手册》：架构图、每个服务的启停、日志位置、常见故障处理
- 《备份与恢复操作手册》：含恢复演练的实际记录
- 《系统交接清单》：服务器 sudo、数据库超级用户、应用管理员、备份凭据、GHCR、源码仓库权限
- **账号由甲方自己创建或当场改密**，不是我方建好再"共享"——合同要求「乙方不得以任何方式限制甲方访问、导出、备份或接管」
- **数据居留书面记录**：服务器位于 DO lon1（英国），客户为爱尔兰实体，EU→UK 属 GDPR 意义上的跨境传输。
  客户已选择沿用该区域，需在验收文档中记录此决策及告知事实
- 保修期响应机制书面化（合同第十三条：6 个月免费保修，24 小时响应）

---

## 9. 阻塞项与依赖

| # | 需要什么 | 来自谁 | 阻塞谁 | 状态 |
|---|---|---|---|---|
| B1 | **子域名**（如 `app.<客户域名>`）+ 客户 DNS 加 A 记录 → `167.99.86.19` | 客户 | 阶段 2.6 TLS 签发、阶段 5 正式切换 | ⛔ **未定，唯一真正卡路径的项** |
| B2 | GitHub 仓库 owner 名（GHCR 镜像路径） | 用户 | 阶段 3 部署流水线 | 待确认 |
| B3 | DO Spaces 桶 + 4 个 `S3_*` 凭据 | 用户/客户 | 阶段 7 备份 | 待确认，不阻塞前面 |
| B4 | PGDG 是否支持 Ubuntu 26.04 | 我方核实 | 阶段 2.5 | 阶段 2 开工首件事 |

阶段 1（代码解耦）与阶段 0 的等待**完全并行**，不被任何阻塞项挡住，应立即开工。

---

## 10. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| unix socket 的容器内权限问题 | 应用连不上库，且只在服务器上才暴露 | §3.4 本地 compose 验证必须包含 socket 挂载，不留到服务器试 |
| PGDG 尚未支持 Ubuntu 26.04 | 阶段 2.5 卡住 | B4 提前核实；退路是官方容器镜像 |
| 迁移后发现 Prisma 7 的 adapter-pg 行为与 adapter-neon 有差异 | 运行时报错 | §3.4 跑完整闭环 + 全部测试；差异在本地暴露 |
| 单机单点，服务器挂了全停 | 业务中断 | 合同未要求高可用；靠异地备份 + 恢复手册作为最低限度的业务连续性保障 |
| URL 变更导致客户找不到系统 | 用户体验 | Cloud Run 302 跳转 + 提前通知；302 保留至回滚窗口结束后再延长一段 |
| 8 月 2 日的「文件存量为 0」结论过期 | 图片丢失 | §5.2 前置复核，当天重跑计数 |
| 内存峰值超预期触发 OOM | 服务被杀 | swap 兜底 + 内存告警 + 切换后连续观察一周实际峰值（验证 §1 的 2.4–2.7 GB 估算） |

---

## 11. 完成判据

全部满足才算迁移完成：

- [ ] `npm run build` / `typecheck` / `test` / `db:validate` 全绿
- [ ] 新域名 HTTPS 可访问，证书有效且 `certbot renew --dry-run` 通过
- [ ] 逐表行数与 Neon 零差异；`prisma migrate status` 61 个全 applied
- [ ] §3.4 的完整业务闭环在生产环境跑通（含 PDF 中文字体、手写签收、备份）
- [ ] 未登录访问受保护路由正确跳转；错误凭据返回 401 不崩溃；不存在的资源返回 404
- [ ] 服务器日志无 error 级别条目
- [ ] 备份自动触发成功，且**完成一次真实恢复演练**并出具报告
- [ ] PG 不监听任何网络端口（`ss -tulnp` 无 5432）；外部扫描只见 2200/80/443
- [ ] 三份手册 + 交接清单交付，账号已由甲方掌握
- [ ] 连续观察一周，内存峰值未触及 3.8 GB 上限
