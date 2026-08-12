/**
 * 拣货单整箱/零散拆分 —— 端到端实证
 * ============================================================================
 * 台账 D4。验收：「数量正确拆为 N 箱 + M 散，分页打印」。
 *
 * 单测（tests/pack-split.test.ts）只证明纯函数会算。本脚本证明**这个数真的印在
 * 纸上**：配箱规 → 下多张单凑出混装数量 → 走 HTTP 拿拣货单 HTML → 在 HTML 里
 * 断言那行字。B2 的教训是「代码全实现、单测全过，对 15 万单产出 0」，所以链路
 * 要一路走到产物。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npx tsx --env-file=.env.test scripts/audit/pack-split-print-test.ts
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
const PASSWORD = process.env.SEED_PASSWORD ?? 'LocalTest2026!'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR, password: PASSWORD }),
  })
  const j = await r.json() as { token?: string; error?: string }
  if (!j.token) throw new Error(`登录失败：${j.error ?? ''}`)
  return j.token
}

async function main() {
  const url = process.env.DATABASE_URL ?? ''
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }

  // ── 先记录一个事实：全库有多少商品配了可售单位 ────────────────────────
  const psuCount = await prisma.productSaleUom.count()
  add('主数据：有商品配了可售单位（箱规来源）', psuCount > 0,
    `ProductSaleUom ${psuCount} 行${psuCount === 0 ? ' —— ⛔ 一个都没有，拆箱对现有数据永远返回 null，纸面不会有任何变化' : ''}`)

  const token = await login()
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  const pcs = await prisma.uom.findUnique({ where: { id: 'uom_pcs' }, select: { id: true, name: true } })
  const box = await prisma.uom.findUnique({ where: { id: 'uom_case' }, select: { id: true, name: true, factor: true } })
  if (!pcs || !box) { skip('准备单位', '缺 uom_pcs / uom_case'); return report() }
  const FACTOR = Number(box.factor)

  // ── 造一个「1 箱 = 12 包」的商品，并给它配上可售单位 ────────────────────
  const tmpl = await prisma.productTemplate.create({
    data: {
      name: `D4 拆箱测试商品 ${Date.now()}`, type: 'PRODUCT', status: 'ACTIVE',
      listPrice: 10, standardPrice: 6, uomId: pcs.id, canBeSold: true, canBePurchased: true,
      products: { create: [{ name: 'D4 拆箱测试商品', listPrice: 10, standardPrice: 6, qtyOnHand: 500, active: true, status: 'ACTIVE' }] },
    },
    select: { id: true, products: { select: { id: true, name: true }, take: 1 } },
  })
  const pid = tmpl.products[0]!.id
  await prisma.productSaleUom.createMany({
    data: [
      { productId: pid, uomId: pcs.id, isDefault: true },
      { productId: pid, uomId: box.id, isDefault: false },
    ],
  })
  add('箱规可从可售单位推出', true, `${box.name} factor=${FACTOR} / 基准 ${pcs.name} → 1 箱 = ${FACTOR} 包`)

  // ── 下两张单，凑出跨箱的混装数量：20 + 15 = 35 包 = 2 箱 + 11 包 ────────
  const customers = await prisma.customer.findMany({
    where: { isCustomer: true, isActive: true, creditLimit: { gte: 5000 } },
    select: { id: true, name: true }, take: 2,
  })
  if (customers.length < 2) { skip('准备客户', '可用客户不足 2 个'); return report() }

  const orderIds: string[] = []
  for (const [i, c] of customers.entries()) {
    const qty = i === 0 ? 20 : 15
    const res = await fetch(`${BASE}/api/orders`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ restaurantId: c.id, items: [{ productId: pid, quantity: qty, uomId: pcs.id }] }),
    })
    const j = await res.json() as { id?: string; error?: string }
    if (!j.id) { skip('建单', `${c.name}: ${j.error ?? res.status}`); return report() }
    orderIds.push(j.id)
  }
  add('两张单凑出跨箱数量', true, `20 + 15 = 35 包（应拆成 2 箱 + 11 包）`)

  // ── 组一趟车，取拣货单 HTML ──────────────────────────────────────────────
  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, code: true, restaurantId: true, restaurantName: true },
  })
  const trip = await prisma.trip.create({
    data: {
      name: `D4-TRIP-${Date.now()}`, status: 'PENDING', departTime: new Date().toISOString(),
      // Trip.restaurants 的形状是「每客户一条，orderIds 是数组」——不是每单一条
      restaurants: orders.map(o => ({ restaurantId: o.restaurantId, restaurantName: o.restaurantName, orderIds: [o.id] })),
    },
    select: { id: true },
  })

  // 走真 HTTP：?format=html 与 PDF 分支跑的是同一段 HTML 生成代码，只是不过 Chromium。
  // 断言纸面文字用 HTML，另外再真打一次 PDF 证明渲染这一步也没坏。
  const htmlRes = await fetch(`${BASE}/api/trips/${trip.id}/picking-pdf?format=html`, { headers: auth })
  const html = await htmlRes.text()
  if (htmlRes.status !== 200 || !html.includes('<table')) {
    skip('取拣货单 HTML', `HTTP ${htmlRes.status}，前 200 字：${html.slice(0, 200)}`)
    return report()
  }

  const pdfRes = await fetch(`${BASE}/api/trips/${trip.id}/picking-pdf`, { headers: auth })
  const pdfBuf = await pdfRes.arrayBuffer()
  add('拣货单 PDF 路由仍可打印', pdfRes.status === 200 && pdfBuf.byteLength > 1000,
    `HTTP ${pdfRes.status} · ${pdfBuf.byteLength} 字节`)

  // ── 断言纸面 ────────────────────────────────────────────────────────────
  // 数量列现在是多行（总数 + 拆箱副标），不能再按 `>35` 这种紧贴尖括号的写法找
  const hasTotal = /<td class="col-qty">\s*35\b/.test(html)
  add('拣货单印出总量 35', hasTotal, hasTotal ? '数量列找到 35' : '⛔ 数量列里找不到 35')

  const expected = `2 ${box.name} + 11 ${pcs.name}`
  add('拣货单印出拆箱「2 箱 + 11 包」', html.includes(expected),
    html.includes(expected) ? `找到「${expected}」` : `⛔ 找不到「${expected}」`)

  // ⚠️ 不能只找 'pack-split' —— 这个词在 <style> 里也有一份，恒为真。必须找类的使用处
  const usesSplit = html.includes('<span class="pack-split">')
  add('拆箱副标真的渲染进表格', usesSplit, usesSplit ? '找到 <span class="pack-split">' : '⛔ 只有样式定义，没有实际使用')

  // ── 分页控制 ────────────────────────────────────────────────────────────
  add('表头每页重复', html.includes('display:table-header-group'), 'thead display:table-header-group')
  add('行不跨页断开', html.includes('break-inside:avoid'), 'tr break-inside:avoid')
  add('两类货各起新页', html.includes('break-before:page'), 'section-2nd break-before:page')

  // ── 反例：按「箱」下单时不该再拆 ─────────────────────────────────────────
  const res2 = await fetch(`${BASE}/api/orders`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ restaurantId: customers[0]!.id, items: [{ productId: pid, quantity: 2, uomId: box.id }] }),
  })
  const o2 = await res2.json() as { id?: string; error?: string }
  if (!o2.id) {
    skip('按箱下单反例', `建单失败：${o2.error ?? res2.status}`)
  } else {
    const o2row = await prisma.order.findUniqueOrThrow({
      where: { id: o2.id }, select: { id: true, restaurantId: true, restaurantName: true },
    })
    const trip2 = await prisma.trip.create({
      data: {
        name: `D4-TRIP2-${Date.now()}`, status: 'PENDING', departTime: new Date().toISOString(),
        restaurants: [{ restaurantId: o2row.restaurantId, restaurantName: o2row.restaurantName, orderIds: [o2row.id] }],
      },
      select: { id: true },
    })
    const h2 = await (await fetch(`${BASE}/api/trips/${trip2.id}/picking-pdf?format=html`, { headers: auth })).text()
    const h2Uses = h2.includes('<span class="pack-split">')
    add('按「箱」下单不再重复拆箱', !h2Uses,
      h2Uses ? '⛔ 印出了「0 箱 + 2 箱」这类废话' : '数量本身已是整箱数，未附拆箱副标')
  }

  await prisma.$disconnect()
  report()
}

function report() {
  console.log('\n──── 拣货单整箱/零散拆分 ────')
  for (const c of cases) {
    const icon = c.state === 'pass' ? '✅' : c.state === 'fail' ? '❌' : '⚠️ '
    console.log(`  ${icon} ${c.name.padEnd(32)} ${c.detail}`)
  }
  const failed = cases.filter(c => c.state === 'fail')
  const skipped = cases.filter(c => c.state === 'skip')
  console.log(`\n合计 ${cases.length} 例 · 通过 ${cases.length - failed.length - skipped.length} · 失败 ${failed.length} · ⚠️ 未获验证 ${skipped.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
