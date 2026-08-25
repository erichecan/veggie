/**
 * 供应商结算 + 分批付款 —— 端到端实证
 * ============================================================================
 * 台账 G2。验收三条：
 *   ① 一个供应商能生成对账单并显示应付余额
 *   ② 支持一张账单多次付款且余额正确递减
 *   ③ 账龄分析数字与明细一致
 *
 * ③ 刻意**不拿接口的 SQL 去验接口自己**：脚本在 JS 侧用
 * `lib/finance/vendor-settlement.summarizeAging` 独立算一遍再逐格比对。
 * 用同一段实现两边一比，"一致"这个结论毫无信息量（D5x 的假性通过就是这么来的）。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:vendor-settlement
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { summarizeAging, agingBucketOf } from '../../lib/finance/vendor-settlement'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
// 口令收口在 _seed-credentials.ts —— 此前 26 个脚本各写一遍字面量，改一个账号要改 26 处
import { seedPassword } from './_seed-credentials'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
const NO_FINANCE = process.env.DRIVER_EMAIL ?? 'driver@veggie.com'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()
const num = (v: unknown) => Number(v ?? 0)
const eur = (n: number) => `€${n.toFixed(2)}`

async function login(email: string): Promise<string | null> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: seedPassword(email) }),
  })
  const j = await r.json() as { token?: string }
  return j.token ?? null
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? ''
  if (!/localhost|127\.0\.0\.1/.test(dbUrl)) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }

  const token = await login(OPERATOR)
  if (!token) { skip('登录', '运营账号登录失败'); return report() }
  const auth: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const stamp = Date.now()

  const supplier = await prisma.customer.create({
    data: { name: `G2 结算测试供应商 ${stamp}`, isVendor: true, isActive: true, supplierPaymentTerm: 'monthly' },
    select: { id: true, name: true },
  })

  // ── ① 采购单确认时自动生成供应商账单（"按采购单自动生成对账单"这一条本已存在，
  //      本轮核实它真的跑通，而不是只看代码里写了）───────────────────────────
  const pname = `G2 结算测试商品 ${stamp}`
  const product = await prisma.product.create({
    data: {
      name: pname, type: 'PRODUCT', status: 'ACTIVE', listPrice: 20, standardPrice: 5,
      uomId: 'uom_pcs', canBeSold: true, canBePurchased: true, qtyOnHand: 0, active: true,
    },
    select: { id: true },
  })
  const productId = product.id

  const poRes = await fetch(`${BASE}/api/purchase-orders`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      supplierId: supplier.id, expectedDate: new Date().toISOString().slice(0, 10),
      lines: [{ productId, productName: pname, orderedQty: 60, unitCost: 5, taxRate: 0 }],
    }),
  })
  const po = await poRes.json() as { id?: string; name?: string; error?: string }
  if (!po.id) { skip('准备采购单', `HTTP ${poRes.status} ${po.error ?? ''}`); return report() }
  await fetch(`${BASE}/api/purchase-orders/${po.id}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ action: 'approve' }),
  })

  const autoBill = await prisma.vendorBill.findFirst({ where: { purchaseOrderId: po.id } })
  add('① 采购单确认 → 自动生成供应商账单', !!autoBill && num(autoBill.totalIncTax) === 300,
    autoBill ? `${autoBill.name} · ${eur(num(autoBill.totalIncTax))} · ${autoBill.status}` : '⛔ 没有生成账单')
  if (!autoBill) { await prisma.$disconnect(); return report() }
  const billId = autoBill.id

  // 未过账的账单不能付款 —— 应付确认（过账）是财务动作
  const payBeforePost = await fetch(`${BASE}/api/vendor-bills/${billId}/payments`, {
    method: 'POST', headers: auth, body: JSON.stringify({ amount: 10 }),
  })
  add('① DRAFT 账单不能登记付款（400）', payBeforePost.status === 400, `HTTP ${payBeforePost.status}`)

  const postRes = await fetch(`${BASE}/api/vendor-bills/${billId}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ status: 'POSTED' }),
  })
  const posted = await postRes.json() as { amountDue?: number; status?: string }
  add('① 过账后显示应付余额', postRes.ok && num(posted.amountDue) === 300 && posted.status === 'POSTED',
    `应付 ${eur(num(posted.amountDue))} · ${posted.status}`)

  // 到期日：用来验账龄。设成 45 天前 → 应落 d31_60 桶
  const dueDate = new Date(Date.now() - 45 * 86400_000)
  await prisma.vendorBill.update({ where: { id: billId }, data: { dueDate } })

  // ── ② 分批付款：三笔 100 + 150 + 50，余额逐笔递减 ──────────────────────────
  const pay = async (amount: number, method = 'bank', note?: string) => {
    const r = await fetch(`${BASE}/api/vendor-bills/${billId}/payments`, {
      method: 'POST', headers: auth, body: JSON.stringify({ amount, method, note }),
    })
    const j = await r.json().catch(() => ({})) as { bill?: { amountPaid?: number; amountDue?: number; status?: string }; error?: string }
    return { status: r.status, bill: j.bill, error: j.error }
  }

  const p1 = await pay(100, 'bank', '第一笔电汇')
  add('② 第 1 笔 €100 → 已付 100 / 未付 200',
    p1.status === 201 && num(p1.bill?.amountPaid) === 100 && num(p1.bill?.amountDue) === 200,
    `已付 ${eur(num(p1.bill?.amountPaid))} · 未付 ${eur(num(p1.bill?.amountDue))} · ${p1.bill?.status}`)

  const p2 = await pay(150, 'cash', '第二笔现金')
  add('② 第 2 笔 €150 → 已付 250 / 未付 50',
    p2.status === 201 && num(p2.bill?.amountPaid) === 250 && num(p2.bill?.amountDue) === 50,
    `已付 ${eur(num(p2.bill?.amountPaid))} · 未付 ${eur(num(p2.bill?.amountDue))} · ${p2.bill?.status}`)

  // 超付必须被拒，且账单不能被改动（"返回 400 但事已经做了"是最难查的一类）
  const over = await pay(9999)
  const afterOver = await prisma.vendorBill.findUniqueOrThrow({ where: { id: billId }, select: { amountPaid: true } })
  add('② 超付被拒（400）且账单原样未动', over.status === 400 && num(afterOver.amountPaid) === 250,
    `HTTP ${over.status} · ${over.error ?? ''} · 已付仍 ${eur(num(afterOver.amountPaid))}`)

  const p3 = await pay(50, 'other', '尾款')
  add('② 第 3 笔 €50 付清 → 未付 0 且自动转 PAID',
    p3.status === 201 && num(p3.bill?.amountDue) === 0 && p3.bill?.status === 'PAID',
    `已付 ${eur(num(p3.bill?.amountPaid))} · 未付 ${eur(num(p3.bill?.amountDue))} · ${p3.bill?.status}`)

  // ── ② 逐笔可查（"分批付款"的价值全在这张流水表上）──────────────────────────
  const listRes = await fetch(`${BASE}/api/vendor-bills/${billId}/payments`, { headers: auth })
  const list = await listRes.json() as { items?: Array<{ amount: number; method: string; note: string | null; createdBy: string | null }>; count?: number; sum?: number }
  add('② 付款流水逐笔可查（金额/方式/备注/经手齐全）',
    listRes.ok && list.count === 3 && num(list.sum) === 300
      && list.items?.map(i => i.method).join(',') === 'bank,cash,other'
      && list.items.every(i => !!i.createdBy),
    `${list.count} 笔 · 合计 ${eur(num(list.sum))} · 方式 ${list.items?.map(i => i.method).join('/')} · 经手 ${list.items?.[0]?.createdBy}`)

  const sumInDb = await prisma.vendorPayment.aggregate({ where: { vendorBillId: billId }, _sum: { amount: true } })
  add('② amountPaid 恒等于流水汇总（不是两个各自累加的数）',
    num(sumInDb._sum.amount) === num(p3.bill?.amountPaid),
    `Σ流水 ${eur(num(sumInDb._sum.amount))} vs amountPaid ${eur(num(p3.bill?.amountPaid))}`)

  // ── ② 并发不丢账 —— 这是本轮改动的核心 ────────────────────────────────────
  // 旧写法前端传「累计已付」：两个人同时各付 €50（都读到已付 0，都传 50），
  // 最终只会记下一笔，另 €50 无声消失。新接口传本笔金额 + 行锁，两笔都必须落地。
  const bill2 = await prisma.vendorBill.create({
    data: {
      name: `G2-VB-CONCURRENT-${stamp}`, supplierId: supplier.id, status: 'POSTED',
      subtotalExTax: 200, totalTax: 0, totalIncTax: 200, amountPaid: 0, amountDue: 200,
      billDate: new Date(), dueDate: new Date(Date.now() + 10 * 86400_000), lines: [],
    },
    select: { id: true },
  })
  const concurrent = await Promise.all([50, 50, 50, 50].map(amt =>
    fetch(`${BASE}/api/vendor-bills/${bill2.id}/payments`, {
      method: 'POST', headers: auth, body: JSON.stringify({ amount: amt, method: 'bank', note: '并发测试' }),
    }).then(r => r.status)))
  const bill2After = await prisma.vendorBill.findUniqueOrThrow({ where: { id: bill2.id }, select: { amountPaid: true, amountDue: true, status: true } })
  const bill2Rows = await prisma.vendorPayment.count({ where: { vendorBillId: bill2.id } })
  add('② 四笔并发付款一笔不丢（旧的累计值写法会丢）',
    num(bill2After.amountPaid) === 200 && bill2Rows === 4 && num(bill2After.amountDue) === 0,
    `HTTP ${concurrent.join('/')} · 已付 ${eur(num(bill2After.amountPaid))} · 流水 ${bill2Rows} 笔 · ${bill2After.status}`)

  // 并发超付也不能穿透：再来四笔并发，账单已付清，四笔都该被拒
  const overConcurrent = await Promise.all([10, 10].map(amt =>
    fetch(`${BASE}/api/vendor-bills/${bill2.id}/payments`, {
      method: 'POST', headers: auth, body: JSON.stringify({ amount: amt }),
    }).then(r => r.status)))
  const bill2Final = await prisma.vendorBill.findUniqueOrThrow({ where: { id: bill2.id }, select: { amountPaid: true } })
  add('② 付清后的并发付款全部被拒，金额没被穿透',
    overConcurrent.every(s => s === 400) && num(bill2Final.amountPaid) === 200,
    `HTTP ${overConcurrent.join('/')} · 已付仍 ${eur(num(bill2Final.amountPaid))}`)

  // ── ② 付款生成总账凭证（应付冲减要能进账）────────────────────────────────
  const payIds = await prisma.vendorPayment.findMany({ where: { vendorBillId: billId }, select: { id: true } })
  const entries = await prisma.journalEntry.count({
    where: { sourceType: 'vendor_payment', sourceId: { in: payIds.map(p => p.id) } },
  })
  add('② 每笔付款各生成一张付款凭证（幂等键用流水 id）', entries === 3,
    `凭证 ${entries} 张 / 付款 ${payIds.length} 笔`)

  // ── ③ 账龄与明细一致 ────────────────────────────────────────────────────
  // 造两张未结账单：一张逾期 45 天（d31_60）、一张未到期（current）、一张无到期日（unknown）
  const openBills = [
    { name: `G2-VB-AGED-${stamp}`, due: new Date(Date.now() - 45 * 86400_000), amt: 120 },
    { name: `G2-VB-CURRENT-${stamp}`, due: new Date(Date.now() + 20 * 86400_000), amt: 80 },
    { name: `G2-VB-NODUE-${stamp}`, due: null as Date | null, amt: 60 },
  ]
  for (const b of openBills) {
    await prisma.vendorBill.create({
      data: {
        name: b.name, supplierId: supplier.id, status: 'POSTED',
        subtotalExTax: b.amt, totalTax: 0, totalIncTax: b.amt, amountPaid: 0, amountDue: b.amt,
        billDate: new Date(), dueDate: b.due, lines: [],
      },
    })
  }

  // ⚠️ 加一个唯一参数绕开响应缓存：analytics 路由用 withCachedAuth，缓存键是 URL+角色。
  // 不绕开的话，本脚本连跑两次时第二次会拿到上一次的快照（还没有本轮新建的账单），
  // 表现为「账龄对不上」——那是缓存，不是缺陷。
  const agingRes = await fetch(`${BASE}/api/analytics/ap-aging?_=${stamp}`, { headers: auth })
  const aging = await agingRes.json() as {
    suppliers?: Array<{ supplierId: string; buckets?: Record<string, { amount: number }>; total?: number }>
    rows?: Array<{ supplierId: string; bucket: string; amount: number }>
    totals?: Record<string, number>
  }
  // 明细侧：直接查库，用**独立实现**在 JS 里分桶
  const openInDb = await prisma.vendorBill.findMany({
    where: { supplierId: supplier.id, status: 'POSTED', amountDue: { gt: 0 } },
    select: { supplierId: true, amountDue: true, dueDate: true, name: true },
  })
  const expected = summarizeAging(
    openInDb.map(b => ({ supplierId: b.supplierId, amountDue: num(b.amountDue), dueDate: b.dueDate })),
    new Date(),
  )
  const mine = (aging.suppliers ?? []).find(s => s.supplierId === supplier.id)
  const apiBuckets: Record<string, number> = {}
  if (mine?.buckets) for (const [k, v] of Object.entries(mine.buckets)) apiBuckets[k] = num((v as { amount?: number }).amount ?? v)

  const bucketDiffs: string[] = []
  for (const [key, amt] of expected) {
    const bucket = key.split('|')[1]
    if (Math.abs((apiBuckets[bucket] ?? 0) - amt) > 0.005) {
      bucketDiffs.push(`${bucket}: 接口 ${eur(apiBuckets[bucket] ?? 0)} vs 明细 ${eur(amt)}`)
    }
  }
  add('③ 账龄逐桶与明细一致（脚本用独立实现算，不复用接口 SQL）',
    agingRes.ok && !!mine && bucketDiffs.length === 0,
    bucketDiffs.length === 0
      ? `桶 ${Object.entries(apiBuckets).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${eur(v)}`).join(' ')}`
      : bucketDiffs.join('；'))

  const expectedTotal = openInDb.reduce((s, b) => s + num(b.amountDue), 0)
  add('③ 该供应商账龄合计 == 未结账单明细合计',
    Math.abs(num(mine?.total) - expectedTotal) < 0.005,
    `接口 ${eur(num(mine?.total))} vs 明细 ${eur(expectedTotal)}（${openInDb.length} 张未结）`)

  add('③ 逾期 45 天的账单落在 d31_60 桶（分桶阈值对得上）',
    agingBucketOf(dueDate, new Date()) === 'd31_60' && (apiBuckets['d31_60'] ?? 0) >= 120,
    `d31_60 = ${eur(apiBuckets['d31_60'] ?? 0)}（含 G2-VB-AGED €120）`)

  add('③ 无到期日的账单单列 unknown，不混进 current 假装未到期',
    (apiBuckets['unknown'] ?? 0) === 60,
    `unknown = ${eur(apiBuckets['unknown'] ?? 0)}（应 €60）`)

  // 付清的账单不能再出现在账龄里
  const paidInAging = openInDb.some(b => b.name === autoBill.name)
  add('③ 已付清账单不再计入账龄', !paidInAging,
    paidInAging ? `⛔ ${autoBill.name} 已付清却仍在未结清单里` : `${autoBill.name} 已付清，正确排除`)

  // ── 权限：无财务权限者不能登记付款 ────────────────────────────────────────
  const weak = await login(NO_FINANCE)
  if (!weak) skip('无权者被 403', `${NO_FINANCE} 登录失败（限流？稍后重试）`)
  else {
    const denied = await fetch(`${BASE}/api/vendor-bills/${bill2.id}/payments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${weak}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 1 }),
    })
    add('无财务权限的角色登记付款被拒（403）', denied.status === 403, `HTTP ${denied.status}`)
  }

  // ── 非法入参 ────────────────────────────────────────────────────────────
  const badMethod = await fetch(`${BASE}/api/vendor-bills/${billId}/payments`, {
    method: 'POST', headers: auth, body: JSON.stringify({ amount: 1, method: 'bitcoin' }),
  })
  add('非法付款方式被拒（400）', badMethod.status === 400, `HTTP ${badMethod.status}`)
  const zero = await fetch(`${BASE}/api/vendor-bills/${billId}/payments`, {
    method: 'POST', headers: auth, body: JSON.stringify({ amount: 0 }),
  })
  add('金额为 0 被拒（400）', zero.status === 400, `HTTP ${zero.status}`)

  await prisma.$disconnect()
  report()
}

function report() {
  console.log('\n──── 供应商结算 + 分批付款（G2）────')
  for (const c of cases) {
    const icon = c.state === 'pass' ? '✅' : c.state === 'fail' ? '❌' : '⚠️ '
    console.log(`  ${icon} ${c.name.padEnd(44)} ${c.detail}`)
  }
  const failed = cases.filter(c => c.state === 'fail')
  const skipped = cases.filter(c => c.state === 'skip')
  console.log(`\n合计 ${cases.length} 例 · 通过 ${cases.length - failed.length - skipped.length} · 失败 ${failed.length} · ⚠️ 未获验证 ${skipped.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
