# 服务器基线配置记录（T2.9）

> **判据**：另一个人拿着这份文档，能从一台全新的空 droplet 复现出同样的基线。
>
> 实施时间：2026-08-05 · 目标机：`167.99.86.19:2200`（客户提供的 DigitalOcean droplet，主机名 `johnstone`）
> 台账：`docs/20260804-server-enablement-tasks.md` · 设计：`docs/20260802-private-deployment-migration-design.md`
>
> 本文只记 **T2.0–T2.8** 的成果。应用编排（T3.2）与部署流水线（T3.5）另见 `deploy/droplet/README.md`。

---

## 0. 最终状态快照（2026-08-05 实测输出）

```
系统      Ubuntu 26.04 LTS (resolute)，kernel 7.0.0-28-generic
时区      Europe/Dublin (IST, +0100)
内存      3.8Gi 总，可用 3.2Gi；Swap 2.0Gi，swappiness=10
磁盘      /dev/vda1  77G，已用 5.6G (8%)
Docker    29.7.1 + Compose v5.4.0
Postgres  17.10 (Ubuntu 17.10-1.pgdg26.04+1)，集群 17/main online
Nginx     1.28.3 ；certbot 4.0.0
```

| 账号 | uid | shell | 组 | 用途 |
|---|---|---|---|---|
| `jia` | 1000 | bash | sudo | 客户原有 |
| `dev` | 1001 | bash | sudo | 日常运维（本项目执行用） |
| `deploy` | 1002 | bash | **docker（无 sudo）** | GitHub Actions 部署 |
| `veggie` | 1100 | nologin | — | 应用容器的运行身份、数据目录属主 |
| `www-data` | 33 | — | **+veggie** | Nginx，需读 uploads 直出静态文件 |

| 目录 | 属主 | 权限 | 用途 |
|---|---|---|---|
| `/data/veggie/uploads` | veggie:veggie | 750 | 上传文件 |
| `/data/veggie/backups` | veggie:veggie | 750 | 数据库备份 |
| `/opt/veggie` | root:root | 755 | compose、运维脚本 |
| `/etc/veggie` | root:root | 750 | 密钥文件（`app.env`、`alert.env`） |
| `/var/lib/veggie` | root:root | 755 | 告警去重状态 |

---

## 1. 登录与信任基础

```
主机指纹  [167.99.86.19]:2200  ED25519  SHA256:O7s0xAVLQWhCC6za5SUAB67sYim1AR7zNLj7PT4smPg
```

客户提供的原始凭据在 `docs/dev-server-info/`（`key_dev2026`，passphrase `dev2026`；`server.txt` 含 sudo 密码）。
在此基础上装了两把**无 passphrase** 的专用密钥，后续一律用它们：

```bash
ssh -i ~/.ssh/veggie_dev    -p 2200 dev@167.99.86.19      # 运维，可 sudo
ssh -i ~/.ssh/veggie_deploy -p 2200 deploy@167.99.86.19   # CI，无 sudo，可 docker
```

> ⚠️ 用 `-o BatchMode=yes` 试 `key_dev2026` 会报 `Permission denied (publickey)`，
> 但同一段 `-vv` 输出里写着 `Server accepts key` —— 那是 passphrase 没解锁，不是没权限。
> 这个误读曾让上一轮得出「必须去 DigitalOcean 控制台」的错误结论。

`sshd` 既有配置未改动，复核结果：`port 2200` · `permitrootlogin no` ·
`passwordauthentication no` · `pubkeyauthentication yes`；`fail2ban` 原本就在跑。

---

## 2. 从空 droplet 复现的完整步骤

