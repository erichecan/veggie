#!/usr/bin/env bash
# 从备份产物恢复数据库。
#
# 用法：
#   sudo bash restore-from-backup.sh /data/veggie/backups/backups/2026-08-05T…sql.gz
#   sudo bash restore-from-backup.sh -                      # 从 stdin 读（配合远端拉取）
#
# ⛔ 会 DROP 掉现有的 veggie 库。会先让你确认。
#
# 演练建议：每季度真跑一次（恢复到 veggie_drill 库而不是 veggie，用 --drill）。
# 「从没恢复过的备份」不算备份 —— 备份的价值只在恢复成功那一刻才兑现。

set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "请用 sudo 运行"; exit 1; }

DRILL=0
[ "${1:-}" = "--drill" ] && { DRILL=1; shift; }
SRC="${1:?用法: restore-from-backup.sh [--drill] <备份.sql.gz|->}"
DB=$([ "$DRILL" = 1 ] && echo veggie_drill || echo veggie)

if [ "$DRILL" = 0 ]; then
  echo "⛔ 即将 DROP DATABASE \"$DB\" 并从 $SRC 重建。"
  echo "   现有数据将不可恢复。输入 yes 继续："
  read -r ans; [ "$ans" = "yes" ] || { echo "已取消"; exit 1; }
fi

echo "▶ 停应用（避免恢复期间有连接持有旧库）"
if [ -f /opt/veggie/docker-compose.yml ]; then
  docker compose -f /opt/veggie/docker-compose.yml stop app || true
fi

echo "▶ 重建库 $DB"
sudo -u postgres psql -c "DROP DATABASE IF EXISTS \"$DB\";"
sudo -u postgres psql -c "CREATE DATABASE \"$DB\" OWNER veggie;"

echo "▶ 恢复"
# 备份产物是 pg_dump 的纯文本 gzip（cron 路由产出），不是 -Fc，所以用 psql 而非 pg_restore。
if [ "$SRC" = "-" ]; then
  gunzip -c | sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB" >/dev/null
else
  gunzip -c "$SRC" | sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB" >/dev/null
fi

echo "▶ ANALYZE（恢复不生成规划器统计，缺了它查询计划会很差）"
sudo -u postgres vacuumdb --analyze-only -j 2 -d "$DB" -q

echo "▶ 校验"
sudo -u postgres psql -d "$DB" -tAc "
select '表数 '||count(*) from information_schema.tables where table_schema='public';"
sudo -u postgres psql -d "$DB" -tAc "
select 'Order '||(select count(*) from \"Order\")||' 行, OrderLine '||(select count(*) from \"OrderLine\")||' 行';"
sudo -u postgres psql -d "$DB" -tAc "
select '迁移记录 '||count(*)||' 条，最后 '||max(migration_name) from _prisma_migrations;"

if [ "$DRILL" = 1 ]; then
  echo
  echo "✅ 演练完成。核对上面的行数是否与生产相符，然后清理："
  echo "   sudo -u postgres psql -c 'DROP DATABASE veggie_drill;'"
else
  echo "▶ 起应用"
  docker compose -f /opt/veggie/docker-compose.yml up -d app
  sleep 8
  curl -fsS http://127.0.0.1:3000/api/health && echo
  echo "✅ 恢复完成"
fi
