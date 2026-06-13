#!/usr/bin/env bash
# 在【本机】运行：rsync 断点续传拉取 dump + filestore，并校验和。
set -euo pipefail
cd "$(dirname "$0")"
source ./config.env

mkdir -p "$LOCAL_DIR"
echo "==> 从 $SSH_USER@$SSH_HOST:$REMOTE_WORKDIR 拉取到 $LOCAL_DIR"
rsync -avzP --partial -e "ssh -p ${SSH_PORT:-22}" \
  "$SSH_USER@$SSH_HOST:$REMOTE_WORKDIR/" "$LOCAL_DIR/"

echo "==> 校验完整性"
cd "$LOCAL_DIR"
shopt -s nullglob
sums=( checksums_*.sha256 )
if [ ${#sums[@]} -gt 0 ]; then
  if command -v sha256sum >/dev/null; then CK="sha256sum -c"; else CK="shasum -a 256 -c"; fi
  $CK "${sums[-1]}" || { echo "!! 校验失败，传输可能损坏，请重跑本脚本（--partial 会续传）"; exit 1; }
  echo "   校验通过 ✓"
else
  echo "   （未找到校验和文件，跳过校验）"
fi

echo "本地文件："
ls -lh
echo "下一步：./03-restore-local.sh 恢复成本地可查的库。"