### 2.1 swap（T2.1）

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab
echo "vm.swappiness=10" | sudo tee /etc/sysctl.d/99-veggie-swap.conf
sudo sysctl -p /etc/sysctl.d/99-veggie-swap.conf
```

**为什么**：机器 3.8 GB，设计测算峰值 2.4–2.7 GB。无 swap 时一旦触顶，OOM killer 会直接杀掉
内存占用最大的进程（多半是 PostgreSQL）。swap 是兜底不是解决方案，所以 `swappiness=10` —— 尽量别用它。
**`/etc/fstab` 那行才是重启后仍在的原因**，只 `swapon` 不写 fstab 等于没做。

### 2.2 时区（T2.2）

```bash
sudo timedatectl set-timezone Europe/Dublin
```

客户是爱尔兰实体，日报 / 波次 / 交账都按业务日切分，宿主机时区错会让运维视角的日志错一天。
**应用容器内保持 UTC（Node 默认），这是刻意的** —— 数据库存 UTC、展示层转本地是正确分层，
不要为了"统一"去改容器时区，那会改变业务日切分行为。

### 2.3 Docker（T2.3）

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu resolute stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

**版本来源决策**：用 Docker 官方源，不用 `apt install docker.io`（Ubuntu 打包版落后）。
实测 `download.docker.com` 已支持 `resolute`（`dists/resolute/Release` → 200），
台账里预留的「退回上一个 LTS 代号」退路没有用上。

### 2.4 应用身份与数据目录（T2.4）

```bash
sudo groupadd -g 1100 veggie
sudo useradd -u 1100 -g 1100 -r -s /usr/sbin/nologin -M veggie
sudo mkdir -p /data/veggie/{uploads,backups} /opt/veggie /etc/veggie
sudo chown -R 1100:1100 /data/veggie
sudo chmod 750 /data/veggie /data/veggie/uploads /data/veggie/backups /etc/veggie
```

**uid 决策（方案 A）**：镜像里应用默认以 uid 1001（`nextjs`）运行，但**服务器上 1001 已被人类账号 `dev` 占用**。
直接 `chown 1001` 会让应用数据显示为 `dev` 所有，交接时看不懂。
所以建 `veggie`=**1100**（空闲 uid），compose 里用 `user: "1100:1100"` 覆盖镜像默认。

选这个方案要付两处代价，**缺一不可**（阶段 1 本地实测得出，见 `docs/20260804-local-pg-verification.md`）：

1. `nextcache` 卷挂到 `/app/.next/cache` —— 镜像里该目录属 1001，换 uid 后写不进去。
2. ⛔ `HOME=/tmp` 环境变量 —— uid 1100 在容器的 `/etc/passwd` 里没有条目，`HOME` 不指向可写目录，
   Chromium 的 crashpad 定不出数据目录直接拒绝启动，表现是**其它一切正常、唯独打印 PDF 500**，
   且报错指向 Chromium 而不是 uid，极难往「用户 id 没在 passwd 里」这个方向想。

**本机验证**（不是推演）：

```bash
sudo docker run --rm --user 1100:1100 -v /data/veggie/uploads:/data/uploads alpine:3 \
  sh -c 'mkdir -p /data/uploads/products && echo hi > /data/uploads/products/probe.txt'
# → 宿主机上落成 -rw-r--r-- veggie veggie probe.txt
```

### 2.5 PostgreSQL 17（T2.5）

```bash
sudo apt-get install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt-get install -y postgresql-17 postgresql-client-17
sudo -u postgres psql -c "CREATE ROLE veggie LOGIN;"
sudo -u postgres psql -c "CREATE DATABASE veggie OWNER veggie;"
```

**版本来源决策**：`https://apt.postgresql.org/pub/repos/apt/dists/resolute-pgdg/Release` 返回 200，
所以走 PGDG 装 17。Ubuntu 26.04 自带源只有 `postgresql-18` —— 装 18 虽然能恢复 17 的 dump，
但**不可逆**（之后回不到 17）。实装 **17.10**，与 Neon 生产端字面同版本，跨版本风险归零。

调优写在 `/etc/postgresql/17/main/conf.d/99-veggie.conf`（`postgresql.conf` 已启用 `include_dir`）：

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

验证：`ss -tulnp | grep 5432` **无输出**（不监听任何网络端口）。

#### ⛔ 认证方式决策：保持发行版默认 `peer`，不改 `pg_hba.conf`、不设密码

