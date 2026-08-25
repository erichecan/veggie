/**
 * 大小单位全链路实测：采购入库 → 库存 → 销售出库 → 拣货打印
 * ============================================================================
 * 台账 I3。对应需求原话：「商品信息管理：已经看到了大小单位的套用，但是需要
 * 实际去测试一下」。
 *
 * 用现成的 `CASE = 12 × PCS` 造一个「箱 = 12 包」的商品，逐环节断言换算：
 *
 *   采购 5 箱  → 库存应 +60 包（不是 +5）
 *   销售 2 箱  → 库存应 -24 包（不是 -2）
 *   拣货单     → 数量与单位必须能让仓库看懂拣多少
 *   全程守恒   → qtyOnHand == Σ StockMove
 *
 * 换算口径来自 `lib/inventory.ts: toStockQty`：`qty × (行单位factor / 基准单位factor)`。
 * 关键在于**每一个写库存的环节都必须调它**——漏掉一处，那一处就按原始数字进出，
 * 而库存表面上仍是一个数，不会报错。
 *
 * ⛔ 会写库。只允许打向本机 veggie_test。
 *
 * 用法：npx tsx --env-file=.env.test scripts/audit/uom-chain-test.ts
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
// 口令收口在 _seed-credentials.ts —— 此前 26 个脚本各写一遍字面量，改一个账号要改 26 处
import { seedPassword } from './_seed-credentials'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()
const num = (v: unknown) => Number(v ?? 0)

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR, password: seedPassword(OPERATOR) }),
  })
  const j = await r.json() as { token?: string; error?: string }
  if (!j.token) throw new Error(`登录失败：${j.error ?? ''}`)
  return j.token
}

async function stock(productId: string) {
  const [p, moves] = await Promise.all([
    prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { qtyOnHand: true } }),
    prisma.stockMove.findMany({ where: { productId }, select: { qty: true } }),
  ])
  return { qty: num(p.qtyOnHand), moveSum: moves.reduce((s, m) => s + num(m.qty), 0) }
}

async function main() {
  const url = process.env.DATABASE_URL ?? ''
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }
  const token = await login()
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  // ── 准备：基准单位 PCS(1) + 大单位 CASE(12) ─────────────────────────────
  const pcs = await prisma.uom.findUnique({ where: { id: 'uom_pcs' }, select: { id: true, factor: true } })
  const box = await prisma.uom.findUnique({ where: { id: 'uom_case' }, select: { id: true, factor: true } })
  if (!pcs || !box) { skip('准备单位', '库中缺 uom_pcs / uom_case'); report(); return }
  const FACTOR = num(box.factor) / num(pcs.factor)
  add('单位换算关系', FACTOR === 12, `CASE factor ${num(box.factor)} / PCS factor ${num(pcs.factor)} = ${FACTOR}（应为 12）`)

  // 找一个基准单位为 PCS 的在售商品；库里没有就现造一个。
  // ⚠️ 实测：测试库 1677 个商品模板**全部没挂计量单位**（uomId 为 NULL），
  // 生产库同样需要核对。没有基准单位，toStockQty 会原样返回数量 —— 也就是说
  // 「大小单位」这套机制在当前数据下**根本没有生效的前提**。
  let product = await prisma.product.findFirst({
    where: { uomId: pcs.id, active: true },
    select: { id: true, name: true },
  })
  if (!product) {
    add('库中存在基准单位规范的商品', false,
      '⛔ 一个都没有 —— 全部商品 uomId 为空，大小单位机制没有生效前提。本测试改用现造商品继续验证链路')
    product = await prisma.product.create({
      data: {
        name: `I3 单位测试商品 ${Date.now()}`, type: 'PRODUCT', status: 'ACTIVE',
        listPrice: 10, standardPrice: 6, uomId: pcs.id, canBeSold: true, canBePurchased: true,
        qtyOnHand: 0, active: true,
      },
      select: { id: true, name: true },
    })
  } else {
    add('库中存在基准单位规范的商品', true, `${product.name}`)
  }
  const pid = product.id
  const pname = product.name

  const supplier = await prisma.customer.findFirst({ where: { isVendor: true }, select: { id: true } })
  // 挑一个不会被信用冻结拦住的客户：无逾期欠款、信用额度充足。
  // 否则销售侧会因「客户信用冻结」建单失败，测不到单位换算本身。
  const customer = await prisma.customer.findFirst({
    where: { isCustomer: true, isActive: true, creditLimit: { gte: 5000 } },
    select: { id: true },
  }) ?? await prisma.customer.findFirst({ where: { isCustomer: true }, select: { id: true } })
  if (!supplier || !customer) { skip('准备往来单位', '缺供应商或客户'); report(); return }

  console.log(`测试商品：${pname}（${pid}）· 基准单位 PCS · 采购/销售用 CASE（1 箱 = ${FACTOR} 包）`)

  // ── 环节 1：采购 5 箱 → 库存应 +60 ──────────────────────────────────────
  const before1 = await stock(pid)
  const po = await prisma.purchaseOrder.create({
    data: {
      name: `I3-PO-${Date.now()}`, supplierId: supplier.id, status: 'CONFIRMED',
      orderDate: new Date(), expectedDate: new Date(),
      subtotalExTax: 100, totalTax: 0, totalIncTax: 100,
      lines: {
        create: [{
          productId: pid, productName: pname,
          uomId: box.id,            // ← 采购单位是「箱」
          orderedQty: 5, receivedQty: 0,
          unitCost: 20, taxRate: 0,
          subtotalExTax: 100, taxAmount: 0, subtotalIncTax: 100,
        }],
      },
    },
    select: { id: true },
  })
  const recv = await fetch(`${BASE}/api/goods-receipts`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      purchaseOrderId: po.id, arrivedAt: new Date().toISOString(),
      lines: [{ productId: pid, qty: 5, uomId: box.id, condition: 'ok' }],
    }),
  })
  const after1 = await stock(pid)
  const recvDelta = after1.qty - before1.qty
  add('采购收货 5 箱 → 库存 +60 包', recvDelta === 5 * FACTOR,
    `HTTP ${recv.status} · 库存 +${recvDelta}（应为 ${5 * FACTOR}；若为 5 则收货未做单位换算）`)

  // ── 环节 2：销售 2 箱 → 库存应 -24 ──────────────────────────────────────
  const before2 = await stock(pid)
  const ordRes = await fetch(`${BASE}/api/orders`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      restaurantId: customer.id,
      items: [{ productId: pid, quantity: 2, uomId: box.id }],
    }),
  })
  const ord = await ordRes.json() as { id?: string; code?: string; error?: string }
  if (!ord.id) {
    skip('销售出库 2 箱', `建单失败：${ord.error ?? ordRes.status}`)
  } else {
    // 确认订单才扣库存（本系统在确认时扣）
    const conf = await fetch(`${BASE}/api/orders/${ord.id}`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ status: 'CONFIRMED' }),
    })
    const after2 = await stock(pid)
    const saleDelta = before2.qty - after2.qty
    add('销售确认 2 箱 → 库存 -24 包', saleDelta === 2 * FACTOR,
      `HTTP ${conf.status} · 库存 -${saleDelta}（应为 ${2 * FACTOR}；若为 2 则出库未做单位换算）`)

    // ── 环节 3：拣货打印看到的数量与单位 ────────────────────────────────
    const line = await prisma.orderLine.findFirst({
      where: { orderId: ord.id }, select: { orderedQty: true, uomId: true, uomName: true },
    })
    add('订单行保留下单单位', line?.uomId === box.id && num(line?.orderedQty) === 2,
      `落库 ${num(line?.orderedQty)} ${line?.uomName ?? '(无单位名)'}（应为 2 CASE —— 单据按下单单位显示，换算只发生在库存侧）`)
    add('拣货单位名可读', !!line?.uomName,
      `uomName = ${line?.uomName ?? 'NULL'}（为空则仓库看不出拣 2 箱还是 2 包）`)
  }

  // ── 环节 4：全程守恒 ────────────────────────────────────────────────────
  const fin = await stock(pid)
  add('该商品守恒 qtyOnHand == Σ流水', Math.abs(fin.qty - fin.moveSum) < 0.001,
    `qtyOnHand=${fin.qty} vs Σ流水=${fin.moveSum}`)

  const bad = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(`
    SELECT COUNT(*)::bigint AS c FROM "Product" p
    LEFT JOIN (SELECT "productId", SUM(qty) AS s FROM "StockMove" GROUP BY 1) m ON m."productId" = p.id
    WHERE ABS(p."qtyOnHand" - COALESCE(m.s, 0)) > 0.001`)
  add('全库守恒', Number(bad[0]?.c ?? 0) === 0, `不守恒商品数 ${Number(bad[0]?.c ?? 0)}`)

  await prisma.$disconnect()
  report()
}

function report() {
  console.log('\n──── 大小单位全链路 ────')
  for (const c of cases) {
    const icon = c.state === 'pass' ? '✅' : c.state === 'fail' ? '❌' : '⚠️ '
    console.log(`  ${icon} ${c.name.padEnd(30)} ${c.detail}`)
  }
  const failed = cases.filter(c => c.state === 'fail')
  const skipped = cases.filter(c => c.state === 'skip')
  console.log(`\n合计 ${cases.length} 例 · 通过 ${cases.length - failed.length - skipped.length} · 失败 ${failed.length} · ⚠️ 未获验证 ${skipped.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
