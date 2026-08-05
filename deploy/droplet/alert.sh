#!/usr/bin/env bash
# 资源告警 —— 内存 / 磁盘 / swap 超阈值时发邮件
#
# 部署位置：/opt/veggie/alert.sh（root:root 0755）
# 配置文件：/etc/veggie/alert.env（root:root 0600，含 RESEND_API_KEY / ALERT_TO）
# 触发方式：veggie-alert.timer 每 5 分钟一次
#
# 为什么用 Resend 而不是云监控：Resend 是与主机无关的 SaaS，迁移后照常可用，
# 符合 CLAUDE.md 的部署铁律（不得新增 GCP 专有依赖）。
#
# 手工验证（把阈值调到必然触发）：
#   sudo MEM_THRESHOLD_MB=999999 /opt/veggie/alert.sh; echo exit=$?

set -uo pipefail

CONF=${CONF:-/etc/veggie/alert.env}

# 优先级：命令行/环境变量 > 配置文件 > 内置默认。
# 先把调用方传进来的值扣下来，因为 `. $CONF` 会无条件覆盖同名变量 ——
# 否则台账里的验证命令 `sudo MEM_THRESHOLD_MB=999999 /opt/veggie/alert.sh`
# 会被配置文件里的 400 顶掉，看起来"没告警"，实际是被静默改回了阈值。
_OVERRIDES=$(for v in MEM_THRESHOLD_MB DISK_THRESHOLD_PCT SWAP_THRESHOLD_PCT \
                      ALERT_FROM ALERT_TO RESEND_API_KEY STATE_FILE REPEAT_AFTER_SEC; do
  [ -n "${!v:-}" ] && printf '%s=%q\n' "$v" "${!v}"
done)

[ -r "$CONF" ] && . "$CONF"
[ -n "$_OVERRIDES" ] && eval "$_OVERRIDES"

MEM_THRESHOLD_MB=${MEM_THRESHOLD_MB:-400}     # 可用内存低于此值告警
DISK_THRESHOLD_PCT=${DISK_THRESHOLD_PCT:-80}  # 根分区使用率高于此值告警
SWAP_THRESHOLD_PCT=${SWAP_THRESHOLD_PCT:-50}  # swap 使用率高于此值告警
ALERT_FROM=${ALERT_FROM:-'VeggieSupply Ops <noreply@veggiesupply.ie>'}
ALERT_TO=${ALERT_TO:-}
RESEND_API_KEY=${RESEND_API_KEY:-}
STATE_FILE=${STATE_FILE:-/var/lib/veggie/alert.state}
# 同一组问题持续存在时的重复提醒间隔，避免每 5 分钟刷一封
REPEAT_AFTER_SEC=${REPEAT_AFTER_SEC:-21600}   # 6 小时

HOST=$(hostname)

mem_available=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
mem_total=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)
disk_pct=$(df -P / | awk 'NR==2{gsub(/%/,"",$5); print $5}')
disk_avail=$(df -Ph / | awk 'NR==2{print $4}')
swap_total=$(awk '/^SwapTotal:/{print int($2/1024)}' /proc/meminfo)
swap_free=$(awk '/^SwapFree:/{print int($2/1024)}' /proc/meminfo)
if [ "${swap_total:-0}" -gt 0 ]; then
  swap_pct=$(( (swap_total - swap_free) * 100 / swap_total ))
else
  swap_pct=0
fi

problems=()
[ "$mem_available" -lt "$MEM_THRESHOLD_MB" ] && \
  problems+=("内存可用 ${mem_available}MB / 共 ${mem_total}MB（阈值 <${MEM_THRESHOLD_MB}MB）")
[ "$disk_pct" -gt "$DISK_THRESHOLD_PCT" ] && \
  problems+=("根分区已用 ${disk_pct}%，剩余 ${disk_avail}（阈值 >${DISK_THRESHOLD_PCT}%）")
[ "$swap_pct" -gt "$SWAP_THRESHOLD_PCT" ] && \
  problems+=("swap 已用 ${swap_pct}%（阈值 >${SWAP_THRESHOLD_PCT}%）—— 内存已经吃紧，OOM 风险")

# 一切正常：清掉状态，静默退出
if [ ${#problems[@]} -eq 0 ]; then
  rm -f "$STATE_FILE"
  echo "ok mem=${mem_available}MB disk=${disk_pct}% swap=${swap_pct}%"
  exit 0
fi

signature=$(printf '%s\n' "${problems[@]}" | sed 's/[0-9]\+/N/g' | md5sum | cut -c1-32)
now=$(date +%s)
if [ -r "$STATE_FILE" ]; then
  read -r last_sig last_ts < "$STATE_FILE" || true
  if [ "${last_sig:-}" = "$signature" ] && [ $(( now - ${last_ts:-0} )) -lt "$REPEAT_AFTER_SEC" ]; then
    echo "suppressed (同类告警 $(( (now - last_ts) / 60 )) 分钟前已发过) : ${problems[*]}"
    exit 0
  fi
fi

if [ -z "$RESEND_API_KEY" ] || [ -z "$ALERT_TO" ]; then
  echo "ALERT (未发送 —— RESEND_API_KEY 或 ALERT_TO 未配置): ${problems[*]}" >&2
  exit 2
fi

body_lines=$(printf '<li>%s</li>' "${problems[@]}")
top_mem=$(ps -eo comm,rss --sort=-rss --no-headers | head -5 | awk '{printf "<li>%s — %d MB</li>", $1, $2/1024}')

payload=$(cat <<JSON
{
  "from": $(printf '%s' "$ALERT_FROM" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "to": ["$ALERT_TO"],
  "subject": "⚠️ $HOST 资源告警",
  "html": "<div style=\"font-family:sans-serif\"><h3>$HOST 资源告警</h3><ul>$body_lines</ul><p>当前：内存可用 ${mem_available}MB / ${mem_total}MB，根分区 ${disk_pct}%（剩 ${disk_avail}），swap ${swap_pct}%</p><h4>占用最高的进程</h4><ul>$top_mem</ul><p style=\"color:#888;font-size:12px\">由 /opt/veggie/alert.sh 发出，$(date '+%F %T %Z')</p></div>"
}
JSON
)

http=$(curl -sS -o /tmp/veggie-alert-resp.json -w '%{http_code}' \
  -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$payload")

if [ "$http" = "200" ] || [ "$http" = "201" ]; then
  mkdir -p "$(dirname "$STATE_FILE")"
  echo "$signature $now" > "$STATE_FILE"
  echo "ALERT SENT ($http): ${problems[*]}"
  exit 0
fi

echo "ALERT SEND FAILED (http=$http): $(cat /tmp/veggie-alert-resp.json)" >&2
exit 1