台账原本担心「容器内 uid 1100 没有 `veggie` 这个用户名 → peer 认证会失败」，因此预留了
「改 `trust`」或「设密码走 scram」两条退路。**实测推翻了这个担忧：**

```bash
# 容器以 1100:1100 走宿主机 socket
sudo docker run --rm --user 1100:1100 -v /var/run/postgresql:/var/run/postgresql postgres:17-alpine \
  psql "postgresql://veggie@localhost/veggie?host=/var/run/postgresql" -tAc "select current_user;"
# → veggie                                      ✅ 成功

# 对照：错误 uid
sudo docker run --rm --user 1099:1099 ... 
# → FATAL: Peer authentication failed for user "veggie"    ✅ 正确拒绝
```

**原因**：peer 认证由**宿主机上的 postgres 服务端**执行，它从 socket 的 `SO_PEERCRED` 拿到的是
**宿主机 uid**，再用**宿主机的 `/etc/passwd`** 反查用户名 —— 宿主机上 1100 就是 `veggie`。
容器内部有没有这个用户名完全不参与判定。

对照组证明认证并非形同虚设，因此这是三个选项里**攻击面最小**的：既没有 `trust`，也没有需要保管的密码。

连接串：`postgresql://veggie@localhost/veggie?host=/var/run/postgresql`
（compose 里把宿主机 `/var/run/postgresql` 挂进容器）。

