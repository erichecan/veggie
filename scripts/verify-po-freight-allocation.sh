#!/usr/bin/env bash
# 验证脚本：采购运费按数量分摊进成本，确认时联动 Product.standardPrice（T1-T5）
# 对应 docs/20261017-采购运费分摊成本联动-tasks.md「附录 A：技术验收标准」。
#
# 用法：
#   BASE_URL=http://localhost:3001 \
#   BOSS_EMAIL=boss(at)demo.local BOSS_PASSWORD=... \
#   LOWPERM_EMAIL=finance(at)demo.local LOWPERM_PASSWORD=... \
#   ./scripts/verify-po-freight-allocation.sh
#
# BOSS_* 需要同时具备 purchase.order.update + purchase.order.approve（下单+确认都要做）。
# LOWPERM_* 只需没有 purchase.order.approve 即可（如 FINANCE 角色），用来验证"更新权限够、
# 审批权限不够"时 confirm 返回 403；没设这两个 env 时该条探针跳过并标 ⚠️ 未验证，不冒充通过。
#
# 退出码非 0 = 有断言失败，不允许在此基础上出完成报告。
set -o pipefail
FAIL=0

echo "1/3 — tsc"
npx tsc --noEmit && echo "  ✅ tsc --noEmit" || { echo "  ❌ tsc --noEmit"; FAIL=1; }

echo "2/3 — prisma migrate status"
npx prisma migrate status | tee /tmp/verify-po-freight-migrate-status.log | grep -q "Database schema is up to date" \
  && echo "  ✅ migrate status up to date" \
  || { echo "  ❌ migrate status 异常，见 /tmp/verify-po-freight-migrate-status.log"; FAIL=1; }

echo "3/3 — 确认/取消/校验/鉴权/SERVICE 探针（HTTP，Python 实现）"
python3 "$(dirname "$0")/verify-po-freight-allocation.py" || FAIL=1

exit $FAIL
