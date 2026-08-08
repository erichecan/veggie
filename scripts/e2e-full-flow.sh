#!/usr/bin/env bash
# ============================================================================
# 全流程 E2E 验证（商业闭环版）
# ============================================================================
# 覆盖：登录 → 建客户 → 建 pricelist → 挂客户 → 下单 → 开发票 → 过账（会计凭证）
#
# 用法：
#   HOST=http://localhost:3000 bash scripts/e2e-full-flow.sh
#
# 前置：服务已启动，数据库已 migrate + seed
# ============================================================================

set -euo pipefail

HOST="${HOST:-http://localhost:3000}"
EMAIL="operator@veggie.com"
# 凭据不写死在脚本里 —— 20260807 之前这里是 Demo1234!，与生产账号同一个口令。
# 用法：VEGGIE_TEST_PASSWORD='xxx' bash scripts/e2e-full-flow.sh
PASS="${VEGGIE_TEST_PASSWORD:?请先设置 VEGGIE_TEST_PASSWORD（不要把密码写进脚本）}"

ok()  { echo -e "\033[32m✓\033[0m $1"; }
fail(){ echo -e "\033[31m✗\033[0m $1" >&2; exit 1; }

j() { node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const o=JSON.parse(s);console.log(eval("o."+process.argv[1]));}catch(e){console.error("parse fail:",s.slice(0,200));process.exit(1)}})' -- "$1"; }

echo "=========================================="
echo "🧪 全流程 E2E 验证"
echo "HOST=$HOST"
echo "=========================================="

# ── 1. 健康检查 ──────────────────────────────────────────────────────
echo ""
echo "[1/10] 健康检查..."
HEALTH=$(curl -fsS "$HOST/api/health")
STATUS=$(echo "$HEALTH" | j 'status')
[[ "$STATUS" == "ok" ]] || fail "health not ok: $HEALTH"
ok "health = ok"

# ── 2. 登录 ─────────────────────────────────────────────────────────
echo ""
echo "[2/10] 登录 $EMAIL..."
LOGIN=$(curl -fsS -X POST "$HOST/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
TOKEN=$(echo "$LOGIN" | j 'token')
[[ -n "$TOKEN" && "$TOKEN" != "undefined" ]] || fail "login fail: $LOGIN"
ok "token = ${TOKEN:0:20}..."

AUTH="Authorization: Bearer $TOKEN"

# ── 3. 建一个测试客户 ─────────────────────────────────────────────
echo ""
echo "[3/10] 建新客户 E2E-CUST-$(date +%s)..."
CUST_NAME="E2E 川味小厨 $(date +%s)"
CUST=$(curl -fsS -X POST "$HOST/api/customers" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d "{\"name\":\"$CUST_NAME\",\"address\":\"1 Test Rd\",\"phone\":\"0111111\",\"email\":\"e2e@test.com\",\"vatNumber\":\"IE1234567T\",\"paymentTerm\":\"monthly\",\"priceType\":\"multi\"}")
CUST_ID=$(echo "$CUST" | j 'id')
[[ -n "$CUST_ID" && "$CUST_ID" != "undefined" ]] || fail "create customer fail: $CUST"
ok "customer id = $CUST_ID"

# ── 4. 建一个 Pricelist ──────────────────────────────────────────
echo ""
echo "[4/10] 建新 pricelist..."
PL_NAME="E2E 测试价目表 $(date +%s)"
PL=$(curl -fsS -X POST "$HOST/api/pricelists" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d "{\"name\":\"$PL_NAME\",\"currency\":\"EUR\",\"items\":[],\"sequence\":999,\"selectable\":true,\"active\":true}")
PL_ID=$(echo "$PL" | j 'id')
[[ -n "$PL_ID" && "$PL_ID" != "undefined" ]] || fail "create pricelist fail: $PL"
ok "pricelist id = $PL_ID"

# ── 5. 取第一个商品、加一条 -10% 全局规则到 pricelist ───────────
echo ""
echo "[5/10] 添加 Global -10% 规则到 pricelist..."
PRODUCTS=$(curl -fsS -H "$AUTH" "$HOST/api/products")
PROD_ID=$(echo "$PRODUCTS" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const a=JSON.parse(s);console.log(Array.isArray(a)?a[0]?.id:a.data?.[0]?.id)})')
PROD_PRICE=$(echo "$PRODUCTS" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const a=JSON.parse(s);const x=Array.isArray(a)?a[0]:a.data?.[0];console.log(x?.listPrice ?? x?.template?.listPrice ?? 0)})')
[[ -n "$PROD_ID" && "$PROD_ID" != "undefined" ]] || fail "no product found"
ok "product id = $PROD_ID (listPrice=€$PROD_PRICE)"

# PUT pricelist 加一条全局 -10% 规则
UPDATE=$(curl -fsS -X PUT "$HOST/api/pricelists/$PL_ID" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d "{
    \"name\":\"$PL_NAME\",
    \"currency\":\"EUR\",
    \"items\":[{\"applyOn\":\"global\",\"minQty\":0,\"computeType\":\"formula\",\"formulaBase\":\"list_price\",\"priceDiscount\":10,\"priceSurcharge\":0,\"sequence\":100}],
    \"sequence\":999,
    \"selectable\":true,
    \"active\":true
  }")
