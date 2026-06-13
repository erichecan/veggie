#!/usr/bin/env bash
# 在【服务器上】运行：删掉 01 步在服务器临时目录里产生的 dump/filestore 包。
# 数据已安全拉回本机并校验后再跑——这一步只清服务器上的临时副本，不动数据库本体。
set -euo pipefail
cd "$(dirname "$0")"
source ./config.env

echo "将清理服务器临时目录：$REMOTE_WORKDIR"
echo "目录内容："
ls -lh "$REMOTE_WORKDIR" 2>/dev/null || { echo "（目录不存在，无需清理）"; exit 0; }
echo
echo "⚠️  请先确认：本机 02/03 已成功拉取并校验通过，再删服务器副本。"
read -rp "确认删除上面这些导出文件？[y/N] " ok
[ "$ok" = "y" ] || { echo "已取消"; exit 1; }

rm -f "$REMOTE_WORKDIR"/odoo_*.dump \
      "$REMOTE_WORKDIR"/filestore_*.tgz \
      "$REMOTE_WORKDIR"/checksums_*.sha256
echo "已删除导出文件。剩余内容："
ls -lh "$REMOTE_WORKDIR" 2>/dev/null || echo "（目录已空）"
echo "完成。导出的客户数据是 GDPR 受保护 PII，服务器上不留副本是正确做法。"
