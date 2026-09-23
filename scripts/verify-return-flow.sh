#!/usr/bin/env bash
# 验证脚本：退换货流程补缺口（仓库核实 + 销售权限 + 司机上报权限拆分）
# 对应 DEV-PLAN.md「附录 A：技术验收标准」。
#
# 用法：
#   BASE_URL=http://localhost:3011 \
#   DRIVER_EMAIL=driver(at)demo.local DRIVER_PASSWORD=... \
#   WAREHOUSE_EMAIL=warehouse(at)demo.local WAREHOUSE_PASSWORD=... \
#   SALES_EMAIL=operator3(at)demo.local SALES_PASSWORD=... \
#   ./scripts/verify-return-flow.sh
#
# 退出码非 0 = 有断言失败，不允许在此基础上出完成报告。
set -o pipefail
FAIL=0

echo "1/2 — tsc + build"
npx tsc --noEmit && echo "  ✅ tsc --noEmit" || { echo "  ❌ tsc --noEmit"; FAIL=1; }
npm run build > /tmp/verify-return-flow-build.log 2>&1 \
  && echo "  ✅ npm run build" \
  || { echo "  ❌ npm run build（见 /tmp/verify-return-flow-build.log）"; FAIL=1; }

echo "2/2 — 鉴权与状态机探针（HTTP，Python 实现）"
python3 "$(dirname "$0")/verify-return-flow.py" || FAIL=1

exit $FAIL
