# 容灾方案：Cloud Run 退役后的退路

> 背景：用户 2026-08-05 决定 Cloud Run 最终会删除。删掉之后，「droplet 出事了怎么办」
> 不再有「把流量指回 Cloud Run」这个答案，必须另建退路。
>
> 前置：`docs/20260805-server-baseline.md`（基线）、`docs/20260805-migration-tasks.md`（迁移台账）

---

## 先把「出事」拆开——三种故障，退路完全不同

把它们混在一起谈是没法做方案的。

| # | 故障 | 表现 | 现在有没有退路 |
|---|---|---|---|
| **F1** | 部署了坏版本 | 新镜像起不来 / `/api/health` 不返回 `db:ok` | ✅ **已有，且不依赖 Cloud Run** |
| **F2** | 应用或数据库进程挂了，机器还在 | 502 / 连不上库 | ⚠️ 部分 |
| **F3** | 整台机器没了（盘坏、误删、勒索、机房故障） | 什么都没了 | ⛔ **目前没有** |

**Cloud Run 只对 F3 有一点点用**（而且也只是「有个旧版本能跑」，数据还在 Neon）。
真正需要补的是 F3，而补 F3 的关键从来不是「留一个备用环境」，是**异地备份 + 可复现的重建**。

---

## F1 部署了坏版本 —— 已解决，无需 Cloud Run

`deploy/droplet/healthcheck.sh` 在 `up -d` 之后轮询 `/api/health`，**只认 `"db":"ok"`**
（单看 HTTP 200 不够：应用起得来但连不上库时也会返回 200，那种状态下用户看到的是满屏 500）。
60 秒内不健康就自动 `TAG=<上一个 sha> docker compose up -d` 回滚，并以非零码退出让 CI 变红。

关键设计：

- 镜像用 **sha tag 而不是 latest** —— 回滚才有确定目标
- 上一个成功版本记在 `/opt/veggie/.deployed_tag`，**只有健康检查通过才更新**，
  所以回滚目标永远是「最后一个真正健康过的版本」
- `remote-deploy.sh` 保留当前 + 上一个共两个 tag 的镜像，不会被清理掉

**已验证**：2026-08-05 首次部署时 `PREV_TAG=<无，首次部署>` 正确识别；
后续部署 `PREV_TAG` 已有值。⛔ **但「故意坏部署 → 自动回滚」这条路径还没真跑过**（台账 T3.5 Step 3），
下一个维护窗口应该演练一次。

---

## F2 进程挂了 —— 补两条

- [x] 应用容器 `restart: unless-stopped`，Docker 会拉起
- [x] PostgreSQL 是 systemd 服务，实测**重启后应用连接池能自愈**（2026-08-05 加
      `pg_stat_statements` 时重启过一次，`/api/health` 未中断）
- [ ] ⛔ **应用容器没有内存上限**（`docker inspect` → `Memory=0`）。
      Node 内存失控时会把宿主机吃光，**OOM killer 多半会去杀内存占用最大的进程 —— PostgreSQL**。
      一次故障干掉两样东西。建议给 app 容器加 `mem_limit: 1500m`，
      让它自己先被杀（然后被 `restart: unless-stopped` 拉起），而不是拖垮数据库。
- [ ] 资源告警已就绪且真发过邮件，但阈值只覆盖内存/磁盘/swap，
      **没有「应用连续 N 次健康检查失败」这一项**。建议给 `alert.sh` 加一条。

---

## F3 整台机器没了 —— ⛔ 当前的真实缺口

### 现状有多糟

**备份和它要保护的数据在同一块盘上。** `/data/veggie/backups` 就在 droplet 的 `/dev/vda1` 上。
盘坏 = 数据和备份一起没。这不是「备份不够好」，是**这种情况下压根没有备份**。

同时，合同 IE-DEV-202607-01 要求「至少一份备份保存在不同于主服务器的位置」——
现状不满足该条款。

### 补救分三层，按重要性排序

#### 第一层：异地备份（⛔ 阻塞于 B3，需要你提供）

