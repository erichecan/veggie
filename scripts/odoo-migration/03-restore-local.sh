#!/usr/bin/env bash
# 在【本机】运行：把拉回来的 dump 恢复成一个本地可查的 Postgres 库。
# 这是「只读分析库」，用来看 Odoo 原始数据，不是你的应用库——不要直接往里写。
set -euo pipefail
cd "$(dirname "$0")"
source ./config.env

cd "$LOCAL_DIR"
shopt -s nullglob
dumps=( odoo_*.dump )
[ ${#dumps[@]} -gt 0 ] || { echo "!! $LOCAL_DIR 下没有 odoo_*.dump，先跑 02-transfer-local.sh"; exit 1; }
DUMP="${dumps[-1]}"   # 取最新一个
echo "==> 将恢复：$DUMP  →  本地库 $RESTORE_DB"

# 本机需要有 postgres（psql/createdb/pg_restore）。检测一下。
command -v pg_restore >/dev/null || { echo "!! 本机未装 postgres 客户端，brew install postgresql@16"; exit 1; }

# 若库已存在，先确认是否重建（避免误删别的库）
if psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$RESTORE_DB"; then
  read -rp "本地库 $RESTORE_DB 已存在，DROP 重建？[y/N] " ok
  [ "$ok" = "y" ] || { echo "已取消"; exit 1; }
  dropdb "$RESTORE_DB"
fi
createdb "$RESTORE_DB"

echo "==> pg_restore（并行 4 路，忽略属主/权限差异）"
# --no-owner/--no-privileges：本机用户≠odoo 用户，跳过属主设置，避免一堆 role 报错
# 末行返回非 0 也常见（仅 warning），用 || true 兜住，再人工看摘要
pg_restore -j 4 --no-owner --no-privileges -d "$RESTORE_DB" "$DUMP" || \
  echo "（pg_restore 有非致命告警，属正常；下面做完整性抽查）"

echo "==> 抽查行数"
psql -d "$RESTORE_DB" -X -P pager=off -c "
SELECT 'res_partner' t, count(*) FROM res_partner
UNION ALL SELECT 'product_product', count(*) FROM product_product
UNION ALL SELECT 'sale_order', count(*) FROM sale_order
UNION ALL SELECT 'account_move', count(*) FROM account_move;" 2>/dev/null \
  || echo "（部分表不存在，按 Odoo 版本不同属正常）"

# filestore 解包（如果传了）
fs=( filestore_*.tgz )
if [ ${#fs[@]} -gt 0 ]; then
  echo "==> 解包 filestore：${fs[-1]} → ./filestore/"
  mkdir -p filestore && tar -xzf "${fs[-1]}" -C filestore
  echo "   filestore 已解到 $LOCAL_DIR/filestore/（图片/附件，按需取用）"
fi

echo
echo "完成。用以下命令开始分析原始数据："
echo "   psql -d $RESTORE_DB"
echo "   # 或：DATABASE_URL_ODOO=postgresql://localhost/$RESTORE_DB 写映射脚本读它"
echo "下一步（可选）：服务器上的临时 dump 清掉 → ./04-cleanup-server.sh（在服务器上跑）"
