/**
 * 端到端验证：餐厅门户下单 → 后台 Quotation 列表页看得到、认得出、对得上
 * ============================================================================
 * 台账 A3。对应需求原话：
 *   「订单提交后，需要能够形成一个 quotation，并在 quotation 列表页里显示出来
 *     （这是由餐厅自己提交上来的）」
 *
 * 走的是**真实 HTTP 接口**，不是直接调 Prisma —— 直接写库能证明的只是「数据能
 * 长成这样」，证明不了「用户那样操作时系统真的这么做」。本项目已经吃过这个亏：
 * 提成代码 Stage1-8 全实现、单测全过，对 15 万张真实订单却产出 0（见 B2）。
 *
 * 断言四件事：
 *   1. 门户提交能成功建单，且状态为 PENDING（= 系统里 quotation 的定义）
 *   2. 该单出现在 quotation 列表页默认视图里（status=PENDING）
 *   3. 来源可识别为 PORTAL —— 这是「看得出是餐厅自己提交的」的落点
 *   4. 金额与行数与提交内容一致，且单价由服务端权威定价决定
 *
 * 用法（需先起服务）：
 *   BASE_URL=http://127.0.0.1:3002 npx tsx --env-file=.env.test \
 *     scripts/audit/verify-portal-to-quotation.ts
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3002'
const RESTAURANT = process.env.PORTAL_EMAIL ?? 'restaurant1@veggie.com'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
const PASSWORD = process.env.SEED_PASSWORD ?? 'LocalTest2026!'

const pass: string[] = []
const fail: string[] = []
const check = (ok: boolean, msg: string) => (ok ? pass : fail).push(msg)

async function login(email: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const j = await r.json() as { token?: string; error?: string; message?: string }
  if (!j.token) throw new Error(`登录失败 ${email}：${j.error ?? ''} ${j.message ?? ''}`)
  return j.token
}

async function main() {
  const prisma = createPrismaClient()

  // 挑两个有库存的商品，避免「测出来的是缺货」而不是「测出了流程」
  const products = await prisma.product.findMany({
    where: { qtyOnHand: { gt: 20 }, active: true },
    select: { id: true, name: true },
    take: 2,
  })
  if (products.length < 2) throw new Error('测试库里有库存的商品不足 2 个，先跑 npm run db:opening-stock')

  const items = [
    { productId: products[0].id, quantity: 3 },
    { productId: products[1].id, quantity: 5 },
  ]

  // ── 1. 门户提交 ───────────────────────────────────────────────────────────
  const portalToken = await login(RESTAURANT)
  const createRes = await fetch(`${BASE}/api/customer-portal/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${portalToken}` },
    body: JSON.stringify({ items }),
  })
  const created = await createRes.json() as { id?: string; code?: string; status?: string; error?: string }
  check(createRes.status === 201 && !!created.id, `门户提交建单成功（HTTP ${createRes.status} · ${created.code ?? created.error}）`)
  if (!created.id) {
    report(); process.exit(1)
  }
  check(created.status === 'PENDING', `新单状态为 PENDING（实际 ${created.status}）—— 系统里 quotation 就是 status=PENDING 的 Order`)

  // ── 2. 出现在 quotation 列表页默认视图 ────────────────────────────────────
  const opToken = await login(OPERATOR)
  const listRes = await fetch(`${BASE}/api/orders?status=PENDING&include_lines=false&limit=500`, {
    headers: { Authorization: `Bearer ${opToken}` },
  })
  const list = await listRes.json() as Array<Record<string, unknown>>
  const rows = Array.isArray(list) ? list : []
  const row = rows.find(r => r.id === created.id)
  check(!!row, `新单出现在 quotation 列表默认视图（共 ${rows.length} 条）`)

  // ── 3. 来源可识别 ────────────────────────────────────────────────────────
  check(row?.source === 'PORTAL', `列表里来源标为 PORTAL（实际 ${String(row?.source)}）—— 这是「看得出是餐厅自己提交的」的落点`)

  const filtered = await (await fetch(`${BASE}/api/orders?status=PENDING&source=PORTAL&include_lines=false&limit=500`, {
    headers: { Authorization: `Bearer ${opToken}` },
  })).json() as Array<Record<string, unknown>>
  check(
    Array.isArray(filtered) && filtered.some(r => r.id === created.id) && filtered.every(r => r.source === 'PORTAL'),
    `按来源筛选 PORTAL 能筛到本单，且结果里没有混入其他来源（${Array.isArray(filtered) ? filtered.length : '?'} 条）`,
  )

  // ── 4. 金额与行数对得上 ──────────────────────────────────────────────────
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: created.id },
    select: {
      totalAmount: true,
      lines: { select: { productId: true, orderedQty: true, unitPrice: true, subtotal: true } },
    },
  })
  check(order.lines.length === items.length, `订单行数与提交一致（提交 ${items.length} · 实际 ${order.lines.length}）`)

  const qtyOk = items.every(it => {
    const l = order.lines.find(x => x.productId === it.productId)
    return l && Number(l.orderedQty) === it.quantity
  })
  check(qtyOk, '每行数量与提交一致')

  const lineSum = order.lines.reduce((s, l) => s + Number(l.subtotal), 0)
  check(Math.abs(Number(order.totalAmount) - lineSum) < 0.02, `totalAmount == Σ行小计（${Number(order.totalAmount).toFixed(2)} vs ${lineSum.toFixed(2)}）`)

  const subtotalOk = order.lines.every(l =>
    Math.abs(Number(l.subtotal) - Number(l.unitPrice) * Number(l.orderedQty)) < 0.02)
  check(subtotalOk, '每行 subtotal == unitPrice × orderedQty')

  const priced = order.lines.every(l => Number(l.unitPrice) > 0)
  check(priced, '单价由服务端权威定价填充（非 0）')

  await prisma.$disconnect()
  report()
  if (fail.length > 0) process.exit(1)
}

function report() {
  console.log('\n──── A3 端到端验证 ────')
  for (const p of pass) console.log(`  ✅ ${p}`)
  for (const f of fail) console.log(`  ❌ ${f}`)
  console.log(fail.length === 0 ? '\n✅ 全部通过' : `\n❌ ${fail.length} 项失败`)
}

main().catch(e => { console.error(e); process.exit(1) })
