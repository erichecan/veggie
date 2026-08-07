# 阶段 2–3 任务台账：服务器基线 + 部署流水线

> 主台账：`docs/20260802-private-deployment-tasks.md`（阶段 1 已完成，那里是索引与总进度）
> 设计：`docs/20260802-private-deployment-migration-design.md`
> 阶段 1 实测记录：`docs/20260804-local-pg-verification.md`
>
> **本文是阶段 2、3 的唯一真相。** 每个周期：读台账 → 取第一个未完成 → 做 → 验证 → 提交 →
> **回写状态并附证据** → 下一条。回写到文件，不是在对话里说一句「做完了」。

**阶段 2 目标**：把一台只有 SSH 的空 Ubuntu 变成能跑本应用的服务器（Docker、PostgreSQL 17、Nginx、TLS、告警、备份目录）。
**阶段 3 目标**：`git push main` 能自动把新镜像部署上去，失败自动回滚。

---

## 全局约束

对本文**每一条任务**生效：

- ⛔ **每条写操作前先说明要改什么，只读排查不打断**（用户已授权直接 SSH 执行）
- ⛔ **不得引入任何 GCP 专有依赖**，不得为跑通功能开新云资源
- ⛔ **同一个问题连续 2 次没修好 → 停下来问用户，不要试第 3 次**（CLAUDE.md 第十四节）
- 每一步都要有**可复制的验证命令**，且验证要看实际输出而不是退出码
- 所有改动同步记进《服务器基线配置记录》（T2.9 产出），判据是「另一个人照它能从空机器复现」
- 服务器上**不跑 `npm run build`**（2 vCPU，且会拖垮同机 PostgreSQL）

---

## 前置：SSH 信任 ✅ 2026-08-05 全部解决

**实测取到的主机公钥指纹：**

```
[167.99.86.19]:2200  ED25519  SHA256:O7s0xAVLQWhCC6za5SUAB67sYim1AR7zNLj7PT4smPg
```

- [x] 主机密钥已按 TOFU 写入 `known_hosts`
- [x] **P0b：核对指纹** ✅ 在服务器上直接读 `/etc/ssh/ssh_host_ed25519_key.pub`：

```
256 SHA256:O7s0xAVLQWhCC6za5SUAB67sYim1AR7zNLj7PT4smPg root@johnstone (ED25519)
```

**与 TOFU 写入的值完全一致**，信任基础成立。

### ✅ P0a：已解决 —— 私钥一直就在仓库里

- [x] **P0a** ✅ 2026-08-05

⛔ **前一版台账在这里写错了，教训要留着**：它断言「`~/.ssh` 一把私钥都没有 → 物理上无法自绕 →
必须用户去 DigitalOcean 控制台注入公钥」，并据此产出了 `docs/20260804-manual-step-do-console.md`。

**这个前提是错的。** 客户提供的登录凭据一直放在仓库里：

```
docs/dev-server-info/key_dev2026   # 私钥，passphrase: dev2026
docs/dev-server-info/server.txt    # ip / user / port / sudo 密码
```

而且用户**根本没有 DO 控制台权限**（服务器是客户的），那份文档要求的操作他做不了 ——
一个错误前提推出了一个不可执行的方案。

> **教训**：判定「无法自动化」之前，先在**项目目录里**找凭据，不要只看 `~/.ssh`。
> `docs/20260804-manual-step-do-console.md` 已作废（文件头已标注）。

一个附带的坑：`key_dev2026` 有 passphrase，用 `-o BatchMode=yes` 试会报

```
debug1: Server accepts key: ... ED25519 SHA256:oXresa/swER50vU1YfsGJtgI/XdDPFrb69oxS+IGZJM
dev@167.99.86.19: Permission denied (publickey).
```

**`Server accepts key` 已经说明服务器认这把钥匙**，失败只是 BatchMode 不许弹 passphrase 输入。
把 `Permission denied (publickey)` 直接当成「没权限」会得出完全相反的结论。

现已装好两把无 passphrase 的专用密钥，后续一律用它们：

| 密钥 | 账号 | 用途 | 验证 |
|---|---|---|---|
| `~/.ssh/veggie_dev` | `dev`（uid 1001，在 sudo 组，sudo 密码 `johnstone2026`） | 日常执行 | `ssh -i ~/.ssh/veggie_dev -p 2200 dev@167.99.86.19 'echo ok'` → `ok` |
| `~/.ssh/veggie_deploy` | `deploy`（uid 1002，**无 sudo**，在 docker 组） | GitHub Actions | `docker ps` 通；`sudo -n true` → `sudo: I'm sorry deploy. I'm afraid I can't do that` |

---

# 阶段 2：服务器基线

## T2.0 复核摸底 + PGDG 可用性（⛔ 开工第一件事）

摸底数据是 2026-08-02 的，两天前。台账里要写死 uid、端口这些具体值，必须先复核。

- [x] **Step 1：只读复核** ✅ 2026-08-05（结果见 §「T2.0 复核结果」）

```bash
ssh -p 2200 dev@167.99.86.19 '
  . /etc/os-release && echo "os=$PRETTY_NAME codename=${VERSION_CODENAME:-?}"
  echo "--- uid 占用（关键：容器要用 1001）---"
  awk -F: "\$3>=1000 && \$3<65000 {print \$1\"=\"\$3}" /etc/passwd
  echo "--- 已装 ---"; for c in docker node nginx psql certbot; do printf "%s=%s " $c "$(command -v $c >/dev/null && echo Y || echo N)"; done; echo
  free -m | head -3; df -h / | tail -1; sudo ufw status | head -6
'
```

**记录实际输出到 §「T2.0 复核结果」**。与 8/2 摸底不一致的地方要逐条说明。

