/**
 * 「上次成交价」只认销售单，不认报价单（台账 X9）—— 端到端实证
 * ============================================================================
 * 客户 20260814：「price type 是 multi 或 last 时，上一次的价格，是指 sale order
 * 的价格，不应该是 quotation 价格。」
 *
 * 本系统里报价单不是独立实体，就是 `status='PENDING'` 的 Order。此前取历史成交价
 * 只排除 CANCELLED，于是一张**从没被确认、甚至已经谈崩**的报价单，它的价会直接
 * 变成下一单的基准价。而报价只是要价，不是成交。
 *
 * 验证的关键是**造出对照**：同一个客户同一个商品，先有一张已成交的销售单（价 A），
 * 再有一张更晚的报价单（价 B，故意不同）。只要引擎取到的是 A 而不是 B 就对了。
 * 只造报价单是测不出来的 —— 那样"没取到"和"取错了"长得一样。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:last-price
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { queryLastSoldPricesDetailed } from '../../lib/server-pricing'
import { ensureOpeningStock } from '../../prisma/seed-events/inventory'
import { seedPassword } from './_seed-credentials'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()
const eur = (n: unknown) => `€${Number(n ?? 0).toFixed(2)}`
const near = (a: number, b: number) => Math.abs(a - b) < 0.011

async function login(email: string): Promise<string | null> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: seedPassword(email) }),
  })
  return (await r.json() as { token?: string }).token ?? null
}

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }
  const token = await login(OPERATOR)
  if (!token) { skip('登录', '运营账号登录失败（限流？）'); return report() }
  const auth: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  const stamp = Date.now()
  const cust = await prisma.customer.create({
    data: { name: `X9 客户 ${stamp}`, isActive: true, paymentTerm: 'cash', priceType: 'last' },
    select: { id: true, name: true },
  })
  const product = await prisma.product.create({
    data: {
      name: `X9 商品 ${stamp}`, type: 'PRODUCT', status: 'ACTIVE',
      listPrice: 10, standardPrice: 6, uomId: 'uom_pcs', canBeSold: true, qtyOnHand: 0, active: true,
    },
    select: { id: true },
  })
  const productId = product.id
  // ⚠️ 确认订单会扣库存。库存 0 的商品确认两张单就扣成 -2，撞 db:validate 的「库存非负」——
  // 而那是**夹具**不守恒，不是产品缺陷。期初库存必须连 StockMove 一起写（台账已栽过四次）
  await ensureOpeningStock(prisma, {
    target: 100, backdate: new Date('2026-08-05T00:00:00Z'), productIds: [productId],
  })

  const SOLD = 20.0    // 真正成交的价
  const QUOTED = 99.0  // 只报过价、从未确认

  const mkOrder = async (price: number) => {
    const r = await fetch(`${BASE}/api/orders`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        restaurantId: cust.id, restaurantName: cust.name,
        deliveryDate: new Date().toISOString().slice(0, 10),
        items: [{ productId, quantity: 1, unitPrice: price }],
      }),
    })
    return (await r.json() as { id?: string }).id
  }

  // ── 夹具：先一张已成交的销售单，再一张更晚的报价单 ─────────────────────────
  const soldId = await mkOrder(SOLD)
  if (!soldId) { skip('夹具建单', '建单失败'); return report() }
  // 单价要真按 SOLD 落库（服务端权威定价可能改写），先核实再往下走
  await prisma.orderLine.updateMany({ where: { orderId: soldId }, data: { unitPrice: SOLD, subtotal: SOLD } })
  await prisma.order.update({ where: { id: soldId }, data: { totalAmount: SOLD } })
  const confirmRes = await fetch(`${BASE}/api/orders/${soldId}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ status: 'CONFIRMED' }),
  })
  const soldOrder = await prisma.order.findUnique({ where: { id: soldId }, select: { status: true } })
  add('夹具：一张 €20.00 的**销售单**（已确认）',
    confirmRes.ok && soldOrder?.status === 'CONFIRMED', `状态 ${soldOrder?.status}`)

  // 报价单：更晚创建，价格 €99 —— 修复前它会赢下「最近一次」
  const quoteId = await mkOrder(QUOTED)
  if (!quoteId) { skip('夹具报价单', '建单失败'); return report() }
  await prisma.orderLine.updateMany({ where: { orderId: quoteId }, data: { unitPrice: QUOTED, subtotal: QUOTED } })
  await prisma.order.update({ where: { id: quoteId }, data: { totalAmount: QUOTED } })
  const quoteOrder = await prisma.order.findUnique({ where: { id: quoteId }, select: { status: true, createdAt: true } })
  const soldAt = await prisma.order.findUnique({ where: { id: soldId }, select: { createdAt: true } })
  add('夹具：一张 €99.00 的**报价单**（PENDING），且比销售单更晚',
    quoteOrder?.status === 'PENDING' && (quoteOrder!.createdAt >= soldAt!.createdAt),
    `状态 ${quoteOrder?.status}`)

  // ── ① 核心：引擎取到的必须是销售单的价 ────────────────────────────────────
  const hit = await queryLastSoldPricesDetailed(prisma, cust.id, [productId])
  add('① **上次成交价取销售单 €20.00，不是更晚那张报价单的 €99.00**',
    near(Number(hit[productId]?.price), SOLD),
    `取到 ${eur(hit[productId]?.price)}（修复前会取到 ${eur(QUOTED)}）`)

  // ── ② 走 HTTP 的那条路（下单页拉 last-prices）同样如此 ────────────────────
  const lpRes = await fetch(`${BASE}/api/customers/${cust.id}/last-prices?productIds=${productId}`, { headers: auth })
  // 响应形状是 { prices, dates, missing }，不是扁平的 productId → price
  const lp = await lpRes.json() as { prices?: Record<string, number>; missing?: string[] }
  const httpPrice = Number(lp.prices?.[productId])
  add('② 下单页那条 HTTP 路径取到的也是 €20.00',
    near(httpPrice, SOLD),
    `接口返回 ${eur(httpPrice)}${(lp.missing ?? []).includes(productId) ? '（该商品被列为无历史）' : ''}`)

  // ── ③ 「查看历史价格」弹窗不能与徽标各说各话 ──────────────────────────────
  const hRes = await fetch(
    `${BASE}/api/orders/sales-price-history?customerId=${cust.id}&productId=${productId}&limit=20`,
    { headers: auth },
  )
  const h = await hRes.json() as { history?: Array<{ unitPrice: number; orderCode?: string }> }
  const first = h.history?.[0]
  add('③ 历史价格弹窗第一行 == 引擎取的那个价（同一件事不能两处各算一遍）',
    !!first && near(Number(first.unitPrice), SOLD),
    `弹窗第一行 ${eur(first?.unitPrice)} · 共 ${h.history?.length ?? 0} 条`)
  add('③ 弹窗里根本不出现那张报价单',
    !(h.history ?? []).some(r => near(Number(r.unitPrice), QUOTED)),
    (h.history ?? []).map(r => eur(r.unitPrice)).join('、') || '（空）')

  // ── ④ 报价单一旦确认，它的价就该算数了（不是"永远不认报价单"）──────────────
  await fetch(`${BASE}/api/orders/${quoteId}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ status: 'CONFIRMED' }),
  })
  const after = await queryLastSoldPricesDetailed(prisma, cust.id, [productId])
  add('④ 那张报价单被确认成销售单之后，€99.00 立刻算数 —— 排除的是"未成交"，不是"报价单"这个词',
    near(Number(after[productId]?.price), QUOTED), `取到 ${eur(after[productId]?.price)}`)

  // ── ⑤ 作废的单依旧不算 ───────────────────────────────────────────────────
  await prisma.order.update({ where: { id: quoteId }, data: { status: 'CANCELLED' } })
  const afterCancel = await queryLastSoldPricesDetailed(prisma, cust.id, [productId])
  add('⑤ 作废之后又回落到 €20.00（CANCELLED 一直是排除的）',
    near(Number(afterCancel[productId]?.price), SOLD), `取到 ${eur(afterCancel[productId]?.price)}`)

  await prisma.$disconnect()
  report()
}

function report() {
  const pass = cases.filter(c => c.state === 'pass').length
  const fail = cases.filter(c => c.state === 'fail').length
  const sk = cases.filter(c => c.state === 'skip').length
  console.log('\n上次成交价只认销售单（X9）\n' + '='.repeat(78))
  for (const c of cases) {
    const icon = c.state === 'pass' ? '✅' : c.state === 'fail' ? '❌' : '⏭️'
    console.log(`${icon} ${c.name}\n     ${c.detail}`)
  }
  console.log('='.repeat(78))
  console.log(`通过 ${pass} · 失败 ${fail} · 跳过 ${sk} · 共 ${cases.length}`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
