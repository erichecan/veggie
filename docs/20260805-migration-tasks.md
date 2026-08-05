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

- [x] **M1.1 ✅** 在 droplet 上直接 `pg_dump` Neon —— **82 MB / 25 秒**，`rc=0`

  ⚠️ 连接串里的 host 带 `-pooler`。**pg_dump 不能走 pooler**（pgbouncer 事务模式不支持
  dump 需要的会话级特性），必须用去掉 `-pooler` 的直连端点。这条不验就跑，会得到
  一个看起来成功、实际不完整或直接报错的结果。

  实测确认「不能走 pooler」这条判断本身：直连端点 `ep-icy-rice-al9r6fgz.c-3...`（去掉 `-pooler`）。
  TOC 383 条、48 张表有数据、唯一扩展是 `pg_trgm`（PG13+ 是 trusted，库属主可建）。

- [x] **M1.2 ✅** `pg_restore --no-owner --no-privileges --role=veggie -j 2` —— **rc=0 / 42 秒 / 零 stderr**

  一条告警都没有。`--role=veggie` 让对象直接以 `veggie` 建出来，省掉事后 `ALTER OWNER`。

- [x] **M1.3 ✅ 逐表核对通过**

  ```
  48/48 张表行数完全一致（脚本 diff，非抽查）
  OrderLine 1,337,568 · Order 149,874 · Invoice 148,285 · ProductTemplate 5,482
  _prisma_migrations  两边 63 条、最后一条同为 20260802160000_pickingwave_orderids_gin
                      finished_at 为空的：两边都是 0
  索引 220 / 外键 39  两边一致        序列 0 个（Prisma 用 cuid，无 serial）
  属主               48 张表全部 veggie
  库大小             880 MB → 656 MB
  ```

  **656 < 880 不是丢数据** —— 行数已逐表核对。差额是 Neon 那边的表膨胀与索引碎片，
  重建后自然消失。只看库大小会得出完全相反的结论。

  补跑 `vacuumdb --analyze-only`（`pg_restore` **不生成规划器统计**，缺了它查询计划会很差）：
  `pg_stats` 289 → 547 行；抽查真实查询确认走 `OrderLine_orderId_idx` 而非全表扫。

  部署时 `prisma migrate deploy` 输出 `60 migrations found / No pending migrations to apply.`
  —— 从应用侧再次印证迁移状态与代码库一致。

## M2 应用上机

- [x] **M2.1 ✅** `gh` 配好 `DROPLET_SSH_KEY`/`DROPLET_HOST_KEY` 与 `DROPLET_HOST`/`PORT`/`USER`
- [x] **M2.2 ✅ 工作流补了三处**（全是不补就必然出问题的）

  1. **服务器从没登录过 GHCR** → 仓库 private → 包 private → `docker compose pull` 必 401。
     改用 job 内的 `GITHUB_TOKEN`（有 `packages:read`）临时登录，`trap EXIT` 登出，
     不在服务器上长期存 PAT。
  2. **`migrator` 挂了 `profiles: ["tools"]`**，`pull` 不带 `--profile` 会被静默跳过，
     后面 `run` 就得现拉，等于丢掉「先拉好再动」的保证。
  3. **工作流从不同步 `/opt/veggie/docker-compose.yml`** → 改了仓库里的文件而服务器上
     还是旧的，表现是「明明改好了却没生效」，且没有任何报错指向那个文件。加 Sync 步骤。

- [x] **M2.3 ✅** `/opt/veggie/` 编排（属主 deploy，它要写 `.deployed_tag`）+ `/etc/veggie/app.env`

  `JWT_SECRET` 取自 Secret Manager `VEGGIE_JWT_SECRET`，与现生产同值（切换时不会把人踢下线）。

  ⛔ **台账原先一条假设是错的**：T3.2 写「`deploy` 读不到明文密钥，容器由 root 的 dockerd 启动」。
  但 `env_file` 是 **compose 客户端**读的，不是 dockerd 读的 —— 以 `deploy` 跑 compose 就必须能读，
  首次部署直接报 `open /etc/veggie/app.env: permission denied`。
  而且这个"保护"本来就是幻觉：`deploy` 在 `docker` 组里，`docker run -v /:/host` 就能读任何文件。
  现状：`/etc/veggie` 为 `root:deploy 750`、`app.env` 为 `veggie:deploy 640`；
  `alert.env`/`backup.env` 保持 `root:root 600`，**deploy 仍读不到**（已实测）。

