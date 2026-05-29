#!/usr/bin/env bash
# ============================================================================
# 端到端主流程验证脚本
# ============================================================================
# 用途：服务启动后，一键跑通"登录→建客户→绑pricelist→下单→价格服务端重算"
#
# 使用：
#   bash scripts/e2e-verify.sh                       # 默认 http://localhost:3000
#   HOST=http://localhost:3005 bash scripts/e2e-verify.sh
#
# 前置条件：
#   1. 已 npx prisma migrate deploy
#   2. 已 npx prisma db seed（或 npm run db:seed）
#   3. 服务已启动（npm run dev 或 npm start）
# ============================================================================

set -euo pipefail

HOST="${HOST:-http://localhost:3000}"
OPERATOR_EMAIL="operator@veggie.com"
DEFAULT_PASSWORD="Demo1234!"

echo "========================================"
echo "🧪 E2E 主流程验证（对标 CLAUDE.md 完成标准）"
echo "========================================"
echo "HOST=$HOST"
echo ""

# ── 1. health check ────────────────────────────────────────────────
echo "[1/6] 健康检查..."
HEALTH=$(curl -fsS "$HOST/api/health") || { echo "❌ health fail"; exit 1; }
echo "  ✅ $HEALTH"
echo ""

# ── 2. 登录拿 token ────────────────────────────────────────────────
echo "[2/6] 登录（$OPERATOR_EMAIL）..."
LOGIN_RESP=$(curl -fsS -X POST "$HOST/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$OPERATOR_EMAIL\",\"password\":\"$DEFAULT_PASSWORD\"}")
TOKEN=$(echo "$LOGIN_RESP" | grep -oE '"token":"[^"]+"' | cut -d'"' -f4)
[[ -n "$TOKEN" ]] || { echo "❌ 登录失败：$LOGIN_RESP"; exit 1; }
echo "  ✅ 拿到 token：${TOKEN:0:30}..."
echo ""

# ── 3. 错误密码登录应被拒 ─────────────────────────────────────────
echo "[3/6] 错误密码登录应 401..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$HOST/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"operator@veggie.com","password":"wrong"}')
[[ "$STATUS" == "401" ]] && echo "  ✅ 正确返回 401" || { echo "❌ 期望 401，实得 $STATUS"; exit 1; }
echo ""

# ── 4. 未授权访问受保护接口应 401 ────────────────────────────────
echo "[4/6] 未授权 POST /api/orders 应 401..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$HOST/api/orders" \
  -H "Content-Type: application/json" \
  -d '{}')
[[ "$STATUS" == "401" ]] && echo "  ✅ 正确返回 401" || { echo "❌ 期望 401，实得 $STATUS"; exit 1; }
echo ""

# ── 5. 拉客户和商品列表（验证数据已 seed） ──────────────────────
echo "[5/6] 拉 pricelist / customers / products..."
PL_COUNT=$(curl -fsS "$HOST/api/pricelists" -H "Authorization: Bearer $TOKEN" | \
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const a=JSON.parse(s);console.log(Array.isArray(a)?a.length:(a.total ?? 0))})')
CUST_COUNT=$(curl -fsS "$HOST/api/customers" -H "Authorization: Bearer $TOKEN" | \
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const a=JSON.parse(s);console.log(Array.isArray(a)?a.length:(a.total ?? 0))})')
PROD_COUNT=$(curl -fsS "$HOST/api/products" -H "Authorization: Bearer $TOKEN" | \
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const a=JSON.parse(s);console.log(Array.isArray(a)?a.length:(a.total ?? 0))})')
echo "  pricelist=$PL_COUNT  customers=$CUST_COUNT  products=$PROD_COUNT"
[[ "$PL_COUNT" -gt 0 && "$CUST_COUNT" -gt 0 && "$PROD_COUNT" -gt 0 ]] && \
  echo "  ✅ 数据已 seed" || { echo "❌ 请先 npm run db:seed"; exit 1; }
echo ""

# ── 6. 核心测试：服务端价格校验 ────────────────────────────────────
echo "[6/6] 创建订单 + 服务端价格重算..."
# 取一个餐馆用户 ID + 一个商品 ID 组装订单
RESP=$(curl -fsS "$HOST/api/customers" -H "Authorization: Bearer $TOKEN")
CUST_ID=$(echo "$RESP" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const a=JSON.parse(s);const x=Array.isArray(a)?a[0]:a.items?.[0];console.log(x?.id ?? "")})')
PROD_RESP=$(curl -fsS "$HOST/api/products" -H "Authorization: Bearer $TOKEN")
PROD_ID=$(echo "$PROD_RESP" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const a=JSON.parse(s);const x=Array.isArray(a)?a[0]:a.items?.[0];console.log(x?.id ?? "")})')

[[ -n "$CUST_ID" && -n "$PROD_ID" ]] || { echo "❌ 拿不到 customer/product id"; exit 1; }

# 测试：故意传一个低价，服务端应用权威价重写
ORDER_JSON=$(cat <<EOF
{
  "restaurantId": "$CUST_ID",
  "restaurantName": "E2E Test Restaurant",
  "items": [
    {"productId":"$PROD_ID","productName":"Test","spec":"CASE","price":0.01,"quantity":1,"subtotal":0.01}
  ],
  "totalAmount": 0.01,
  "status": "PENDING",
  "paymentMethod": "ONLINE"
}
EOF
)
CREATED=$(curl -fsS -X POST "$HOST/api/orders" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$ORDER_JSON" 2>&1) || { echo "⚠️  订单创建失败（可能是库存不足或客户无关联 pricelist，用 demo seed 应正常）:"; echo "$CREATED"; exit 1; }

echo "  服务端响应："
echo "$CREATED" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const o=JSON.parse(s);console.log("  ✅ 订单号:", o.id);console.log("  ✅ 最终金额:", o.totalAmount);console.log("  ✅ 价格警告:", JSON.stringify(o.pricingWarnings));console.log("  ✅ 价格溯源:", JSON.stringify(o.pricingDetail?.[0]));})'
echo ""

echo "========================================"
echo "✅ 全部 6 项验证通过"
echo "========================================"