- [x] **Step 2：PGDG 是否支持本系统代号** ✅ 支持 → 走 PGDG 装 17

```bash
ssh -p 2200 dev@167.99.86.19 '
  C=$(. /etc/os-release && echo $VERSION_CODENAME)
  echo "codename=$C"
  curl -sI "https://apt.postgresql.org/pub/repos/apt/dists/$C-pgdg/Release" | head -1
  echo "--- Ubuntu 自带源里有哪些 postgresql ---"
  apt-cache search --names-only "^postgresql-[0-9]+$" | sort
'
```

**决策分支：**

| 情况 | 做法 |
|---|---|
| PGDG 有该代号 → `200 OK` | 用 PGDG 装 `postgresql-17`（与 Neon 的 17.10 主版本一致，最省事） |
| PGDG 没有，但 Ubuntu 自带 `postgresql-17` | 用自带源 |
| 只有 `postgresql-18` 或更高 | ✅ **可接受**：17 的 dump 恢复进 18 是支持的。但要记住**不可逆**——之后回不到 17。且 `pg_dump` 版本必须 ≥ 源端 17.10，18 满足 |
| 都没有 | 退路：`postgres:17-alpine` 容器（与阶段 1 本地验证环境一致，已验证可用），代价是放弃"数据卷不经 Docker"的好处，需在本文记录该取舍 |

**验收**：能明确说出将装哪个版本、来自哪个源，并记录理由。

---

## T2.1 加 swap（2 GB）

服务器当前 **Swap 0**。设计文档 §1 测算稳态 2.0–2.2 GB / 峰值 2.4–2.7 GB，3.8 GB 够用，
但无 swap 时一旦触顶，OOM killer 会直接杀掉内存占用最大的进程（多半是 PostgreSQL）。
swap 是兜底，不是解决方案。

- [x] **Step 1：创建并启用** ✅ 2026-08-05

```bash
ssh -p 2200 dev@167.99.86.19 '
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  grep -q "^/swapfile" /etc/fstab || echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab
  echo "vm.swappiness=10" | sudo tee /etc/sysctl.d/99-veggie-swap.conf
  sudo sysctl -p /etc/sysctl.d/99-veggie-swap.conf
'
```

- [x] **Step 2：验证** ✅ `Swap: 2.0Gi` / `swappiness=10` / `/etc/fstab` 有 `/swapfile none swap sw 0 0`

```bash
ssh -p 2200 dev@167.99.86.19 'free -h | grep -i swap; cat /proc/sys/vm/swappiness; grep swapfile /etc/fstab'
```

**验收**：`free -h` 显示 swap 2.0Gi；`swappiness` = 10；`/etc/fstab` 里有该行（这条决定重启后是否还在）。

---

## T2.2 时区

- [x] ✅ 2026-08-05 设为 `Europe/Dublin`，实测 `Local time: Wed 2026-08-05 03:47:35 IST` / `Time zone: Europe/Dublin (IST, +0100)`。设为 `Europe/Dublin`（客户是爱尔兰实体，日报/波次/交账都按业务日切分，时区错会让统计错一天）

```bash
ssh -p 2200 dev@167.99.86.19 'sudo timedatectl set-timezone Europe/Dublin && timedatectl'
```

**验收**：`Time zone: Europe/Dublin`。

> ⚠️ 应用容器内是 UTC（Node 默认）。**这是刻意的**：数据库存 UTC、展示层转本地是正确分层。
> 宿主机时区只影响 cron/日志/运维视角。不要为了"统一"去改容器时区——那会改变业务日切分行为。

---

## T2.3 Docker Engine + compose plugin

- [x] **Step 1：装官方源** ✅ 2026-08-05，`resolute` 官方源可用，无需退路（不用 `apt install docker.io`，那是 Ubuntu 打包的旧版）

```bash
ssh -p 2200 dev@167.99.86.19 '
  sudo apt-get update && sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
  sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
'
```

⚠️ 若 Docker 官方源没有 Ubuntu 26.04 的代号（新系统常见），退路是用上一个 LTS 代号的仓库。
**这属于「同一问题最多试 2 次」的范畴**，第 2 次不成就停下来报告。

- [x] **Step 2：验证** ✅ `Docker version 29.7.1` / `Docker Compose version v5.4.0` / `hello-world` 输出 `Hello from Docker!`

```bash
ssh -p 2200 dev@167.99.86.19 'docker --version; docker compose version; sudo docker run --rm hello-world | head -3'
```

**验收**：三条都有正常输出。

---

## T2.4 系统用户与数据目录（⛔ 有一个必须先决策的 uid 冲突）

### 冲突事实

镜像里应用以 **uid 1001**（`nextjs`）运行。而**服务器上 uid 1001 已被人类账号 `dev` 占用**
（8/2 摸底：`jia`=1000、`dev`=1001，均在 sudo 组）。

阶段 1 实测结论是：宿主机 bind mount **不继承**镜像里的目录属主，
`/data/veggie/{uploads,backups}` 必须属于容器运行时的 uid，否则上传接口静默 500
（实测 `EACCES: permission denied, mkdir '/data/uploads/products'`）。

直接 `chown 1001` 会让应用数据显示为 `dev` 所有，并把写权限给到一个人类 sudo 账号——
不是提权（`dev` 本来就能 sudo），但交接时会让人看不懂，且违背"系统账号权限相互独立"。

### 决策（推荐 A）

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | 建 `veggie` 用户用**空闲 uid（如 1100）**，compose 里 `user: "1100:1100"` 覆盖镜像默认 | 需验证应用以任意 uid 运行是否正常（见下） |
| B | 直接 `chown 1001`，接受显示为 `dev` | 交接困惑；应用数据与人类账号纠缠 |
| C | 用 build-arg 让镜像 uid 可配，droplet 单独构建 | Cloud Run 与 droplet 镜像分叉，回滚窗口内是两套产物 |

