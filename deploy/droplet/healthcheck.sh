#!/usr/bin/env bash
# 部署后健康检查 + 自动回滚。部署到服务器的 /opt/veggie/healthcheck.sh。
#
# 用法：healthcheck.sh <新 TAG> <上一个已知可用的 TAG>
#
# 为什么要回滚而不是只报错：部署失败时服务已经换成新镜像了，不回滚的话
# 「CI 变红」和「生产挂掉」是同时发生的。镜像用 sha tag 而不是 latest，
# 就是为了让回滚有确定的目标。
set -uo pipefail

NEW_TAG="${1:?用法: healthcheck.sh <新TAG> <上一个TAG>}"
PREV_TAG="${2:-}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/veggie}"
DEADLINE=$((SECONDS + ${TIMEOUT_SEC:-60}))

cd "$COMPOSE_DIR" || exit 1

log() { printf '[healthcheck] %s\n' "$*"; }

# 只认 db:ok。单看 HTTP 200 不够——应用起得来但连不上库时 /api/health 仍可能返回 200
# 而 db 字段是 error，那种状态下用户看到的是满屏 500。
probe() {
  local body
  body=$(curl -fsS --max-time 5 http://127.0.0.1:3000/api/health 2>/dev/null) || return 1
  grep -q '"db":"ok"' <<<"$body" || return 1
  printf '%s' "$body"
}

log "等待 $NEW_TAG 就绪（最多 $((DEADLINE - SECONDS))s）…"
while (( SECONDS < DEADLINE )); do
  if out=$(probe); then
    log "✅ 健康：$out"
    exit 0
  fi
  sleep 3
done

log "❌ 超时未就绪。最近日志："
docker compose logs app --tail 40 2>&1 | sed 's/^/    /'

if [[ -z "$PREV_TAG" || "$PREV_TAG" == "$NEW_TAG" ]]; then
  log "⛔ 没有可回滚的目标（PREV_TAG='$PREV_TAG'），保持现状并失败退出。"
  exit 1
fi

log "↩︎  回滚到 $PREV_TAG"
if TAG="$PREV_TAG" docker compose up -d --no-build app; then
  ROLLBACK_DEADLINE=$((SECONDS + 60))
  while (( SECONDS < ROLLBACK_DEADLINE )); do
    if out=$(probe); then
      log "✅ 已回滚到 $PREV_TAG 并恢复健康：$out"
      exit 1   # 仍以失败退出：部署没成功，CI 必须变红
    fi
    sleep 3
  done
  log "⛔ 回滚后仍不健康——需要人工介入。"
else
  log "⛔ 回滚命令本身失败——需要人工介入。"
fi
exit 1