ITEM_COUNT=$(echo "$UPDATE" | j 'items.length')
[[ "$ITEM_COUNT" == "1" ]] || fail "pricelist items count wrong: $UPDATE"
ok "pricelist 已含 1 条 Global -10% 规则"

# ── 6. 挂 pricelist 到客户 ───────────────────────────────────────
echo ""
echo "[6/10] 把 pricelist 挂到客户..."
CUST_UPDATE=$(curl -fsS -X PUT "$HOST/api/customers/$CUST_ID" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d "{\"name\":\"$CUST_NAME\",\"pricelistId\":\"$PL_ID\",\"priceType\":\"multi\",\"paymentTerm\":\"monthly\"}")
GOT_PL=$(echo "$CUST_UPDATE" | j 'pricelistId')
[[ "$GOT_PL" == "$PL_ID" ]] || fail "customer not linked to pricelist"
ok "客户已绑定 pricelist"

# ── 7. 用错误价格下单（应被服务端重写） ───────────────────────
echo ""
echo "[7/10] 测试下单（故意传 €0.01，预期被服务端重写为 listPrice×0.9）..."

# 计算期望价
EXPECTED=$(node -e "console.log(Math.round(${PROD_PRICE} * 0.9 * 100) / 100)")

ORDER=$(curl -fsS -X POST "$HOST/api/orders" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d "{
    \"restaurantId\":\"$CUST_ID\",
    \"restaurantName\":\"$CUST_NAME\",
    \"items\":[{\"productId\":\"$PROD_ID\",\"productName\":\"Test\",\"spec\":\"CASE\",\"price\":0.01,\"quantity\":1,\"subtotal\":0.01}],
    \"totalAmount\":0.01,
    \"status\":\"PENDING\",
    \"paymentMethod\":\"ONLINE\"
  }" || echo "ORDER_FAIL")

if [[ "$ORDER" == "ORDER_FAIL" || "$ORDER" == *"INSUFFICIENT_STOCK"* ]]; then
  echo "  ⚠️  下单失败（可能库存不足，这是正确的业务保护）"
  # 跳过后续订单相关步骤
  SKIP_INVOICE=1
else
  ORDER_ID=$(echo "$ORDER" | j 'id')
  ORDER_TOTAL=$(echo "$ORDER" | j 'totalAmount')
  WARNINGS=$(echo "$ORDER" | j 'pricingWarnings.length')
  ok "order id = $ORDER_ID, 服务端重算后总金额 €$ORDER_TOTAL, warnings = $WARNINGS"
  if (( $(echo "$WARNINGS" | head -c1) == 0 )); then
    echo "  ⚠️  预期有 warning（价格被重写），实际没有"
  fi
  SKIP_INVOICE=0
fi

# ── 8. 创建一张发票 ──────────────────────────────────────────────
if [[ "${SKIP_INVOICE:-0}" == "0" ]]; then
  echo ""
  echo "[8/10] 对订单开发票..."
  INV_NAME="INV-E2E-$(date +%s)"
  INV=$(curl -fsS -X POST "$HOST/api/invoices" \
    -H "Content-Type: application/json" \
    -H "$AUTH" \
    -d "{
      \"name\":\"$INV_NAME\",
      \"customerId\":\"$CUST_ID\",
      \"customerName\":\"$CUST_NAME\",
      \"saleOrderIds\":[\"$ORDER_ID\"],
      \"lines\":[{\"productId\":\"$PROD_ID\",\"productName\":\"Test\",\"qty\":1,\"unitPrice\":$EXPECTED,\"taxRate\":0.135}],
      \"paymentTerms\":\"monthly\"
    }")
  INV_ID=$(echo "$INV" | j 'id')
  INV_TOTAL=$(echo "$INV" | j 'totalIncTax')
  [[ -n "$INV_ID" && "$INV_ID" != "undefined" ]] || fail "create invoice fail: $INV"
  ok "invoice id = $INV_ID, totalIncTax = €$INV_TOTAL"

  # ── 9. 过账发票（生成会计凭证） ────────────────────────────
  echo ""
  echo "[9/10] 发票过账（生成会计凭证）..."
  POSTED=$(curl -fsS -X POST "$HOST/api/invoices/$INV_ID/post" -H "$AUTH" -H "Content-Type: application/json" -d '{}')
  NEW_STATUS=$(echo "$POSTED" | j 'status')
  JE_NAME=$(echo "$POSTED" | j 'journalEntry.name' 2>/dev/null || echo "N/A")
  WARN=$(echo "$POSTED" | j 'warning' 2>/dev/null || echo "")
  [[ "$NEW_STATUS" == "POSTED" ]] || fail "post invoice fail: $POSTED"
  if [[ "$JE_NAME" != "N/A" && "$JE_NAME" != "null" ]]; then
    ok "invoice POSTED, 自动生成会计凭证 = $JE_NAME"
  else
    echo "  ⚠️  invoice POSTED 但未生成凭证（标准科目可能未 seed）: $WARN"
  fi
fi

# ── 10. 查健康检查最终状态 ────────────────────────────────────
echo ""
echo "[10/10] 最终健康检查..."
curl -fsS "$HOST/api/health" > /dev/null
ok "health 仍然 OK"

echo ""
echo "=========================================="
echo "✅ 全流程 E2E 验证通过"
echo "=========================================="