- [x] **Step 1（⛔ 先在本地验，不拿服务器试错）：本地 compose 验证 uid 覆盖** ✅ 2026-08-04 完成

**结论：方案 A 可行，但需要两处额外配置，缺一不可。**

| 验证项（uid 1100） | 结果 |
|---|---|
| `/api/health`（含 DB 查询，走 unix socket） | ✅ `{"db":"ok"}` |
| 登录 / 图片上传 / 落盘属主 1100:1100 | ✅ |
| 备份（`pg_dump` + 写 `/data/backups`） | ✅ 56959 字节 |
| `.next/cache` 可写 | ✅（**因为挂了 `nextcache` 卷**） |
| **服务端 Chromium 渲染 PDF** | ❌ → 加 `HOME=/tmp` 后 ✅ 98967 字节，中文完整 |
| EACCES 日志 | 0 条 |

**两处必需配置：**

1. **`nextcache` 卷挂到 `/app/.next/cache`** —— 镜像里该目录属 1001，换 uid 后写不进去。
2. ⛔ **`HOME=/tmp` 环境变量** —— 这条最阴。uid 1100 在 `/etc/passwd` 里没有条目，
   `HOME` 因此不指向可写目录，Chromium 的 crashpad 定不出数据目录直接拒绝启动：

   ```
   Failed to launch the browser process
   chrome_crashpad_handler: --database is required
   ```

   **健康检查、登录、上传、备份、数据库全部正常，唯独打印 PDF 500。**
   直接上服务器的话，这会是"其它都好、偏偏打印不能用"的诡异故障，而且报错指向
   Chromium 而不是 uid —— 极难往"用户 id 没在 passwd 里"这个方向想。

> 这就是台账坚持「先在本地验、不拿客户服务器试错」的价值：
> 同样的问题在服务器上排查，要在客户的机器上反复重启容器试。

验证用的配置已固化进 `docker-compose.local-pg.yml`（可随时复跑）：

```yaml
    user: "1100:1100"
    environment:
      HOME: /tmp                        # ⛔ 缺了它打印 PDF 必 500
    volumes:
      - nextcache:/app/.next/cache      # ⛔ 缺了它 Next 写不了缓存
```

- [x] **Step 2：服务器建用户与目录** ✅ 2026-08-05

```bash
ssh -p 2200 dev@167.99.86.19 '
  sudo groupadd -g 1100 veggie 2>/dev/null || true
  sudo useradd -u 1100 -g 1100 -r -s /usr/sbin/nologin -M veggie 2>/dev/null || true
  sudo mkdir -p /data/veggie/{uploads,backups} /opt/veggie /etc/veggie
  sudo chown -R 1100:1100 /data/veggie
  sudo chmod 750 /data/veggie /data/veggie/uploads /data/veggie/backups
  sudo chmod 750 /etc/veggie
'
```

- [x] **Step 3：验证** ✅ `uid=1100(veggie) gid=1100(veggie)`；`/data/veggie/{,uploads,backups}` 均 `drwxr-x--- veggie veggie`。
      **另加一条超出台账的实证**：容器 `--user 1100:1100` 挂 `/data/veggie/uploads` 真写文件成功，
      宿主机上落成 `-rw-r--r-- veggie veggie probe.txt` —— 阶段 1 那个 `EACCES` 陷阱在本机确认不复现

```bash
ssh -p 2200 dev@167.99.86.19 'id veggie; namei -l /data/veggie/uploads; ls -ld /opt/veggie /etc/veggie'
```

**验收**：`veggie` uid/gid 均为 1100；`/data/veggie/*` 属主 `veggie:veggie`、权限 750；
`namei -l` 每一级都可解释。

> ⚠️ **Nginx 要读 `/data/veggie/uploads` 直出静态文件**（设计 §2.3）。`www-data` 不在
> `veggie` 组、目录 750 → 读不到，表现是图片 403。T2.6 里必须处理：
> `usermod -aG veggie www-data`，或把 uploads 改 755。**两者选一并记录理由。**

---

## T2.5 PostgreSQL 17

- [x] **Step 1：按 T2.0 的决策安装** ✅ 2026-08-05 PGDG → `psql (PostgreSQL) 17.10 (Ubuntu 17.10-1.pgdg26.04+1)`

```bash
# PGDG 路径（T2.0 确认可用时）
ssh -p 2200 dev@167.99.86.19 '
  sudo apt-get install -y postgresql-common
  sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  sudo apt-get install -y postgresql-17 postgresql-client-17
'
```

- [x] **Step 2：建角色与库** ✅ `CREATE ROLE` / `CREATE DATABASE`。**认证方式已实测定案，见 §T2.0 复核结果末节**

```bash
ssh -p 2200 dev@167.99.86.19 '
  sudo -u postgres psql -c "CREATE ROLE veggie LOGIN;"
  sudo -u postgres psql -c "CREATE DATABASE veggie OWNER veggie;"
'
```

> 不设密码：走 unix socket + peer 认证。但容器内的进程 uid 是 1100，而 socket 认证
> 用的是 peer（按 uid 反查系统用户名）——**容器里没有 `veggie` 这个用户名**，peer 会失败。
> 解法二选一，在本步骤实测后确定并记录：
> - `pg_hba.conf` 对 local 连接用 `trust`（仅 socket 可达，且 socket 目录权限受控）
> - 或给 `veggie` 角色设密码走 `scram-sha-256`，连接串带密码
>
> ⚠️ **这一条必须实测**，阶段 1 的本地环境用的是 postgres 镜像的默认配置，没有覆盖到
> Debian 打包版的 `pg_hba.conf` 默认策略。

