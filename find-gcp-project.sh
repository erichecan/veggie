#!/usr/bin/env bash
# 查询 GCP 项目列表，找出包含 "supply" 的项目
# 运行方式：bash find-gcp-project.sh
# 结果会保存到 .gcp-project-result.txt

OUTPUT_FILE="$(dirname "$0")/.gcp-project-result.txt"

echo "🔍 查询 GCP 项目列表..."

# 尝试用指定账号查询，失败则用当前登录账号
RESULT=$(gcloud projects list --account=erichecan@gmail.com 2>/dev/null || gcloud projects list 2>&1)

echo "$RESULT" > "$OUTPUT_FILE"

echo ""
echo "=== 所有项目 ==="
echo "$RESULT"
echo ""
echo "=== 包含 'supply' 的项目 ==="
echo "$RESULT" | grep -i supply || echo "（未找到包含 supply 的项目）"

echo ""
echo "✅ 结果已保存到：$OUTPUT_FILE"
echo "   Claude 会自动读取并更新 deploy.sh"
