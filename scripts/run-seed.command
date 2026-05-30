#!/bin/bash
# Auto-generated seed runner — double-click this file to seed the Neon database
set -e
cd "$(dirname "$0")"
echo "============================================"
echo "  Veggie Demo — 数据库初始化 (db:seed)"
echo "============================================"
echo ""
npm run db:seed 2>&1 | tee /tmp/veggie-seed-output.txt
echo ""
echo "✅ 完成！输出已保存到 /tmp/veggie-seed-output.txt"
echo ""
echo "按任意键关闭窗口..."
read -n 1 -s