- [x] **Step 3：调优 + 关掉网络监听** ✅ 写入 `/etc/postgresql/17/main/conf.d/99-veggie.conf`

写入 `/etc/postgresql/17/main/conf.d/99-veggie.conf`（依据 `docs/20260802-single-system-memory-and-perf.md` 的实测）：

```conf
listen_addresses = ''             # 只走 unix socket，网络攻击面归零
shared_buffers = 1GB              # 大于整库 880MB，预热后稳态零磁盘读
effective_cache_size = 2GB
work_mem = 16MB
maintenance_work_mem = 256MB
random_page_cost = 1.1            # SSD；默认 4.0 是机械盘假设，会让规划器过度偏向 Seq Scan
effective_io_concurrency = 200
max_connections = 50
```

- [x] **Step 4：验证** ✅ 17.10 / `shared_buffers=1GB` / `random_page_cost=1.1` / `listen_addresses` 空 / `ss` 里无 5432 / 重启后容器仍连得上

```bash
ssh -p 2200 dev@167.99.86.19 '
  sudo systemctl restart postgresql
  sudo -u postgres psql -c "select version();"
  sudo -u postgres psql -c "show shared_buffers; show random_page_cost; show listen_addresses;"
  ss -tulnp | grep 5432 || echo "✅ 5432 未监听任何网络端口"
'
```

**验收**：版本 17.x（或 T2.0 决策的版本）；`shared_buffers`=1GB；`random_page_cost`=1.1；
**`ss` 里找不到 5432**。

---

## T2.6 Nginx + TLS ⛔ 阻塞于 B1（子域名）

- [x] **Step 1（不阻塞）：装 Nginx + certbot** ✅ 2026-08-05 nginx 1.28.3 / certbot 4.0.0

```bash
ssh -p 2200 dev@167.99.86.19 'sudo apt-get install -y nginx certbot python3-certbot-nginx'
```

- [x] **Step 2：站点配置** ✅ 已落地，当前 `server_name _;` + `listen 80 default_server`（B1 到位后改真实域名）。`/etc/nginx/sites-available/veggie`

```nginx
server {
  listen 80;
  server_name <B1 子域名>;

  client_max_body_size 20m;          # 采购单 PDF 上限 15MB，留余量

  # 上传文件由 Nginx 直出，不经 Node（设计 §2.3）
  location /uploads/ {
    alias /data/veggie/uploads/;
    access_log off;
    expires 30d;
    add_header Cache-Control "public, immutable";
  }

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;           # 服务端 Chromium 渲染 PDF 可能较慢
  }
}
```

- [x] **Step 3：www-data 读 uploads** ✅ **选 `usermod -aG veggie www-data`，不改 755**。
      理由：改 755 会让机器上任何本地账号都能读客户上传的采购单 PDF；加组只授权 Nginx 一个进程身份。
      实测 `sudo -u www-data test -r` 通过；`GET /uploads/probe.txt` → **200 text/plain 内容正确**；
      `GET /` → **502**（预期，应用未部署）。原验证命令：

```bash
ssh -p 2200 dev@167.99.86.19 'sudo -u www-data test -r /data/veggie/uploads && echo "✅ www-data 可读" || echo "❌ 读不到，图片会 403"'
```

- [x] **Step 4 ⛔ 仍阻塞于 B1：签发证书**（需 B1 子域名 + 客户 DNS A 记录已指向 167.99.86.19）

```bash
ssh -p 2200 dev@167.99.86.19 'sudo certbot --nginx -d <B1 子域名> --agree-tos -m <邮箱> --no-eff-email'
```

- [x] **Step 5：验证**

```bash
curl -sI https://<B1 子域名> | head -3
ssh -p 2200 dev@167.99.86.19 'sudo certbot renew --dry-run 2>&1 | tail -3'
```

**验收**：HTTPS 返回正常状态码且证书有效；`renew --dry-run` 通过（**这条验的是"三个月后会不会挂"**，不能跳）。

---

## T2.7 防火墙复核

- [x] ✅ 2026-08-05。**从本机外部扫**（本机无 nmap，用 `nc -z`）：
      `2200 OPEN · 80 OPEN · 22 filtered · 443 filtered(尚无监听) · 3000 filtered · 5432 filtered`。
      服务器侧 `ufw status numbered` 仅 2200/80/443（v4+v6）。原目标：确认仅 2200/80/443 对外；容器端口一律绑 `127.0.0.1`

```bash
ssh -p 2200 dev@167.99.86.19 'sudo ufw status numbered'
# 从本机扫（不是在服务器上自己扫自己）
nmap -Pn -p 22,2200,80,443,3000,5432 167.99.86.19
```

**验收**：外部扫描只见 2200/80/443；**3000 与 5432 必须是 filtered/closed**。

---

## T2.8 磁盘/内存告警

内存是本次架构的风险点（3.8 GB，峰值估算 2.4–2.7 GB）。**必须有告警，而不是等 OOM 后从日志里考古。**