需要：**DigitalOcean Spaces 桶 + 4 个 `S3_*` 环境变量**
（`S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_ENDPOINT`）。

代码侧**已经就绪**：`lib/storage/backup-store.ts` 有 s3 driver，把 `/etc/veggie/app.env` 里的
`BACKUP_DRIVER=local` 改成 `s3` 并补上 4 个变量即可，无需改代码、无需重新构建镜像。

选 DO Spaces 而不是别的：与 droplet 同厂商、S3 兼容（将来换供应商只改 endpoint）、
且天然满足「异地」——桶不在这台机器上。

> 这是整个容灾方案里**唯一真正卡住的一件事**，其余都能自己做。

#### 第二层：可复现的重建（✅ 本次已做）

`deploy/droplet/bootstrap.sh` —— 把空 Ubuntu 变成基线的自动化脚本，
是 `docs/20260805-server-baseline.md` §2 全部手工步骤的固化。幂等，可重复执行。

`deploy/droplet/restore-from-backup.sh` —— 从备份产物恢复，含 `ANALYZE` 与行数校验。
支持 `--drill` 恢复到 `veggie_drill` 库做演练，不碰生产库。

**重建一台新机器的完整路径**（假设备份在异地）：

```
1. 开一台同规格 droplet（2vCPU/4G/80G，Ubuntu LTS）        ~2 分钟
2. sudo bash bootstrap.sh                                  ~10 分钟
3. 放 /etc/veggie/{app,alert,backup}.env + deploy 公钥      ~2 分钟
4. sudo bash restore-from-backup.sh <最新备份.sql.gz>       ~3 分钟（82MB gzip）
5. 改 DROPLET_HOST 变量 → 触发 GitHub Actions 部署          ~8 分钟
6. DNS 指向新 IP
                                                    合计 ≈ 25 分钟 + DNS 生效
```

镜像在 **GHCR** 上，与 droplet 相互独立 —— 机器没了镜像还在，这一点不需要额外做什么。

#### 第三层：机器级快照（需客户操作）

DigitalOcean 的 droplet 自动备份 / 快照能把 RTO 从「重建 25 分钟」压到「回滚快照几分钟」，
且能救「误删文件」这类第二层救不了的情况。

**我们没有 DO 控制台权限**，需要客户在控制台开启（Droplet → Backups，约 droplet 费用的 20%）。
建议提出来 —— 这是性价比最高的一层。

---

## 演练：没恢复过的备份不算备份

| 演练 | 频率 | 命令 | 判据 |
|---|---|---|---|
| 备份恢复 | 每季度 | `sudo bash restore-from-backup.sh --drill <最新备份>` | 行数与生产一致；`_prisma_migrations` 条数相同 |
| 坏部署回滚 | 下个维护窗口一次，之后每半年 | 故意部署一个健康检查必失败的镜像 | 自动回到上一个 sha，且回滚期间 `/api/health` 始终可用 |
| 整机重建 | 上线后一次 | 在临时 droplet 上跑 `bootstrap.sh` + `restore-from-backup.sh` | 25 分钟内起来且能登录 |

⛔ **前两项现在都还没做过。** 台账 T3.5 Step 3 一直挂着。

---

## 待办清单（按优先级）

| # | 事项 | 谁做 | 阻塞 |
|---|---|---|---|
| 1 | **DO Spaces 桶 + 4 个 `S3_*`** → 备份异地 | 用户 | ⛔ 这是唯一真正的缺口 |
| 2 | 给 app 容器加 `mem_limit`，别让它拖垮 PostgreSQL | 我 | 无 |
| 3 | 演练一次「故意坏部署 → 自动回滚」 | 我 | 需一个维护窗口 |
| 4 | 演练一次 `restore-from-backup.sh --drill` | 我 | 无（有本地备份就能做） |
| 5 | 让客户在 DO 控制台开启 droplet 自动备份 | 客户 | 需客户操作 |
| 6 | `alert.sh` 增加「健康检查连续失败」告警项 | 我 | 无 |

**在第 1 项完成之前，不要删除 Neon。** 那是目前唯一一份不在 droplet 这块盘上的数据副本。
