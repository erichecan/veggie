/**
 * 财务当日确认货款 + 历史欠款冲抵（台账 C9）—— 端到端实证
 * ============================================================================
 * 验收三条：① 确认动作有独立权限 ② 确认后司机不可改
 *          ③ 超收部分能冲抵到客户欠款并留痕
 *
 * ③ 是本条的核心。老实现把「收的钱比今天的货多」一律丢进 unallocated 让财务
 * 手工处理 —— 而这恰恰是最常见的情况：司机去送今天的货，顺手把上周的欠款收回来。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:finance-confirm
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { ensureOpeningStock } from '../../prisma/seed-events/inventory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const PASSWORD = process.env.SEED_PASSWORD ?? 'LocalTest2026!'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
const FINANCE = process.env.FINANCE_EMAIL ?? 'finance@veggie.com'
const DRIVER = process.env.DRIVER_EMAIL ?? 'driver@veggie.com'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()
const eur = (n: unknown) => `€${Number(n ?? 0).toFixed(2)}`
const ymd = (d: Date) => d.toISOString().slice(0, 10)

async function login(email: string): Promise<string | null> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const j = await r.json() as { token?: string }
  return j.token ?? null
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? ''
  if (!/localhost|127\.0\.0\.1/.test(dbUrl)) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }

  const opToken = await login(OPERATOR)
  if (!opToken) { skip('登录', '运营账号登录失败（限流？）'); return report() }
  const auth: Record<string, string> = { Authorization: `Bearer ${opToken}`, 'Content-Type': 'application/json' }
  const finToken = await login(FINANCE)
  if (!finToken) { skip('财务登录', '登录失败（限流？）'); return report() }
  const finAuth: Record<string, string> = { Authorization: `Bearer ${finToken}`, 'Content-Type': 'application/json' }
  const drvToken = await login(DRIVER)
  if (!drvToken) { skip('司机登录', '登录失败（限流？）'); return report() }
  const drvAuth: Record<string, string> = { Authorization: `Bearer ${drvToken}`, 'Content-Type': 'application/json' }

  const stamp = Date.now()
  const driver = await prisma.user.findUnique({ where: { email: DRIVER }, select: { id: true, name: true } })
  if (!driver) { skip('司机账号', `${DRIVER} 不存在`); return report() }

  // ── 夹具：一个客户，一张**历史欠款**发票 + 今天一单 ───────────────────────
  const cust = await prisma.customer.create({
    data: { name: `C9 客户 ${stamp}`, isActive: true, paymentTerm: 'cash' },
    select: { id: true, name: true },
  })
  const pname = `C9 商品 ${stamp}`
  const tmpl = await prisma.productTemplate.create({
    data: {
      name: pname, type: 'PRODUCT', status: 'ACTIVE', listPrice: 10, standardPrice: 4,
      uomId: 'uom_pcs', canBeSold: true,
      products: { create: [{ name: pname, listPrice: 10, standardPrice: 4, qtyOnHand: 0, active: true, status: 'ACTIVE' }] },
    },
    select: { products: { select: { id: true }, take: 1 } },
  })
  const productId = tmpl.products[0]!.id
  // 库存连流水一起造 —— 直接塞 qtyOnHand 会破坏 db:validate 的头号不变量。
  // 这已经是第三次踩（周期 25/26 库存、H3 提成、C7 路线各一次）：
  // 夹具自己不守恒，测出来的就不是产品的问题。
  await ensureOpeningStock(prisma, {
    target: 500, backdate: new Date('2026-08-05T00:00:00Z'), productIds: [productId],
  })

  // 上个月的旧账：一张 POSTED 未结清发票 €400
  const oldInvoice = await fetch(`${BASE}/api/invoices`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      name: `C9-OLD-${stamp}`, customerId: cust.id, customerName: cust.name,
      saleOrderIds: [], status: 'POSTED', paymentTerms: 'cash',
      dueDate: ymd(new Date(Date.now() - 30 * 86400_000)),
      lines: [{ productId, productName: pname, qty: 40, unitPrice: 10, taxRate: 0 }],
    }),
  })
  const oldInv = await oldInvoice.json() as { id?: string; name?: string; amountDue?: number; error?: string }
  if (!oldInv.id) { skip('夹具历史发票', `HTTP ${oldInvoice.status} ${oldInv.error ?? ''}`); return report() }
  add('夹具：客户有一张 €400 的历史欠款发票', Number(oldInv.amountDue) === 400,
    `${oldInv.name} 应收 ${eur(oldInv.amountDue)}`)

  // 今天这一单 €100，开 POSTED 发票
  const orderRes = await fetch(`${BASE}/api/orders`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      restaurantId: cust.id, restaurantName: cust.name, deliveryDate: ymd(new Date()),
      items: [{ productId, quantity: 10, unitPrice: 10 }],
    }),
  })
  const order = await orderRes.json() as { id?: string }
  if (!order.id) { skip('夹具建单', `HTTP ${orderRes.status}`); return report() }
  await fetch(`${BASE}/api/orders/${order.id}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ status: 'CONFIRMED' }),
  })
  const todayInvRes = await fetch(`${BASE}/api/invoices`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      name: `C9-TODAY-${stamp}`, customerId: cust.id, customerName: cust.name,
      saleOrderIds: [order.id], status: 'POSTED', paymentTerms: 'cash',
      lines: [{ productId, productName: pname, qty: 10, unitPrice: 10, taxRate: 0 }],
    }),
  })
  const todayInv = await todayInvRes.json() as { id?: string; name?: string; amountDue?: number }

  // 司机跑这一趟，现场收了 €300 —— 今天的货只值 €100，多的 €200 是收回的旧账
  const trip = await prisma.trip.create({
    data: {
      name: `C9 行程 ${stamp}`, driverId: driver.id, driverName: driver.name,
      status: 'COMPLETED', totalPayment: 100, settlementStatus: 'pending',
      restaurants: [{
        restaurantId: cust.id, restaurantName: cust.name,
        orderIds: [order.id], payment: 300, delivered: true, items: [], returns: [], pods: [],
      }] as never,
    },
    select: { id: true },
  })

  // ── ① 司机提交交账 ────────────────────────────────────────────────────────
  const submit = await fetch(`${BASE}/api/trips/${trip.id}/settlement`, {
    method: 'POST', headers: drvAuth,
    body: JSON.stringify({ cashCollected: 300, onlineCollected: 0, settlementNote: 'C9 含旧账' }),
  })
  add('① 司机提交交账（现金 €300，今天的货只有 €100）', submit.ok, `HTTP ${submit.status}`)

  // ── ② 确认动作有独立权限：司机不能确认自己的账 ────────────────────────────
  const selfConfirm = await fetch(`${BASE}/api/trips/${trip.id}/settlement`, {
    method: 'PUT', headers: drvAuth, body: JSON.stringify({ confirmed: true }),
  })
  add('② 司机确认不了自己交的账 → 403（职责分离）', selfConfirm.status === 403, `HTTP ${selfConfirm.status}`)

  // ── ③ 财务确认 → 超收部分冲抵历史欠款 ─────────────────────────────────────
  const confirm = await fetch(`${BASE}/api/trips/${trip.id}/settlement`, {
    method: 'PUT', headers: finAuth, body: JSON.stringify({ confirmed: true }),
  })
  const confirmBody = await confirm.json().catch(() => ({})) as {
    settlementPosting?: {
      created?: number; totalAllocated?: number; historicalDebtRecovered?: number
      historicalDebtInvoices?: Array<{ name: string; amount: number }>
      unallocated?: Array<{ amount: number }>
    }
  }
  const post = confirmBody.settlementPosting
  add('③ 财务确认交账成功', confirm.ok, `HTTP ${confirm.status}`)
  add('③ €300 全部入账（€100 当日 + €200 历史欠款），没有剩下"无法分配"的部分',
    (post?.totalAllocated ?? 0) === 300 && (post?.unallocated ?? []).length === 0,
    `已核销 ${eur(post?.totalAllocated)} · 未分配 ${(post?.unallocated ?? []).length} 笔`)
  add('③ **超出当日订单额的 €200 被标记为历史欠款回收**',
    (post?.historicalDebtRecovered ?? 0) === 200,
    `历史欠款回收 ${eur(post?.historicalDebtRecovered)}`)
  add('③ 报出冲抵了哪一张历史发票（财务可核对）',
    (post?.historicalDebtInvoices ?? []).some(i => i.name === oldInv.name && i.amount === 200),
    (post?.historicalDebtInvoices ?? []).map(i => `${i.name} ${eur(i.amount)}`).join('、') || '（空）')

  // 留痕：Payment 备注里要写明这是历史欠款回收
  const payments = await prisma.payment.findMany({
    where: { customerId: cust.id },
    select: { amount: true, note: true, invoiceId: true },
  })
  const histPayment = payments.find(p => Number(p.amount) === 200)
  add('③ 留痕：Payment 备注写明「历史欠款回收」并带上发票号',
    !!histPayment && /历史欠款回收/.test(histPayment.note ?? '') && (histPayment.note ?? '').includes(oldInv.name!),
    histPayment?.note ?? '（没找到那笔 €200）')

  // 两张发票的余额都要对
  const oldAfter = await prisma.invoice.findUnique({ where: { id: oldInv.id }, select: { amountDue: true, amountPaid: true, status: true } })
  const todayAfter = await prisma.invoice.findUnique({ where: { id: todayInv.id! }, select: { amountDue: true, status: true } })
  add('③ 历史发票余额从 €400 降到 €200',
    Number(oldAfter?.amountDue) === 200 && Number(oldAfter?.amountPaid) === 200,
    `应收 ${eur(oldAfter?.amountDue)} · 已付 ${eur(oldAfter?.amountPaid)} · ${oldAfter?.status}`)
  add('③ 当日发票结清并转为 PAID',
    Number(todayAfter?.amountDue) === 0 && todayAfter?.status === 'PAID',
    `应收 ${eur(todayAfter?.amountDue)} · ${todayAfter?.status}`)

  // 幂等：重复确认不能再记一次钱
  const again = await fetch(`${BASE}/api/trips/${trip.id}/settlement`, {
    method: 'PUT', headers: finAuth, body: JSON.stringify({ confirmed: true }),
  })
  const paymentsAfter = await prisma.payment.count({ where: { customerId: cust.id } })
  add('③ 重复确认不会重复记账（幂等）',
    paymentsAfter === payments.length,
    `HTTP ${again.status} · 收款记录仍是 ${paymentsAfter} 条`)

  // ── ④ 日报的财务确认（接 C8）──────────────────────────────────────────────
  const day = ymd(new Date(Date.UTC(2018, 0, 1) + (stamp % 300) * 86400_000))
  const dr = await fetch(`${BASE}/api/driver-reports/daily`, {
    method: 'POST', headers: drvAuth,
    body: JSON.stringify({ date: day, cashCollected: 300, orderTotal: 100, returnCount: 0, exchangeCount: 0, note: '含旧账' }),
  })
  if (dr.status !== 201) {
    skip('④ 日报财务确认', `日报提交失败 HTTP ${dr.status}`)
  } else {
    const drvConfirm = await fetch(`${BASE}/api/driver-reports/daily`, {
      method: 'PUT', headers: drvAuth,
      body: JSON.stringify({ date: day, driverId: driver.id }),
    })
    add('④ 司机确认不了自己的日报 → 403（confirm 是独立权限）',
      drvConfirm.status === 403, `HTTP ${drvConfirm.status}`)

    const finConfirm = await fetch(`${BASE}/api/driver-reports/daily`, {
      method: 'PUT', headers: finAuth,
      body: JSON.stringify({ date: day, driverId: driver.id, note: '已点清现金' }),
    })
    const fcBody = await finConfirm.json() as { report?: { status: string; confirmedByName: string; note: string } }
    add('④ 财务确认日报 → status 转 confirmed 并记下确认人',
      finConfirm.ok && fcBody.report?.status === 'confirmed' && !!fcBody.report?.confirmedByName,
      `HTTP ${finConfirm.status} · ${fcBody.report?.status} by ${fcBody.report?.confirmedByName ?? '?'}`)
    add('④ 财务备注**追加**而不是覆盖司机写的那条',
      (fcBody.report?.note ?? '').includes('含旧账') && (fcBody.report?.note ?? '').includes('已点清现金'),
      fcBody.report?.note ?? '（空）')

    const twice = await fetch(`${BASE}/api/driver-reports/daily`, {
      method: 'PUT', headers: finAuth, body: JSON.stringify({ date: day, driverId: driver.id }),
    })
    add('④ 重复确认 → 409（两个财务各点一次会留下互相矛盾的痕迹）',
      twice.status === 409, `HTTP ${twice.status}`)

    const drvResubmit = await fetch(`${BASE}/api/driver-reports/daily`, {
      method: 'POST', headers: drvAuth,
      body: JSON.stringify({ date: day, cashCollected: 1, orderTotal: 1, returnCount: 0, exchangeCount: 0 }),
    })
    add('② 确认之后司机改不了（重新提交 409）', drvResubmit.status === 409, `HTTP ${drvResubmit.status}`)
  }

  const notFound = await fetch(`${BASE}/api/driver-reports/daily`, {
    method: 'PUT', headers: finAuth,
    body: JSON.stringify({ date: '2017-03-03', driverId: driver.id }),
  })
  add('④ 确认一份不存在的日报 → 404（不是凭空建一条）', notFound.status === 404, `HTTP ${notFound.status}`)

  await prisma.$disconnect()
  report()
}

function report() {
  const pass = cases.filter(c => c.state === 'pass').length
  const fail = cases.filter(c => c.state === 'fail').length
  const sk = cases.filter(c => c.state === 'skip').length
  console.log('\n财务当日确认货款 · 历史欠款冲抵\n' + '='.repeat(78))
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
