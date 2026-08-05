#!/usr/bin/env bash
# 在 droplet 上执行的部署脚本。由 .github/workflows/deploy-droplet.yml 调用。
#
# ⛔ 为什么是独立文件而不是 workflow 里的 ssh heredoc：
#    原先写法是 `ssh host bash -s <<EOSSH ... EOSSH`，脚本本身走 stdin。
#    而 `docker compose run` 默认接管 stdin —— 它把脚本剩下的部分整段吃掉了，
#    于是 migrate 之后的 up -d / healthcheck / 写 .deployed_tag 全没执行，
#    bash 读到 EOF 正常退出，**工作流报成功而应用根本没起来**。
#    2026-08-05 首次部署实测踩到。脚本落成文件后 stdin 与脚本解耦，这类问题不再可能。
#
# 入参：
#   环境变量 TAG（必需）、SKIP_MIGRATE（true/false）、GHCR_USER
#   stdin 第一行：GHCR token（走 stdin 而不是命令行，避免出现在服务器的 ps 里）
set -euo pipefail

TAG="${TAG:?缺少 TAG}"
SKIP_MIGRATE="${SKIP_MIGRATE:-false}"
GHCR_USER="${GHCR_USER:?缺少 GHCR_USER}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/veggie}"

read -r GHCR_TOKEN || true
[ -n "${GHCR_TOKEN:-}" ] || { echo "⛔ stdin 没读到 GHCR token"; exit 1; }

cd "$COMPOSE_DIR"

# 仓库是 private → GHCR 上的包也是 private → 不登录就 pull 不下来（401）。
# 用的是本次 job 的 GITHUB_TOKEN（有 packages:read），不在服务器上长期存 PAT。
printf '%s\n' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

# 上一次成功部署的 tag = 回滚目标。用显式状态文件而不是从 compose 配置里正则抠——
# 后者依赖输出格式，改版就静默失效，而失效的表现是「回滚目标为空、出事时没得回滚」，
# 恰恰在最需要它的时候不工作。
PREV_TAG=$(cat .deployed_tag 2>/dev/null || true)
echo "PREV_TAG=${PREV_TAG:-<无，首次部署>}  NEW_TAG=$TAG"

export TAG
# migrator 挂了 profiles: ["tools"]，pull 时不带 --profile 会被静默跳过，
# 后面 run 就得现拉，等于丢掉「先拉好再动」的保证。
docker compose --profile tools pull app migrator

# 「先迁移后部署」：加列这类增量变更下旧代码对多出的可空列前向兼容；
# 反过来会出「镜像 client 期望新列、库还没有」的 ColumnNotFound 500。
if [ "$SKIP_MIGRATE" != "true" ]; then
  # -T 关掉 TTY 分配，</dev/null 断掉 stdin —— 双保险，见文件头的说明
  docker compose run --rm -T migrator npx prisma migrate deploy < /dev/null
else
  echo "⏭  按输入跳过迁移"
fi

docker compose up -d --no-build app

# healthcheck 失败会自行回滚并以非零码退出，此时不更新 .deployed_tag，
# 下次部署的回滚目标仍是最后一个真正健康过的版本。
./healthcheck.sh "$TAG" "${PREV_TAG:-}"
echo "$TAG" > .deployed_tag
echo "✅ 部署完成：$TAG"