- [x] **M2.4 ✅ 部署成功**，tag `cae970b6`，容器 `Up (healthy)`

  ⛔ **中途踩到最坏的一类失败：工作流报绿而什么都没部署。**
  原写法 `ssh host bash -euo pipefail -s <<EOSSH …` 把脚本从 stdin 喂进去，而
  `docker compose run` **默认接管 stdin**，把脚本剩下的部分整段吃掉 ——
  `migrate` 之后的 `up -d`、`healthcheck`、写 `.deployed_tag` 全没执行，
  bash 读到 EOF 正常退出，退出码 0。日志停在 `No pending migrations to apply.` 之后就没了，
  只有把日志和服务器实际状态（无容器、无 `.deployed_tag`、3000 无监听）对照才发现。

  修法不是加 `-T` 打补丁，而是消掉整类问题：远程脚本改成服务器上的**文件**
  （`deploy/droplet/remote-deploy.sh`，由 Sync 步骤 scp 过去），stdin 与脚本彻底解耦。
  另给 migrator 加 `-T` + `</dev/null` 双保险；GHCR token 也改走 stdin，不进 `ps`。

  还修了 `migrator` 缺 `user: "1100:1100"` —— 它以镜像默认 uid 0 跑，宿主机 peer 认证
  把它映射成 `root`，PG 里没有 `root` 角色，报 `P1010: User was denied access`。
  报错说的是"权限"，很容易往连接串或 `pg_hba` 方向白查，根因其实是 uid。
- [x] **M2.5 ✅ 端到端验证通过**（全部经公网 `http://167.99.86.19` 走 Nginx）

  | 项 | 结果 |
  |---|---|
  | `/api/health` | `{"status":"ok","db":"ok",…}` |
  | 未带 token 访问 `/api/orders` | **401** |
  | 伪造 token | **401** |
  | 错误密码登录 | **401** `{"error":"邮箱或密码错误"}` |
  | 不存在的资源 | **404** |
  | **完整登录流程**（临时账号，验完即删） | **200 + token**，再用该 token 访问 `/api/orders` → **200** |
  | 带 token 读真实数据 | orders 12 KB / products 3.5 MB / customers 1.3 MB，均 200 |
  | 页面 `/` | 200 text/html；`/orders`、`/dashboard` → 307 → `/enter` |
  | 图片上传 | 200，落盘 `-rw-r--r-- veggie veggie`，**属主 1100 正确** |
  | Nginx 直出 `/uploads/…` | 200 `image/png`，带 `expires`/`etag` |
  | **服务端 Chromium 渲染 PDF** | `/api/print/dispatch-summary-pdf` → **101,124 字节真 `%PDF-`**（`HOME=/tmp` 陷阱已避开） |
  | 容器日志 `EACCES`/`error` | **0 行** |

  临时验证账号已删除，`User` 表回到 51 条。

## M3 对象存储迁移（GCS → `/data/veggie/uploads`）

- [x] **M3.1 ✅** 桶里**只有 1 个对象**（205,342 字节），已搬到 `/data/veggie/uploads/purchase-docs/`，属主 `veggie:veggie`
- [x] **M3.2 ✅** 字节数一致；Nginx `/uploads/` 直出已用另一个文件验过 200

  **顺带查出两件与迁移无关、但值得知道的事**：

  - 数据库里唯一一条 GCS 引用是一张 **CANCELLED 的测试采购单**，指向
    `purchase-docs/test.pdf` —— 而这个文件**在桶里从来就不存在**，生产上早就是坏链。
  - 桶里那个唯一的真实文件**没有任何记录引用**（孤儿）。
  - `ProductTemplate.images` / `Product.images` 里 GCS 地址 **0 条**，商品图根本没用这个桶。

  已把那条绝对 URL 改写成 `/uploads/purchase-docs/test.pdf`（链接依旧是坏的，但至少
  **库里不再残留任何指向 GCP 的地址**）。复核：三处 GCS 引用计数全为 0。

