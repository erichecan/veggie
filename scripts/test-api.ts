/**
 * scripts/test-api.ts
 *
 * 全量 API 提交测试脚本 — 覆盖所有 POST/PUT/PATCH 端点
 * 运行：  node_modules/.bin/tsx --env-file=.env.local scripts/test-api.ts
 *
 * 测试策略：
 *   1. 先 POST /api/auth/login 拿 token
 *   2. 依次测每个写入端点（POST 新建 → PUT 编辑 → DELETE 清理）
 *   3. 输出 PASS / FAIL 汇总表
 */

const TEST_PASSWORD = process.env.VEGGIE_TEST_PASSWORD ?? ''
if (!TEST_PASSWORD) {
  console.error('请先设置 VEGGIE_TEST_PASSWORD（不要把密码写进脚本）')
  process.exit(1)
}

const BASE = 'http://localhost:3000'

// ── 颜色工具 ──────────────────────────────────────────────────────────────────
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', RESET = '\x1b[0m'
const ok  = (s: string) => `${G}✓ PASS${RESET}  ${s}`
const err = (s: string) => `${R}✗ FAIL${RESET}  ${s}`
const info = (s: string) => `${C}ℹ${RESET}  ${s}`
const warn = (s: string) => `${Y}⚠ SKIP${RESET}  ${s}`

let token = ''
const results: { label: string; pass: boolean; note: string }[] = []

async function req(
  method: string,
  path: string,
  body?: unknown,
  expectStatus = 200,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  let json: unknown = null
  try { json = await res.json() } catch { /* empty */ }
  return { status: res.status, json }
}

function record(label: string, pass: boolean, note = '') {
  results.push({ label, pass, note })
  console.log(pass ? ok(label) : err(label), note ? `  → ${note}` : '')
}

// ── 1. 登录 ───────────────────────────────────────────────────────────────────
async function login() {
  console.log(`\n${C}=== 1. Auth ===${RESET}`)
  // 先查有没有 admin 用户
  const candidates = [
    // 密码从环境变量读，不写死在脚本里 —— 这里原本是 Demo1234!，
    // 与生产账号同一个口令（见 docs/20260807-production-credentials-audit.md）
    { email: 'operator@veggie.com', password: TEST_PASSWORD },
    { email: 'erichecan@gmail.com', password: TEST_PASSWORD },
  ]
  let r: { status: number; json: unknown } = { status: 0, json: null }
  for (const cred of candidates) {
    r = await req('POST', '/api/auth/login', cred)
    if (r.status === 200 && (r.json as { token?: string }).token) {
      token = (r.json as { token: string }).token
      record('POST /api/auth/login', true, `token 获取成功 (${cred.email})`)
      return true
    }
  }
  record('POST /api/auth/login', false, `status=${r.status}, resp=${JSON.stringify(r.json)}`)
  return false
}

// ── 2. 商品模板 ───────────────────────────────────────────────────────────────
async function testProductTemplates() {
  console.log(`\n${C}=== 2. 商品模板 (Product Templates) ===${RESET}`)
  const newTemplate = {
    name: '[TEST] 测试蔬菜',
    listPrice: 9.99,
    type: 'product',
    customerTaxRate: 0,
    weight: 1.0,
    canBeSold: true,
    canBePurchased: true,
  }
  const cr = await req('POST', '/api/product-templates', newTemplate)
  const created = cr.json as { id?: string; error?: string }
  record('POST /api/product-templates 新建商品', cr.status === 200 || cr.status === 201, `status=${cr.status} ${created.error ?? ''}`)
  const id = created.id
  if (!id) { console.log(warn('  跳过后续商品模板测试（无 id）')); return null }

  const ur = await req('PUT', `/api/product-templates/${id}`, { name: '[TEST] 测试蔬菜（已编辑）', listPrice: 12.5 })
  record('PUT /api/product-templates/[id] 编辑商品', ur.status === 200, `status=${ur.status}`)

  return id
}

// ── 3. 客户 ───────────────────────────────────────────────────────────────────
async function testCustomers() {
  console.log(`\n${C}=== 3. 客户 (Customers) ===${RESET}`)
  const newCustomer = {
    name: '[TEST] 测试客户',
    email: `test_${Date.now()}@example.com`,
    phone: '1234567890',
    address: '测试街道 1 号',
    priceType: 'pricelist',
  }
  const cr = await req('POST', '/api/customers', newCustomer)
  const created = cr.json as { id?: string; error?: string }
  record('POST /api/customers 新建客户', cr.status === 200 || cr.status === 201, `status=${cr.status} ${created.error ?? ''}`)
  const id = created.id
  if (!id) { console.log(warn('  跳过后续客户测试（无 id）')); return null }

  const ur = await req('PUT', `/api/customers/${id}`, { name: '[TEST] 测试客户（已编辑）', phone: '9999999' })
  record('PUT /api/customers/[id] 编辑客户', ur.status === 200, `status=${ur.status}`)

  // 客户特殊价格
  const pr = await req('GET', `/api/customers/${id}`)
  record('GET /api/customers/[id] 获取客户详情', pr.status === 200, `status=${pr.status}`)

  return id
}

// ── 4. 价格表 ─────────────────────────────────────────────────────────────────
async function testPricelists() {
  console.log(`\n${C}=== 4. 价格表 (Pricelists) ===${RESET}`)
  const newPl = {
    name: '[TEST] 测试价格表',
    currency: 'EUR',
    selectable: true,
    active: true,
    items: [],
  }
  const cr = await req('POST', '/api/pricelists', newPl)
  const created = cr.json as { id?: string; error?: string }
  record('POST /api/pricelists 新建价格表', cr.status === 200 || cr.status === 201, `status=${cr.status} ${created.error ?? ''}`)
  const id = created.id
  if (!id) { console.log(warn('  跳过后续价格表测试（无 id）')); return null }

  // 添加 global item（不需要产品关联）
  const globalItem = {
    id: crypto.randomUUID(),
    applyOn: 'global',
    minQty: 0,
    computeType: 'fixed',
    fixedPrice: 5.0,
    sequence: 10,
  }
  const ur1 = await req('PUT', `/api/pricelists/${id}`, {
    name: '[TEST] 测试价格表（已编辑）',
    items: [globalItem],
  })
  record('PUT /api/pricelists/[id] 添加 Global item', ur1.status === 200, `status=${ur1.status} ${(ur1.json as { error?: string }).error ?? ''}`)

  // 添加 formula item
  const formulaItem = {
    id: crypto.randomUUID(),
    applyOn: 'global',
    minQty: 0,
    computeType: 'formula',
    formulaBase: 'list_price',
    priceDiscount: 10,
    priceSurcharge: 0,
    roundingMethod: 0,
    sequence: 20,
  }
  const ur2 = await req('PUT', `/api/pricelists/${id}`, {
    items: [globalItem, formulaItem],
  })
  record('PUT /api/pricelists/[id] 添加 Formula item', ur2.status === 200, `status=${ur2.status} ${(ur2.json as { error?: string }).error ?? ''}`)

  // 添加 product item（不填 productTemplateId，测试新修复）
  const productItem = {
    id: crypto.randomUUID(),
    applyOn: 'product',
    minQty: 1,
    computeType: 'fixed',
    fixedPrice: 8.5,
    sequence: 30,
    // productTemplateId 故意留空，测试是否允许保存
  }
  const ur3 = await req('PUT', `/api/pricelists/${id}`, {
    items: [globalItem, formulaItem, productItem],
  })
  record('PUT /api/pricelists/[id] product item 无产品关联（应允许保存）', ur3.status === 200, `status=${ur3.status} ${(ur3.json as { error?: string }).error ?? ''}`)

  return id
}

// ── 5. 订单 ───────────────────────────────────────────────────────────────────
async function testOrders() {
  console.log(`\n${C}=== 5. 订单 (Orders) ===${RESET}`)

  // 先拿一个真实客户（restaurantId = 客户 id）和商品变体
  const custR = await req('GET', '/api/customers?pageSize=1')
  const custData = custR.json as { data?: { id: string; name?: string }[]; items?: { id: string; name?: string }[] }
  const customers = custData.data ?? custData.items ?? []
  if (!customers.length) { console.log(warn('  跳过订单测试（无客户数据）')); return null }
  const restaurantId = customers[0].id
  const restaurantName = (customers[0] as { name?: string }).name ?? '测试餐馆'

  // 取 product variants（/api/products 返回变体）
  const prodR = await req('GET', '/api/products?pageSize=1')
  const prodData = prodR.json as { id?: string }[] | { data?: { id: string; listPrice?: number }[] }
  const products = Array.isArray(prodData) ? prodData : (prodData.data ?? [])
  if (!products.length) { console.log(warn('  跳过订单测试（无商品数据）')); return null }
  const product = products[0] as { id: string; listPrice?: number }

  const newOrder = {
    restaurantId,
    restaurantName,
    deliveryDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
    notes: '[TEST] 测试订单',
    // API 读取 data.items（每条需含 productId + quantity）
    items: [
      { productId: product.id, quantity: 2, price: product.listPrice ?? 10 },
    ],
  }
  const cr = await req('POST', '/api/orders', newOrder)
  const created = cr.json as { id?: string; error?: string }
  record('POST /api/orders 新建订单', cr.status === 200 || cr.status === 201, `status=${cr.status} ${created.error ?? ''}`)
  const id = created.id
  if (!id) { console.log(warn('  跳过后续订单测试（无 id）')); return null }

  // Order 模型无 notes 字段，用 externalRef 测试编辑
  const ur = await req('PUT', `/api/orders/${id}`, { externalRef: '[TEST]-edited' })
  record('PUT /api/orders/[id] 编辑订单', ur.status === 200, `status=${ur.status}`)

  return id
}

// ── 6. 发票 ───────────────────────────────────────────────────────────────────
async function testInvoices() {
  console.log(`\n${C}=== 6. 发票 (Invoices) ===${RESET}`)
  const lr = await req('GET', '/api/invoices?pageSize=1')
  const listData = lr.json as { data?: { id: string }[]; items?: { id: string }[] } | { id: string }[]
  const invoices = Array.isArray(listData) ? listData : ((listData as { data?: { id: string }[] }).data ?? (listData as { items?: { id: string }[] }).items ?? [])
  if (!invoices.length) { console.log(warn('  跳过发票测试（无发票数据）')); return null }
  const id = invoices[0].id
  const gr = await req('GET', `/api/invoices/${id}`)
  record('GET /api/invoices/[id] 获取发票详情', gr.status === 200, `status=${gr.status}`)

  const ur = await req('PUT', `/api/invoices/${id}`, { notes: '[TEST] 发票备注' })
  record('PUT /api/invoices/[id] 编辑发票', ur.status === 200, `status=${ur.status}`)
}

// ── 7. 配送单 ─────────────────────────────────────────────────────────────────
async function testTrips() {
  console.log(`\n${C}=== 7. 配送单 (Trips) ===${RESET}`)
  const lr = await req('GET', '/api/trips?pageSize=1')
  const listData = lr.json as { data?: { id: string }[] } | { id: string }[]
  const trips = Array.isArray(listData) ? listData : ((listData as { data?: { id: string }[] }).data ?? [])
  if (!trips.length) { console.log(warn('  跳过配送单测试（无数据）')); return null }
  const id = trips[0].id
  const gr = await req('GET', `/api/trips/${id}`)
  record('GET /api/trips/[id] 获取配送单详情', gr.status === 200, `status=${gr.status}`)
}

// ── 8. 读取端点快速健康检查 ───────────────────────────────────────────────────
async function testReads() {
  console.log(`\n${C}=== 8. GET 端点健康检查 ===${RESET}`)
  const endpoints = [
    '/api/health',
    '/api/customers?pageSize=5',
    '/api/product-templates?pageSize=5',
    '/api/products?pageSize=5',
    '/api/pricelists?pageSize=5',
    '/api/orders?pageSize=5',
    '/api/invoices?pageSize=5',
    '/api/trips?pageSize=5',
    '/api/waves?pageSize=5',
    '/api/users',
    '/api/uoms',
    '/api/product-categories',
    '/api/suppliers',
  ]
  await Promise.all(endpoints.map(async (ep) => {
    const r = await req('GET', ep)
    record(`GET ${ep}`, r.status === 200, `status=${r.status}`)
  }))
}

// ── 清理测试数据 ──────────────────────────────────────────────────────────────
async function cleanup(ids: { productTemplateId?: string | null; customerId?: string | null; pricelistId?: string | null; orderId?: string | null }) {
  console.log(`\n${C}=== 9. 清理测试数据 ===${RESET}`)
  if (ids.orderId) {
    const r = await req('DELETE', `/api/orders/${ids.orderId}`)
    record(`DELETE /api/orders/${ids.orderId}`, r.status === 200 || r.status === 204, `status=${r.status}`)
  }
  if (ids.pricelistId) {
    const r = await req('DELETE', `/api/pricelists/${ids.pricelistId}`)
    record(`DELETE /api/pricelists/${ids.pricelistId}`, r.status === 200 || r.status === 204, `status=${r.status}`)
  }
  if (ids.customerId) {
    // /api/customers/[id] 没有 DELETE 端点，仅记录跳过（测试数据留在库中）
    console.log(warn(`  跳过客户清理（API 无 DELETE 端点）：${ids.customerId}`))
  }
  if (ids.productTemplateId) {
    const r = await req('DELETE', `/api/product-templates/${ids.productTemplateId}`)
    record(`DELETE /api/product-templates/${ids.productTemplateId}`, r.status === 200 || r.status === 204, `status=${r.status}`)
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────────────────
function summary() {
  const pass = results.filter(r => r.pass).length
  const fail = results.filter(r => !r.pass).length
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`${C}测试结果汇总${RESET}`)
  console.log(`  ${G}通过 ${pass}${RESET}  /  ${R}失败 ${fail}${RESET}  /  合计 ${results.length}`)
  if (fail > 0) {
    console.log(`\n${R}失败列表：${RESET}`)
    results.filter(r => !r.pass).forEach(r => console.log(`  ${R}✗${RESET} ${r.label}  → ${r.note}`))
  }
  console.log(`${'─'.repeat(60)}\n`)
}

// ── 主入口 ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C}╔══════════════════════════════════════════════╗`)
  console.log(`║  Veggie Demo — API 全量提交测试               ║`)
  console.log(`║  目标：${BASE}`)
  console.log(`╚══════════════════════════════════════════════╝${RESET}`)

  // 先检查服务是否启动
  try {
    const h = await fetch(`${BASE}/api/health`)
    if (!h.ok) throw new Error(`health check status ${h.status}`)
    console.log(info(`服务在线 (${BASE})`))
  } catch (e) {
    console.error(`\n${R}错误：服务未响应！请先运行 npm run dev${RESET}`)
    console.error(`  ${(e as Error).message}`)
    process.exit(1)
  }

  const loggedIn = await login()
  if (!loggedIn) {
    console.error(`\n${R}无法获取 token，终止测试（请检查管理员账号或 JWT_SECRET）${RESET}`)
    process.exit(1)
  }

  const productTemplateId = await testProductTemplates()
  const customerId = await testCustomers()
  const pricelistId = await testPricelists()
  const orderId = await testOrders()
  await testInvoices()
  await testTrips()
  await testReads()
  await cleanup({ productTemplateId, customerId, pricelistId, orderId })
  summary()
}

main().catch(e => { console.error(e); process.exit(1) })