### 2.6 Nginx（T2.6 Step 1–3；证书未签，阻塞于 B1）

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
# 站点文件见下，落在 /etc/nginx/sites-available/veggie
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sfn /etc/nginx/sites-available/veggie /etc/nginx/sites-enabled/veggie
sudo usermod -aG veggie www-data      # ← 权限决策，见下
sudo systemctl restart nginx
```

站点配置当前是 `server_name _;` + `listen 80 default_server`（B1 子域名到位后改成真实域名再跑 certbot）：

```nginx
client_max_body_size 20m;            # 采购单 PDF 上限 15MB，留余量
location /uploads/ { alias /data/veggie/uploads/; expires 30d; access_log off; }
location /        { proxy_pass http://127.0.0.1:3000; proxy_read_timeout 120s; }
```

**`www-data` 读 uploads 的权限决策**：选 `usermod -aG veggie www-data`，**不**把 uploads 改成 755。
理由：改 755 会让机器上**任何**本地账号都能读客户的上传文件（含采购单 PDF）；
加组只把读权限给 Nginx 一个进程身份，最小授权。代价是加组后必须重启 nginx 才生效（已做）。

验证（真发 HTTP，不是看配置）：

```
GET http://127.0.0.1/uploads/probe.txt  → 200 text/plain，内容正确   ✅ Nginx 直出可用
GET http://127.0.0.1/                   → 502                        ✅ 预期，应用尚未部署
```

### 2.7 防火墙（T2.7）

`ufw` 原本就是 active，规则未改：仅 `2200/tcp`、`80/tcp`、`443/tcp`（v4+v6）。

**从外部（本机）扫的结果**，不是在服务器上自己扫自己：

```
2200 OPEN · 80 OPEN · 22 filtered · 443 filtered(尚无监听) · 3000 filtered · 5432 filtered
```

`3000` 与 `5432` 必须始终是 filtered —— compose 里应用端口绑 `127.0.0.1:3000:3000`，
PostgreSQL `listen_addresses=''`，两层各自保证。

### 2.8 资源告警（T2.8）

产物在仓库里，可复现：`deploy/droplet/alert.sh` + `deploy/droplet/systemd/veggie-alert.{service,timer}`

```bash
sudo install -m 0755 -o root -g root alert.sh /opt/veggie/alert.sh
sudo install -m 0644 -o root -g root veggie-alert.service veggie-alert.timer /etc/systemd/system/
sudo mkdir -p /var/lib/veggie
sudo install -m 0600 -o root -g root alert.env /etc/veggie/alert.env   # 见下
sudo systemctl daemon-reload && sudo systemctl enable --now veggie-alert.timer
```

阈值：内存可用 < 400 MB · 根分区 > 80% · swap 使用 > 50%。每 5 分钟一次；
同类告警 6 小时内不重复发（`/var/lib/veggie/alert.state` 去重）。

发信走 **Resend**（与主机无关的 SaaS，迁移后照常可用，符合部署铁律），不是任何云监控产品。

`/etc/veggie/alert.env`（`root:root 0600`）：

```bash
# ⛔ 本文件被 alert.sh 以 `. ` 引入 —— 所有值必须加引号
RESEND_API_KEY=""                                          # ⛔ 待填，见 §3 B5
ALERT_TO="szahua@gmail.com"
ALERT_FROM="VeggieSupply Ops <noreply@veggiesupply.ie>"
MEM_THRESHOLD_MB="400"
DISK_THRESHOLD_PCT="80"
SWAP_THRESHOLD_PCT="50"
```

**验证到什么程度**（诚实说明）：探测与判定逻辑已实跑验证，**邮件本身没发出去过**，因为没有真 key。

```
sudo /opt/veggie/alert.sh                        → ok mem=3275MB disk=8% swap=0%   exit 0
sudo MEM_THRESHOLD_MB=999999 /opt/veggie/alert.sh → ALERT ... 阈值 <999999MB       exit 2
sudo DISK_THRESHOLD_PCT=1    /opt/veggie/alert.sh → ALERT ... 阈值 >1%              exit 2
sudo /opt/veggie/alert.sh                        → ok（未覆盖时不误报）            exit 0
```

> 途中修掉两个真 bug，都值得记住：
> 1. `alert.env` 里 `ALERT_FROM=VeggieSupply Ops <noreply@…>` **没加引号**，
>    `<` 被 shell 当成重定向，整个文件解析中断，连 `ALERT_TO` 都没读进去。
> 2. 脚本原本先 `. $CONF` 再取默认值，**配置文件会无条件覆盖命令行传入的环境变量** ——
>    台账里的验证命令 `sudo MEM_THRESHOLD_MB=999999 ...` 因此被静默改回 400，看起来"没告警"。
>    现已改成「命令行 > 配置文件 > 内置默认」。
>
> 讽刺的是，bug 1 掩盖了 bug 2：配置文件解析失败时环境变量反而生效，验证"通过"了。
> 修好 1 之后 2 才露出来。

---

## 3. 尚未完成 / 阻塞

| # | 事项 | 挡住什么 | 需要谁 |
|---|---|---|---|
| **B1** | 子域名 + 客户把 DNS A 记录指向 `167.99.86.19` | T2.6 Step 4–5 签发 TLS 证书 | 客户 |
| **B5** | **真实 `RESEND_API_KEY`** —— GCP Secret Manager 里 `VEGGIE_RESEND_API_KEY` 的值是字面量 `placeholder`（2026-04-18 建立至今没填过） | T2.8 Step 3「必须真收到一封告警邮件」的验收 | 用户 |
| B3 | DO Spaces 桶 + 4 个 `S3_*` | T3.2 的 `BACKUP_DRIVER=s3`（可先用 `local` 顶） | 用户 |

> **B5 的影响不止告警**：生产代码有三处在发邮件 ——
> `app/api/orders/route.ts`（订单确认）、`app/api/users/[id]/reset-password/route.ts`（密码重置）、
> `app/api/purchase-orders/[id]/route.ts`（采购询价 RFQ）。
> key 是 `placeholder` 意味着这三个功能在**现有 Cloud Run 生产环境上就是坏的**，与私有化迁移无关。

---

## 4. 复现清单（照着做一遍能得到同样的机器）

1. §2.1 swap → 2. §2.2 时区 → 3. §2.3 Docker → 4. §2.4 用户与目录 →
5. §2.5 PostgreSQL → 6. §2.6 Nginx → 7. §2.7 核对防火墙 → 8. §2.8 告警
9. 之后进入阶段 3：`deploy/droplet/README.md`
