#!/usr/bin/env bash
# 把一台全新的空 Ubuntu 变成 veggie 的运行基线。
#
# 用途：灾备重建。Cloud Run 退役后，「整机没了」的唯一退路就是在新机器上重建 ——
# 这个脚本把 docs/20260805-server-baseline.md §2 的手工步骤自动化，
# 把重建时间从「照文档敲一小时」压到十几分钟，且不会敲错。
#
# 用法（在新机器上以有 sudo 的账号执行）：
#   sudo bash bootstrap.sh
#
# 做完之后还需要人工的三步（脚本不碰密钥）：
#   1. 放 /etc/veggie/app.env（含 JWT_SECRET，必须与原环境同值，否则用户全被登出）
#   2. 装 deploy 账号的 CI 公钥
#   3. 从备份恢复数据库：bash restore-from-backup.sh <备份文件.sql.gz>
#
# 幂等：重复执行安全。

set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "请用 sudo 运行"; exit 1; }

CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
log() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

log "1/8 swap 2G（无 swap 时一旦触顶，OOM killer 会直接杀掉 PostgreSQL）"
if ! swapon --show | grep -q swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile
  mkswap /swapfile >/dev/null && swapon /swapfile
fi
grep -q "^/swapfile" /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
echo "vm.swappiness=10" > /etc/sysctl.d/99-veggie-swap.conf
sysctl -p /etc/sysctl.d/99-veggie-swap.conf >/dev/null

log "2/8 时区 Europe/Dublin（业务日切分按爱尔兰本地）"
timedatectl set-timezone Europe/Dublin

log "3/8 Docker（官方源，不用发行版打包的旧版）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

log "4/8 应用身份 veggie=1100 与数据目录"
# 用 1100 而不是镜像默认的 1001：droplet 上 1001 通常已被人类账号占用。
groupadd -g 1100 veggie 2>/dev/null || true
useradd -u 1100 -g 1100 -r -s /usr/sbin/nologin -M veggie 2>/dev/null || true
mkdir -p /data/veggie/uploads /data/veggie/backups /opt/veggie /etc/veggie /var/lib/veggie
chown -R 1100:1100 /data/veggie
chmod 750 /data/veggie /data/veggie/uploads /data/veggie/backups

log "5/8 deploy 账号（CI 用，无 sudo，在 docker 组）"
useradd -m -s /bin/bash deploy 2>/dev/null || true
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh && chmod 700 /home/deploy/.ssh
chown -R deploy:deploy /home/deploy/.ssh
chown -R deploy:deploy /opt/veggie          # 它要写 .deployed_tag
chown root:deploy /etc/veggie && chmod 750 /etc/veggie   # env_file 是 compose 客户端读的

log "6/8 PostgreSQL 17（PGDG；与 Neon 源端同主版本，跨版本风险归零）"
apt-get install -y -qq postgresql-common
/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
apt-get install -y -qq postgresql-17 postgresql-client-17
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='veggie'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE veggie LOGIN;"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='veggie'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE veggie OWNER veggie;"
cat > /etc/postgresql/17/main/conf.d/99-veggie.conf <<'CONF'
listen_addresses = ''             # 只走 unix socket，网络攻击面归零
shared_buffers = 1GB              # 大于整库，预热后稳态零磁盘读
effective_cache_size = 2GB
work_mem = 16MB
maintenance_work_mem = 256MB
random_page_cost = 1.1            # SSD；默认 4.0 是机械盘假设
effective_io_concurrency = 200
max_connections = 50
CONF
chown postgres:postgres /etc/postgresql/17/main/conf.d/99-veggie.conf
systemctl restart postgresql@17-main
# 认证保持发行版默认的 peer：容器 uid 1100 → 宿主机 /etc/passwd 反查得到 veggie。
# 容器内部有没有这个用户名不参与判定，所以不需要 trust、也不需要密码。