## M4 备份（T3.6）

- [x] **M4.1 ✅** `veggie-backup.service` + `.timer`，每日 03:15（`Persistent=true`，关机错过会补跑）
- [x] **M4.2 ✅ 备份产物真实生成并校验过内容**

  ```
  /data/veggie/backups/backups/2026-08-05T04-07-05-176Z-…sql.gz   82 MB (85,149,558 字节)
  gzip -t          ✅ 完整性校验通过
  zcat | wc -l     1,665,909 行
  zcat | grep -c "^COPY "   48   ← 与库里 48 张表吻合
  ```

  `curl` 加了 `--fail-with-body`：**没有它，路由返回 401/500 时 curl 仍退出 0，
  备份失败会被 systemd 记成成功** —— 这次恰好靠它抓到了下面这个错。

  ⚠️ 产物路径是 `/data/backups/backups/…`（多一层）。因为对象 key 自带 `backups/` 前缀，
  那是为对象存储设计的，`local` driver 直接拼在 `BACKUP_LOCAL_DIR` 后面。功能无碍，
  **但交接时会让人困惑**，B3（DO Spaces）到位改 `s3` 后这层嵌套自然消失。

## M5 收尾

- [ ] **M5.1 ⛔ 刻意没做**：`deploy.yml`（Cloud Run）**保持自动触发**。

  理由：域名/DNS 本轮不做，**客户此刻仍在用 Cloud Run 那个入口**。现在把它降为手动，
  等于此后任何 push 都不再更新用户真正在用的系统。这一步应该和切流量同时做，不能提前。

- [x] **M5.2 ✅** 回写本文

---

## 进度回写区

| 任务 | 完成时间 | 证据 | 备注 |
|---|---|---|---|
| M1 数据库迁移 | 2026-08-05 | `4ac03ca` | 82MB dump/25s，restore 42s，48 表逐表一致 |
| M2.1/M2.3 凭据与编排 | 2026-08-05 | `4ac03ca` | gh 配 Secrets/Vars；app.env 600→640(compose 客户端要读) |
| M2.2 工作流三处修补 | 2026-08-05 | `4ac03ca` `1f8f9f1` | GHCR 登录、--profile tools、同步编排文件 |
| M2.4 首次部署成功 | 2026-08-05 | `cae970b6`(镜像 tag) | 修掉 stdin 被吞与 migrator uid 两个坑后 |
| M2.5 端到端验证 | 2026-08-05 | 本次 | 含真实登录流程、Chromium PDF 101KB、上传属主 1100 |
| M3 对象存储 | 2026-08-05 | 本次 | 桶里仅 1 个孤儿文件；库内 GCS 引用清零 |
| M4 备份 | 2026-08-05 | 本次 | 82MB gzip 校验通过、48 个 COPY；timer 每日 03:15 |

## 未解决问题

- ⛔ **本轮的 dump 是 2026-08-05 04:19 的快照。** 从那一刻起，客户在 Cloud Run 上产生的
  新数据都不在 droplet 里。真正切流量那天必须停写 → 重做一次全量 dump → 再切，
  否则丢掉中间所有生产数据。**这是本轮唯一一个会造成真实数据丢失的点。**
- droplet 上的 `PurchaseOrder` 有一条 URL 被改写过（`test.pdf`），切换时重做 dump 会覆盖掉，
  需要重跑一次同样的 `update`。改写语句见 M3.2。
- 备份只落本机 `/data/veggie/backups`，**不满足合同「异地留存」条款**，等 B3（DO Spaces）。
- 访问入口目前是 `http://167.99.86.19`，**明文 HTTP**。按用户指示本轮不做 TLS。