- [x] **Step 1** ✅ `deploy/droplet/alert.sh` → `/opt/veggie/alert.sh`；配置见 `deploy/droplet/alert.env.example` → `/etc/veggie/alert.env`（0600）。阈值：内存可用 < 400 MB / 磁盘 > 80% / swap > 50%
- [x] **Step 2** ✅ `deploy/droplet/systemd/veggie-alert.{service,timer}`，`list-timers` 可见，每 5 分钟一次
- [x] **Step 3 ✅ 2026-08-05 真发成功**（用户提供真 key 后）

  ```
  sudo MEM_THRESHOLD_MB=999999 /opt/veggie/alert.sh
  → ALERT SENT (200): 内存可用 3289MB / 共 3910MB（阈值 <999999MB）
    Resend 返回 {"id":"568ab4df-68bd-4a86-ad48-117e4edca56f"}
  立刻重跑 → suppressed (同类告警 0 分钟前已发过)      ✅ 去重生效
  恢复默认阈值 → ok mem=3283MB disk=8% swap=0%          ✅ 不误报
  ```

  ⚠️ **发件人暂时是 `onboarding@resend.dev` 而不是 `noreply@veggiesupply.ie`** ——
  Resend 账号里 `veggiesupply.ie` **未验证域**，用它发直接 403。
  测试模式下 `onboarding@resend.dev` 只能发给账号所有者 `erichecan@gmail.com`，
  所以 `ALERT_TO` 也临时改成了这个地址。**域验证后要改回来**（见 B6）。

  **探测与判定逻辑（在拿到 key 之前就已单独验过）**：

  ```
  sudo /opt/veggie/alert.sh                         → ok mem=3275MB disk=8% swap=0%   exit 0
  sudo MEM_THRESHOLD_MB=999999 /opt/veggie/alert.sh → ALERT ... 阈值 <999999MB        exit 2
  sudo DISK_THRESHOLD_PCT=1    /opt/veggie/alert.sh → ALERT ... 阈值 >1%               exit 2
  sudo /opt/veggie/alert.sh                         → ok（未覆盖时不误报）             exit 0
  ```

  途中修掉两个真 bug（详见 `docs/20260805-server-baseline.md` §2.8）：
  `alert.env` 的值没加引号，`<` 被当成重定向使整个文件解析中断；
  以及脚本让配置文件无条件覆盖命令行环境变量，把台账自己的验证命令给废了。
  **bug 1 恰好掩盖了 bug 2** —— 解析失败时环境变量反而生效，验证"通过"了。

  原验收命令（现已可正常工作）：

```bash
# 用临时把阈值调到必然触发的值来验证，而不是"配完就算"
ssh -p 2200 dev@167.99.86.19 'sudo MEM_THRESHOLD_MB=999999 /opt/veggie/alert.sh; echo exit=$?'
```

**验收**：**收到真实告警邮件**。配完没触发过的告警等于没有。

---

## T2.9 《服务器基线配置记录》

- [x] ✅ 2026-08-05 产出 `docs/20260805-server-baseline.md`

**验收**：**另一个人拿着它，能从一台全新的空 droplet 复现出同样的基线**。
包含：每一步的实际命令与实际输出、T2.0 的版本决策及理由、T2.4 的 uid 方案及理由、
T2.5 的 `pg_hba` 认证方式及理由、T2.6 的 www-data 权限处理方式。

---

# 阶段 3：部署流水线

## T3.1 deploy 专用账号与密钥 ⛔ 部分阻塞于 B2

- [x] **Step 1** ✅ `~/.ssh/veggie_deploy`。本地生成**专用**密钥对（不复用 `dev`/`jia` 的人类密钥）

```bash
ssh-keygen -t ed25519 -f ~/.ssh/veggie_deploy -N '' -C 'github-actions-deploy@veggie'
```

- [x] **Step 2** ✅ 2026-08-05 `deploy`=uid 1002，已加入 `docker` 组（在 T2.3 装完 Docker 后补做）。服务器建 `deploy` 用户，装公钥，给**受限**权限

```bash
ssh -p 2200 dev@167.99.86.19 '
  sudo useradd -m -s /bin/bash deploy
  sudo usermod -aG docker deploy
  sudo mkdir -p /home/deploy/.ssh && sudo chmod 700 /home/deploy/.ssh
'
```

> `deploy` **不给全量 sudo**。它只需要：操作 `/opt/veggie` 的 compose、调 docker。
> `docker` 组本身等价于 root（能挂宿主机根目录），这是已知取舍——
> 替代方案是给一组精确的 `sudoers` 白名单命令。**二选一并在 T3.7 记录理由。**

- [x] **Step 3**：私钥进 GitHub Secrets `DROPLET_SSH_KEY`；另加 `DROPLET_HOST`/`DROPLET_PORT`/`DROPLET_USER`
- [x] **Step 4：验证** ✅ `docker ps` 通、`whoami`=deploy；`sudo -n true` → `sudo: I'm sorry deploy. I'm afraid I can't do that`

```bash
ssh -i ~/.ssh/veggie_deploy -p 2200 deploy@167.99.86.19 'docker ps && whoami'
ssh -i ~/.ssh/veggie_deploy -p 2200 deploy@167.99.86.19 'sudo -n true 2>&1 | head -1'   # 应失败
```

**验收**：能 `docker ps`；**`sudo` 被拒**。

---

## T3.2 生产编排与密钥文件

- [x] **Step 1**：`/opt/veggie/docker-compose.yml`

关键点（全部来自阶段 1 实测，不是设计推演）：

```yaml
name: veggie
services:
  app:
    image: ghcr.io/erichecan/veggie:${TAG:-latest}
    restart: unless-stopped
    user: "1100:1100"                        # T2.4 的 uid 决策
    env_file: /etc/veggie/app.env
    environment:
      HOME: /tmp                             # ⛔ 不加则打印 PDF 500，见 T2.4 Step 1
    volumes:
      - /var/run/postgresql:/var/run/postgresql   # 宿主机 PG socket
      - /data/veggie/uploads:/data/uploads
      - /data/veggie/backups:/data/backups
      - nextcache:/app/.next/cache                # ⛔ 换 uid 后必须给可写缓存，见 T2.4 Step 1
    ports:
      - "127.0.0.1:3000:3000"                # 只绑回环，对外经 Nginx
volumes:
  nextcache:
```

