#!/usr/bin/env bash
# 体积评估：整库大小 + 最大 25 表 + filestore 大小。
# 在【服务器上】运行（psql 走本机 socket）；或本机用 SSH 隧道连到源库后运行。
# 用途：判断 20G 构成，决定全量 / lean / 仅业务表。
set -euo pipefail
cd "$(dirname "$0")"
source ./config.env
export PGPASSWORD="${PG_PASSWORD:-}"

PSQL=(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -X -A -t)

echo "================ 整库大小 ================"
"${PSQL[@]}" -c "SELECT pg_size_pretty(pg_database_size(current_database()));"

echo "================ 最大 25 张表（含索引/TOAST）================"
psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -X -P pager=off -c "
SELECT relname AS table,
       pg_size_pretty(pg_total_relation_size(relid)) AS total
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 25;"

echo "================ 关键业务表行数 ================"
psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -X -P pager=off -c "
SELECT 'res_partner' t, count(*) FROM res_partner
UNION ALL SELECT 'product_product', count(*) FROM product_product
UNION ALL SELECT 'sale_order', count(*) FROM sale_order
UNION ALL SELECT 'sale_order_line', count(*) FROM sale_order_line
UNION ALL SELECT 'account_move', count(*) FROM account_move
UNION ALL SELECT 'stock_move', count(*) FROM stock_move;" 2>/dev/null \
  || echo "（部分表名因 Odoo 版本不同可能不存在，忽略报错）"

echo "================ filestore 大小 ================"
if [ -d "$DATA_DIR/filestore/$PG_DB" ]; then
  du -sh "$DATA_DIR/filestore/$PG_DB"
else
  echo "未找到 $DATA_DIR/filestore/$PG_DB —— 确认 DATA_DIR 或附件可能存在 DB 内(ir_attachment)。"
fi

echo
echo "判断：若 filestore 占了大头且暂不需要图片 → config.env 设 INCLUDE_FILESTORE=no，传输量骤降。"
echo "      若 mail_message/ir_logging 等很大 → 用 DUMP_SCOPE=lean 剔除它们的数据。"
