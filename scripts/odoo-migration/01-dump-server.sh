#!/usr/bin/env bash
# 在【服务器上】运行（建议在 tmux/screen 里，防 SSH 断线）：
#   pg_dump（custom 压缩格式）+ filestore 打包 + sha256 校验和。
# 先把 config.env 和本脚本 scp 到服务器同一目录。
set -euo pipefail
cd "$(dirname "$0")"
source ./config.env
export PGPASSWORD="${PG_PASSWORD:-}"

TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$REMOTE_WORKDIR"
DUMP="$REMOTE_WORKDIR/odoo_${PG_DB}_${TS}.dump"

echo "目标库：$PG_DB   范围：$DUMP_SCOPE   filestore：$INCLUDE_FILESTORE"
echo "工作目录剩余空间："
df -h "$REMOTE_WORKDIR" | tail -1
read -rp "确认对生产库执行 pg_dump？（请确保已获业主授权、低峰时段）[y/N] " ok
[ "$ok" = "y" ] || { echo "已取消"; exit 1; }

# lean 模式：保留表结构，但剔除这些膨胀表的 *数据*（迁移用不到），可完整恢复
EXCLUDES=()
if [ "$DUMP_SCOPE" = "lean" ]; then
  for t in mail_message mail_tracking_value mail_followers mail_notification \
           ir_logging bus_bus base_import_import base_import_mapping \
           mail_message_res_partner_rel; do
    EXCLUDES+=(--exclude-table-data="$t")
  done
  echo "lean：将剔除 ${#EXCLUDES[@]} 张膨胀表的数据（结构保留）"
fi

echo "==> pg_dump → $DUMP"
pg_dump -Fc -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" \
  "${EXCLUDES[@]}" -f "$DUMP"
echo "    完成：$(du -h "$DUMP" | cut -f1)"

if [ "$INCLUDE_FILESTORE" = "yes" ]; then
  if [ -d "$DATA_DIR/filestore/$PG_DB" ]; then
    FS="$REMOTE_WORKDIR/filestore_${PG_DB}_${TS}.tgz"
    echo "==> 打包 filestore → $FS"
    tar -czf "$FS" -C "$DATA_DIR/filestore" "$PG_DB"
    echo "    完成：$(du -h "$FS" | cut -f1)"
  else
    echo "!! 未找到 filestore 目录，跳过（附件可能存在 DB 内）"
  fi
fi

echo "==> 生成校验和"
( cd "$REMOTE_WORKDIR" && sha256sum "odoo_${PG_DB}_${TS}.dump" \
    $( [ "$INCLUDE_FILESTORE" = "yes" ] && ls "filestore_${PG_DB}_${TS}.tgz" 2>/dev/null ) \
    > "checksums_${TS}.sha256" )

echo
echo "产物（$REMOTE_WORKDIR）："
ls -lh "$REMOTE_WORKDIR" | grep "$TS" || ls -lh "$REMOTE_WORKDIR"
echo "下一步：回本机运行 ./02-transfer-local.sh 拉取。"