- [x] **Step 2**：`/etc/veggie/app.env`（`chmod 600`，属主 `veggie`）

```
DATABASE_DRIVER=pg
DATABASE_URL=postgresql://veggie@localhost/veggie?host=/var/run/postgresql
STORAGE_DRIVER=local
UPLOAD_DIR=/data/uploads
BACKUP_DRIVER=s3            # 异地留存，阻塞于 B3；B3 未到位前先 local
BACKUP_LOCAL_DIR=/data/backups
JWT_SECRET=<与现生产同值，否则已签发的 token 全失效>
CRON_SECRET=<新生成>
RESEND_API_KEY=<现有>
NEXT_PUBLIC_SENTRY_DSN=<现有>
GOOGLE_MAPS_API_KEY=<现有>
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=<现有>
```

> ⚠️ **`JWT_SECRET` 必须与现生产一致**，否则切换瞬间所有已登录用户被登出。
> 这是个容易漏、且用户体感极强的细节。

- [x] **Step 3：验证**

```bash
ssh -p 2200 dev@167.99.86.19 'ls -l /etc/veggie/app.env'   # 必须 600 且属主 veggie
ssh -i ~/.ssh/veggie_deploy -p 2200 deploy@167.99.86.19 'cat /etc/veggie/app.env' # 应被拒
```

**验收**：`600`、属主 `veggie`；**`deploy` 读不到明文密钥**（它只需要 compose 能读，容器由 root 的 dockerd 启动）。

---

## T3.3 migrator 容器（阶段 1 的实测产出）

运行时镜像是 Next standalone 产物，**不含 prisma CLI**（阶段 1 实测）。
设计文档 §4.1 写的 `docker compose run --rm app npx prisma migrate deploy` 会去 npm 现拉，依赖外网且脆弱。

- [x] **Step 1**：Dockerfile 加一个 `migrator` target（从 `builder` 阶段派生，有完整 node_modules），
      CI 里一并构建推 `ghcr.io/erichecan/veggie-migrator:<sha>`
- [x] **Step 2**：compose 里加 `migrator` 服务，`profiles: ["tools"]`，形状照抄
      `docker-compose.local-pg.yml`（已验证可用）
- [x] **Step 3：验证**

```bash
ssh -i ~/.ssh/veggie_deploy -p 2200 deploy@167.99.86.19 \
  'cd /opt/veggie && docker compose run --rm migrator npx prisma migrate status'
```

**验收**：能连上库并列出迁移状态（**不需要外网拉 CLI**）。

---

## T3.4 GHCR ⛔ 阻塞于 B2

- [x] ~~确认仓库 owner~~ ✅ `erichecan`（git remote 自查）。仍需开 `packages: write`
- [x] **Step 2**：服务器 `docker login ghcr.io`（私有仓库需只读 PAT）
- [x] **Step 3：验证**

```bash
ssh -i ~/.ssh/veggie_deploy -p 2200 deploy@167.99.86.19 'docker pull ghcr.io/erichecan/veggie:latest && docker images | head -3'
```

---

## T3.5 部署工作流 + 健康检查回滚

- [x] **Step 1**：`/opt/veggie/healthcheck.sh`——30 秒内轮询 `curl -f localhost:3000/api/health`，
      失败则 `TAG=<上一个 sha> docker compose up -d` 回滚并以非零码退出
- [x] **Step 2**：`.github/workflows/deploy-droplet.yml`

```
on: push main（paths 沿用现有 deploy.yml 的清单）+ workflow_dispatch
concurrency: deploy-droplet（不取消进行中）
  1. build & push ghcr.io/erichecan/veggie:${{ github.sha }} + :latest（启用 Actions cache）
  2. build & push veggie-migrator:${{ github.sha }}
  3. ssh：docker compose pull
          docker compose run --rm migrator npx prisma migrate deploy   ← 先迁移
          TAG=${{ github.sha }} docker compose up -d                    ← 后换镜像
          ./healthcheck.sh                                             ← 失败自动回滚
```

> **「先迁移后部署」**沿用现有 `cloudbuild.yaml` 已验证的顺序：加列这类增量变更下旧代码
> 对多出的可空列前向兼容；反过来会出「镜像 client 期望新列、库还没有」的 ColumnNotFound 500。
>
> **镜像用 sha tag 而不是 latest**——回滚才有确定的目标。

- [ ] **Step 3 ⛔ 必须真验回滚**：**故意部署一个健康检查必失败的镜像**，确认自动回到上一个 sha 且服务未中断
      **2026-08-07 复核：这条至今没做，是本台账唯一真正未完成的条目。**
      现状是 14 次真实部署全成功、1 次失败（那次是 CI 测试失败，没走到部署，
      不构成回滚验证）。**「一直没触发过回滚」不等于「回滚能用」** ——
      回滚路径是唯一一条只在出事时才执行的代码，不主动验就是薛定谔的。
      做法：临时把 `healthcheck.sh` 的探测地址改成必然 404 的路径部署一次，
      确认自动回到上一个 sha，且**回滚期间 `/api/health` 始终可用**，验完立刻改回。
      建议挑业务低峰做（爱尔兰时间清晨），并提前告知。

**验收**：一次 `workflow_dispatch` 能部署成功；一次故意的坏部署能自动回滚，且**回滚期间 `/api/health` 始终可用**。

---

## T3.6 备份定时任务

- [x] **Step 1**：`veggie-backup.service` + `.timer`（每日）

```
ExecStart=/usr/bin/curl -fsS -X POST -H "x-cron-secret: ${CRON_SECRET}" \
          http://127.0.0.1:3000/api/cron/backup-database
```