log "7/8 Nginx + TLS"
apt-get install -y -qq nginx certbot python3-certbot-nginx
usermod -aG veggie www-data       # 让它能读 750 的 uploads，而不是把目录放成 755
HERE="$(dirname "$0")"
mkdir -p /var/www/certbot /etc/nginx/snippets /etc/letsencrypt/renewal-hooks/deploy

# 证书续期后重载 nginx。没有这个钩子，续期会「成功」但没人用上新证书 ——
# nginx 把证书读在内存里，不 reload 就一直发旧的，直到 90 天后过期全站告警，
# 而 certbot 日志一片绿。
if [ -f "$HERE/letsencrypt-hooks/reload-nginx.sh" ]; then
  install -m 755 "$HERE/letsencrypt-hooks/reload-nginx.sh" \
    /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
fi

if [ -f "$HERE/snippets/veggie-tls.conf" ]; then
  install -m 644 "$HERE/snippets/veggie-tls.conf" /etc/nginx/snippets/veggie-tls.conf
fi

# ⛔ 先有鸡还是先有蛋：nginx-veggie.conf 引用 /etc/letsencrypt/live/... 的证书，
# 全新机器上那个文件还不存在，nginx 会**直接起不来**，于是 certbot 也没法用
# webroot 签发（它需要一个能提供 /.well-known 的 nginx）。
# 所以：证书不在就先装 HTTP-only 版本，签完再切 TLS 版本。
CERT=/etc/letsencrypt/live/johnstonebros.ie/fullchain.pem
if [ -f "$CERT" ] && [ -f "$HERE/nginx-veggie.conf" ]; then
  install -m 644 "$HERE/nginx-veggie.conf" /etc/nginx/sites-available/veggie
elif [ -f "$HERE/nginx-veggie-http-only.conf" ]; then
  echo "  ℹ️ 尚无证书，先装 HTTP-only 配置。签发后再执行："
  echo "     certbot certonly --webroot -w /var/www/certbot -d johnstonebros.ie -d www.johnstonebros.ie"
  echo "     install -m 644 $HERE/nginx-veggie.conf /etc/nginx/sites-available/veggie && nginx -t && systemctl reload nginx"
  install -m 644 "$HERE/nginx-veggie-http-only.conf" /etc/nginx/sites-available/veggie
else
  echo "  ⚠️ 同目录没有 nginx 配置，跳过站点配置"
fi
if [ -f /etc/nginx/sites-available/veggie ]; then
  rm -f /etc/nginx/sites-enabled/default
  ln -sfn /etc/nginx/sites-available/veggie /etc/nginx/sites-enabled/veggie
  nginx -t && systemctl restart nginx
fi

log "8/8 防火墙 + 定时任务单元"
apt-get install -y -qq ufw
ufw allow 2200/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
D=$(dirname "$0")/systemd
if [ -d "$D" ]; then
  install -m 644 "$D"/veggie-*.service "$D"/veggie-*.timer /etc/systemd/system/
  install -m 755 "$(dirname "$0")/alert.sh" /opt/veggie/alert.sh
  chown root:root /opt/veggie/alert.sh
  systemctl daemon-reload
  echo "  单元已装。填好 /etc/veggie/{alert,backup}.env 后再 systemctl enable --now"
fi

cat <<'DONE'

════════════════════════════════════════════════════════════════
基线就绪。还差三步（都涉及密钥，脚本刻意不碰）：

  1. 写 /etc/veggie/app.env      —— 模板见 deploy/droplet/app.env.example
     ⛔ JWT_SECRET 必须与原环境同值，否则所有已登录用户被登出
     chown veggie:deploy && chmod 640   （compose 客户端要读它）
  2. 写 /etc/veggie/alert.env、/etc/veggie/backup.env（root:root 600）
  3. 装 deploy 的 CI 公钥到 /home/deploy/.ssh/authorized_keys
  4. 恢复数据：bash restore-from-backup.sh <备份.sql.gz>
  5. 触发一次 GitHub Actions 部署（或手工 docker compose up -d）
════════════════════════════════════════════════════════════════
DONE