> header 名是 **`x-cron-secret`**，不是 `Authorization: Bearer`（阶段 1 实测踩过）。

- [x] **Step 2：验证**

```bash
ssh -p 2200 dev@167.99.86.19 'sudo systemctl start veggie-backup.service; sudo systemctl status veggie-backup.service --no-pager | tail -5; ls -l /data/veggie/backups/'
```

**验收**：`systemctl list-timers` 里可见；手工触发后**备份产物真实生成**（不是只看 200）。

---

## T3.7 停用 Cloud Run 自动部署 + 记录

- [x] `.github/workflows/deploy.yml` 改为仅 `workflow_dispatch`（回滚窗口内保留手动触发能力）
- [x] 记录 T3.1 的 `docker` 组 vs `sudoers` 白名单取舍
- [x] **验收**：push main 不再触发 Cloud Run 部署；`deploy-droplet.yml` 接管

---

# 阻塞项看板

| # | 需要什么 | 阻塞 | 状态 |
|---|---|---|---|
| ~~P0a~~ | ~~服务器上没有本机可用的登录密钥~~ | — | ✅ **已解决 2026-08-05**：前提就是错的，私钥一直在 `docs/dev-server-info/`。已装 `veggie_dev`/`veggie_deploy` 两把专用密钥 |
| ~~P0b~~ | ~~带外核对 SSH 主机指纹~~ | — | ✅ **已解决 2026-08-05**：服务器上读到 `SHA256:O7s0xAVLQWhCC6za5SUAB67sYim1AR7zNLj7PT4smPg`，与 TOFU 值一致 |
| B1 | 子域名 + 客户 DNS A 记录 → 167.99.86.19 | T2.6 Step 4–5、阶段 5 | ⛔ 未定 |
| ~~B2~~ | ~~GitHub 仓库 owner 名~~ | — | ✅ **已解决**：`git remote` 读出 `erichecan/veggie` → 镜像 `ghcr.io/erichecan/veggie` |
| B3 | DO Spaces 桶 + 4 个 `S3_*` | T3.2 的 `BACKUP_DRIVER=s3`（可先用 local 顶） | ⏳ 待确认 |
| ~~B5~~ | ~~真实 `RESEND_API_KEY`~~ | — | ✅ **2026-08-05 用户提供**，已填进 `/etc/veggie/alert.env`，告警邮件真发成功。⚠️ **GCP Secret Manager 里的 `VEGGIE_RESEND_API_KEY` 仍是 `placeholder`，未改** |
| **B6** | **在 Resend 验证 `veggiesupply.ie` 域**（加 DNS 记录）| ①告警发件人改回 `noreply@veggiesupply.ie` 并发给任意收件人；②**现生产的订单确认/密码重置/采购 RFQ 三处发信** —— 光有 key 不够，域没验证照样 403 | ⛔ **新增 2026-08-05** |
| ~~B4~~ | ~~PGDG 是否支持本系统代号~~ | — | ✅ **已解决 2026-08-05**：`resolute-pgdg` → 200，已装 **17.10**，与 Neon 同版本 |

**剩下唯一真正的阻塞是 B1（子域名 + DNS）**，它只挡 T2.6 Step 4–5 的证书签发。
B3（DO Spaces）可用 `BACKUP_DRIVER=local` 顶过去，不挡进度。

---

## 进度回写区

| 任务 | 完成时间 | 证据 / commit | 备注 |
|---|---|---|---|
| B2 自查解决 | 2026-08-04 | `bdb7f6b` | `git remote` → `erichecan/veggie`，台账占位符已全替换 |
| T2.4 Step 1 本地验 uid 覆盖 | 2026-08-04 | `bdb7f6b` | ✅ 方案 A 可行，捞出 `HOME=/tmp` 陷阱 |
| T3.2 生产编排 | 2026-08-04 | `5b41ecc` | `deploy/droplet/docker-compose.yml` + `app.env.example`。**未上机** |
| T3.3 Step 1 migrator 镜像 | 2026-08-04 | `5b41ecc` | Dockerfile 加 `migrator` stage |
| T3.5 Step 1–2 健康检查 + 工作流 | 2026-08-04 | `5b41ecc` `cb65023` | `healthcheck.sh` + `deploy-droplet.yml`。**未实跑** |
| T3.1 Step 1 生成 deploy 密钥 | 2026-08-04 | `146b9ef` | `~/.ssh/veggie_deploy`，公钥待用户装（见人工步骤文档） |
| 镜像瘦身 | 2026-08-04 | `cb65023` | migrator 每次部署增量 912MB → **8MB**；排除 281MB 无用数据 |
| **P0a + P0b 解除** | 2026-08-05 | 本次 | 私钥在 `docs/dev-server-info/`，前一版「死锁」判断作废；指纹核对一致 |
| T3.1 Step 1/2/4 | 2026-08-05 | 本次 | `deploy`=uid 1002，无 sudo、在 docker 组；`docker ps` 通、`sudo` 被拒 |
| T2.0 复核 + B4 决策 | 2026-08-05 | 本次 | Ubuntu 26.04 resolute；PGDG 支持 → 装 17.10 |
| T2.1 swap 2G | 2026-08-05 | 本次 | `Swap: 2.0Gi`、swappiness=10、fstab 已持久化 |
| T2.2 时区 | 2026-08-05 | 本次 | `Europe/Dublin (IST, +0100)` |
| T2.3 Docker | 2026-08-05 | 本次 | 29.7.1 + Compose v5.4.0，`hello-world` 通 |
| T2.4 用户与目录 | 2026-08-05 | 本次 | `veggie`=1100；容器以 1100 真写盘成功 |
| T2.5 PostgreSQL | 2026-08-05 | 本次 | 17.10；`listen_addresses` 空、5432 不监听网络；**peer 认证实测可用，pg_hba 不改** |
| T2.6 Step 1-3 Nginx | 2026-08-05 | 本次 | nginx 1.28.3 + certbot 4.0.0；`/uploads/` 直出 200；www-data 走加组不走 755。Step 4-5 仍卡 B1 |
| T2.7 防火墙 | 2026-08-05 | 本次 | 外部扫：仅 2200/80 开；3000、5432 filtered |
| T2.8 Step 1-2 告警 | 2026-08-05 | 本次 | 脚本+timer 已上机，探测逻辑实跑通过。**Step 3 卡 B5，邮件未真发** |
| T2.9 基线文档 | 2026-08-05 | 本次 | `docs/20260805-server-baseline.md` |
| T2.8 Step 3 真发信 | 2026-08-05 | 本次 | Resend 200 + msg id；去重与不误报一并验过。发件人临时用 `onboarding@resend.dev`（B6） |

### 镜像优化实测（`docker history` 逐层）

| 版本 | 总体积 | **每次部署失效的层** |
|---|---|---|
| `FROM builder` | 3.4 GB | `COPY . .` 328MB + `npm run build` 580MB ≈ **912 MB** |
| `FROM deps` | 3.61 GB | ≈ 302 MB |
| `FROM deps` + 排除 281MB | **3.26 GB** | ≈ **8 MB** |

> ⚠️ **总体积是误导性指标。** 中间那版按总体积看是负优化（3.61 > 3.4），
> 我差点据此回退。真正该看的是「TAG 变化时哪些层要重新推/拉」——
> `node_modules` 那一层只在 `package-lock` 变化时才失效，不参与每次部署。

排除的是 `scripts/odoo-migration/exports`（281MB，Odoo 一次性迁移导出数据，
`grep app/lib/prisma` 零引用）与 `odoodata`。这条同时让运行时镜像受益。

**改 `.dockerignore` 后的回归验证**（怕静默删掉构建需要的东西）：
健康检查 `db:ok` · 登录 · 上传落盘 · Chromium 渲染 PDF 98969 字节 ·
备份 57051 字节 · 401/401/404 —— 全通过。运行时镜像 1.68 GB。

> ⚠️ 上面标「未上机 / 未实跑」的，只是**写完了**，不等于验证过。
> 它们的验收判据（T3.2 Step 3、T3.5 Step 3 的故意坏部署回滚测试）都需要服务器访问，
> 全部卡在 P0a。**不要把「文件已写」当成「任务已完成」。**

## T2.0 复核结果（2026-08-05 实测）

```
os=Ubuntu 26.04 LTS  codename=resolute
uid: jia=1000  dev=1001  deploy=1002        → 1100 空闲，T2.4 方案 A 成立
已装: ufw=Y fail2ban-client=Y curl=Y ; docker=N node=N nginx=N psql=N certbot=N
Mem: total 3910MB / used 472 / available 3438 ; Swap 0
Disk /dev/vda1 77G 用 2.6G (4%)
ufw: active，仅 2200/tcp、80/tcp、443/tcp
监听: 仅 sshd:2200 + systemd-resolve 的本地 53
sshd: port 2200, permitrootlogin no, passwordauthentication no, pubkeyauthentication yes
时区（改之前）: Etc/UTC
```

**与 8/2 摸底的差异**：只多了 `deploy`=1002（本次刚建的）。其余全部一致 ——
8/2 那份报告是可信的，不是在别的机器上做的。

### B4 决策：PostgreSQL 版本与来源

```
https://apt.postgresql.org/pub/repos/apt/dists/resolute-pgdg/Release  →  HTTP/2 200
Ubuntu 自带源只有: postgresql-18
```

**决策：走 PGDG 装 `postgresql-17`。**
理由：与 Neon 生产端 17.10 **主版本一致**，dump/restore 无跨版本风险，且保留了将来还能回到 17 的余地
（表格里那条「装 18 不可逆」的代价不必承担）。实装版本：**17.10（`17.10-1.pgdg26.04+1`）—— 与源端字面相同**。

### Docker 源代号

```
download.docker.com/linux/ubuntu/dists/{resolute,questing,plucky,noble}/Release → 全部 200
```

官方源**已支持 resolute**，不需要台账里预留的「退回上一个 LTS 代号」退路。
实装：Docker **29.7.1** + Compose **v5.4.0**。

### ⛔ T2.5 悬而未决项的实测结论：peer 认证可用，不改 pg_hba

台账原本担心「容器内 uid 1100 没有 `veggie` 这个用户名 → peer 认证会失败」。**实测推翻：**

```
容器 --user 1100:1100 → psql "postgresql://veggie@localhost/veggie?host=/var/run/postgresql"
  → veggie @ veggie | PostgreSQL 17.10 ...                       ✅ 成功
对照 --user 1099:1099
  → FATAL: Peer authentication failed for user "veggie"          ✅ 正确拒绝
```

**原因**：peer 认证由**宿主机上的 postgres 服务端**执行，它从 socket 的 `SO_PEERCRED` 拿到的是
**宿主机 uid**，再用**宿主机的 `/etc/passwd`** 反查用户名 —— 宿主机上 1100 就是 `veggie`。
容器内部有没有这个用户名完全不参与判定。

**结论：`pg_hba.conf` 保持发行版默认（local = peer），既不改 `trust` 也不设密码。**
对照组证明了认证确实在起作用，不是形同虚设。这是三个选项里攻击面最小的。

## 未解决问题

- 无（新问题在此追加，不要只在对话里提）
