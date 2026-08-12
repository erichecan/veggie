/**
 * 客户对账单 + 司机现金核销 —— 端到端实证
 * ============================================================================
 * 台账 G1。验收三条：
 *   ① 能为一个真实客户生成一张对账单（含期初、本期发生、收款、期末）
 *   ② 司机带回的现金能核销到具体单据
 *   ③ 生成后金额与订单明细可逐笔对上
 *
 * 备注里那句「Statement 表实测 0 张、Payment 表实测 0 条」才是这条任务的要害：
 * 代码一直都在，只是从没跑出过一条真数据。所以本脚本从下单一路走到对账单，
 * 每一步都核对落库，而不是只验接口不报错。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:statement
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { businessDayStart, addBusinessDays } from '../../lib/analytics/metrics'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const PASSWORD = process.env.SEED_PASSWORD ?? 'LocalTest2026!'
const FINANCE = process.env.FINANCE_EMAIL ?? 'finance@veggie.com'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
/** 没有财务权限的角色，用来验「无权者被 403」 */
const NO_FINANCE = process.env.DRIVER_EMAIL ?? 'driver@veggie.com'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()
const num = (v: unknown) => Number(v ?? 0)
const eur = (n: number) => `€${n.toFixed(2)}`
const ymd = (d: Date) => {
  // 业务日的 YYYY-MM-DD：直接 toISOString 会在都柏林 00:00–01:00 退回前一天
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit' })
  return f.format(d)
}

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

  const token = await login(FINANCE)
  if (!token) { skip('登录', '财务账号登录失败'); return report() }
  const auth: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  // 下单是销售动作，财务账号没有 sales.order.create —— 各用各的身份打，
  // 顺带证明这条链跨了两个岗位（业务下单、财务出账）而不是一个超级账号包办
  const opToken = await login(OPERATOR)
  if (!opToken) { skip('登录', '运营账号登录失败（限流？稍后重试）'); return report() }
  const opAuth: Record<string, string> = { Authorization: `Bearer ${opToken}`, 'Content-Type': 'application/json' }
  // 司机：交账由他提交（finance.settlement.create 在 driver 角色上），
  // 财务只负责确认（finance.settlement.confirm）—— 这个分工本身就是被测内容之一。
  // 同一个 token 稍后还用来验「无财务权限者不能生成对账单」。
  const driverToken = await login(NO_FINANCE)
  const driverAuth: Record<string, string> | null = driverToken
    ? { Authorization: `Bearer ${driverToken}`, 'Content-Type': 'application/json' } : null
  const stamp = Date.now()

  const statementsBefore = await prisma.statement.count()
  const paymentsBefore = await prisma.payment.count()

  // ── 夹具：现金账期客户（借既有客户会撞信用冻结 403，台账已记）──────────────
  const customer = await prisma.customer.create({
    data: { name: `G1 对账测试客户 ${stamp}`, paymentTerm: 'cash', isCustomer: true, isActive: true },
    select: { id: true, name: true },
  })
  const pname = `G1 对账测试商品 ${stamp}`
  const tmpl = await prisma.productTemplate.create({
    data: {
      name: pname, type: 'PRODUCT', status: 'ACTIVE', listPrice: 10, standardPrice: 4,
      uomId: 'uom_pcs', canBeSold: true, canBePurchased: true,
      products: { create: [{ name: pname, listPrice: 10, standardPrice: 4, qtyOnHand: 0, active: true, status: 'ACTIVE' }] },
    },
    select: { products: { select: { id: true }, take: 1 } },
  })
  const productId = tmpl.products[0]!.id
  await prisma.$transaction([
    prisma.stockMove.create({
      data: { productId, productName: pname, type: 'ADJUSTMENT', qty: 1000, movedAt: new Date(), note: 'G1 期初', sourceType: 'TEST_OPENING', sourceRef: 'G1' },
    }),
    prisma.product.update({ where: { id: productId }, data: { qtyOnHand: 1000 } }),
  ])

  // 对账期间：今天往前推 10 天 ~ 前 3 天（一个已经结束的账期）
  const today = businessDayStart(new Date())
  const periodStart = addBusinessDays(today, -10)
  const periodEnd = addBusinessDays(today, -3)      // 末日（含）
  const beforePeriod = addBusinessDays(today, -20)  // 期前，制造期初余额

  /** 建单 → 确认 → 把销售确认时间挪到指定业务日 */
  async function makeOrder(qty: number, confirmedAt: Date, label: string) {
    const res = await fetch(`${BASE}/api/orders`, {
      method: 'POST', headers: opAuth,
      body: JSON.stringify({
        restaurantId: customer.id, restaurantName: customer.name,
        deliveryDate: ymd(confirmedAt),
        items: [{ productId, quantity: qty, unitPrice: 10 }],
      }),
    })
    const j = await res.json() as { id?: string; error?: string }
    if (!j.id) throw new Error(`建单失败(${label}): HTTP ${res.status} ${j.error ?? ''}`)
    const cf = await fetch(`${BASE}/api/orders/${j.id}`, {
      method: 'PUT', headers: opAuth, body: JSON.stringify({ status: 'CONFIRMED' }),
    })
    if (!cf.ok) throw new Error(`确认失败(${label}): HTTP ${cf.status}`)
    // ⚠️ 时间旅行只能直接改库 —— 接口不可能让人把确认时间设到 10 天前。
    // 这是**夹具**，不是被测行为；被测的是「对账单怎么按这些时间切期间」。
    await prisma.order.update({ where: { id: j.id }, data: { confirmationDate: confirmedAt } })
    return j.id
  }

  let orderPrior: string, orderMid: string, orderLastDay: string, orderAfter: string
  try {
    // 期前一单 €200 —— 用来制造非零期初
    orderPrior = await makeOrder(20, new Date(beforePeriod.getTime() + 10 * 3600_000), '期前')
    // 期内两单：中间一单 €300
    orderMid = await makeOrder(30, new Date(periodStart.getTime() + 36 * 3600_000), '期内')
    // **末日 22:00（都柏林）一单 €50** —— 原实现 `lte: 末日00:00` 会把它整天切掉
    orderLastDay = await makeOrder(5, new Date(periodEnd.getTime() + 22 * 3600_000), '末日晚间')
    // 期后一单 €90 —— 不该进本期
    orderAfter = await makeOrder(9, new Date(addBusinessDays(periodEnd, 1).getTime() + 9 * 3600_000), '期后')
  } catch (e) {
    skip('夹具建单', e instanceof Error ? e.message : String(e)); return report()
  }
  add('夹具就位：期前/期内/末日晚间/期后 各一单', true,
    `期前 €200 · 期内 €300 · 末日晚间 €50 · 期后 €90（税率 0，便于逐笔核对）`)

  // ── 期前那单开票并全额收款 €200 → 期初应为 0；再留一张未收的验期初非 0 ────
  // 这里刻意让期前**只开票不收款**，于是期初 = €200 欠款。原实现首张对账单期初恒 0。
  const priorInvoice = await fetch(`${BASE}/api/invoices`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      name: `G1-INV-PRIOR-${stamp}`, customerId: customer.id, customerName: customer.name,
      saleOrderIds: [orderPrior], status: 'POSTED', paymentTerms: 'cash',
      lines: [{ productId, productName: pname, qty: 20, unitPrice: 10, taxRate: 0 }],
    }),
  })
  if (!priorInvoice.ok) { skip('期前开票', `HTTP ${priorInvoice.status}`); return report() }

  // ── ② 司机现金核销：先给期内那单开一张 POSTED 发票 ───────────────────────
  const invRes = await fetch(`${BASE}/api/invoices`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      name: `G1-INV-${stamp}`, customerId: customer.id, customerName: customer.name,
      saleOrderIds: [orderMid], status: 'POSTED', paymentTerms: 'cash',
      lines: [{ productId, productName: pname, qty: 30, unitPrice: 10, taxRate: 0 }],
    }),
  })
  const invoice = await invRes.json() as { id?: string; name?: string; amountDue?: number; error?: string }
  if (!invoice.id) { skip('开票', `HTTP ${invRes.status} ${invoice.error ?? ''}`); return report() }
  add('② 期内订单已开出 POSTED 发票', num(invoice.amountDue) === 300,
    `${invoice.name} · 应收 ${eur(num(invoice.amountDue))}`)

  // 行程：司机送这一单，现场收现金 €300
  const trip = await prisma.trip.create({
    data: {
      name: `G1 交账测试行程 ${stamp}`, driverName: '测试司机', status: 'COMPLETED',
      totalPayment: 300, settlementStatus: 'pending',
      restaurants: [{
        restaurantId: customer.id, restaurantName: customer.name,
        orderIds: [orderMid], payment: 300,
      }] as never,
    },
    select: { id: true },
  })

  if (!driverAuth) { skip('② 司机提交交账', '司机账号登录失败（限流？稍后重试）'); return report() }
  const submitRes = await fetch(`${BASE}/api/trips/${trip.id}/settlement`, {
    method: 'POST', headers: driverAuth,
    body: JSON.stringify({ cashCollected: 300, onlineCollected: 0, settlementNote: 'G1 测试交账' }),
  })
  add('② 司机本人提交交账（司机有 create、无 confirm）', submitRes.ok, `HTTP ${submitRes.status}`)

  // 职责分离：司机不能自己确认自己的交账
  const selfConfirm = await fetch(`${BASE}/api/trips/${trip.id}/settlement`, {
    method: 'PUT', headers: driverAuth, body: JSON.stringify({ confirmed: true }),
  })
  add('② 司机不能自己确认交账（403）', selfConfirm.status === 403, `HTTP ${selfConfirm.status}`)

  const confirmRes = await fetch(`${BASE}/api/trips/${trip.id}/settlement`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ confirmed: true }),
  })
  const confirmBody = await confirmRes.json().catch(() => ({})) as { settlementPosting?: { created?: number; totalAllocated?: number; unallocated?: unknown[] } }
  const posting = confirmBody.settlementPosting
  add('② 财务确认交账 → 真的写出 Payment', confirmRes.ok && (posting?.created ?? 0) === 1,
    `HTTP ${confirmRes.status} · created=${posting?.created ?? 0} · 核销 ${eur(num(posting?.totalAllocated))}`)

  const paidPayments = await prisma.payment.findMany({
    where: { customerId: customer.id }, select: { id: true, amount: true, method: true, note: true, invoiceId: true, paidAt: true },
  })
  add('② 现金核销到了具体单据（发票 id + 行程标记齐全）',
    paidPayments.length === 1 && paidPayments[0].invoiceId === invoice.id
      && paidPayments[0].method === 'cash' && (paidPayments[0].note ?? '').includes(`TRIP:${trip.id}`),
    `${paidPayments.length} 笔 · 发票 ${paidPayments[0]?.invoiceId === invoice.id ? '匹配' : '不匹配'} · note=${paidPayments[0]?.note ?? '—'}`)

  const invAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { amountPaid: true, amountDue: true, status: true } })
  add('② 核销后发票已结清（应收归零、状态转 PAID）',
    num(invAfter.amountDue) === 0 && num(invAfter.amountPaid) === 300 && invAfter.status === 'PAID',
    `已付 ${eur(num(invAfter.amountPaid))} · 应收 ${eur(num(invAfter.amountDue))} · ${invAfter.status}`)

  // 幂等：重复确认不能再记一笔钱
  await prisma.trip.update({ where: { id: trip.id }, data: { settlementStatus: 'submitted' } })
  await fetch(`${BASE}/api/trips/${trip.id}/settlement`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ confirmed: true }),
  })
  const paymentsAfterRetry = await prisma.payment.count({ where: { customerId: customer.id } })
  add('② 重复确认交账不重复记账（幂等）', paymentsAfterRetry === 1, `Payment ${paymentsAfterRetry} 笔（应 1）`)

  // 收款日期挪进对账期间（同上，时间旅行只能直接改库）
  await prisma.payment.updateMany({
    where: { customerId: customer.id },
    data: { paidAt: new Date(periodStart.getTime() + 40 * 3600_000) },
  })

  // ── ① 生成对账单 ────────────────────────────────────────────────────────
  const genRes = await fetch(`${BASE}/api/statements`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ customerId: customer.id, periodStart: ymd(periodStart), periodEnd: ymd(periodEnd) }),
  })
  const st = await genRes.json() as {
    id?: string; openingBalance?: number; totalSales?: number; totalPayments?: number
    closingBalance?: number; orderIds?: string[]; openingSource?: string; error?: string
  }
  if (!st.id) { skip('生成对账单', `HTTP ${genRes.status} ${st.error ?? ''}`); return report() }
  add('① 对账单生成成功（四段齐全）', genRes.status === 201,
    `期初 ${eur(num(st.openingBalance))} · 销售 ${eur(num(st.totalSales))} · 收款 ${eur(num(st.totalPayments))} · 期末 ${eur(num(st.closingBalance))}`)

  add('① 首张对账单的期初按历史派生，不是 0',
    st.openingSource === 'derived-history' && num(st.openingBalance) === 200,
    `期初 ${eur(num(st.openingBalance))}（期前 €200 未收）· 来源=${st.openingSource}`)

  add('① 本期销售 = 期内两单（含末日晚间那张）', num(st.totalSales) === 350,
    `${eur(num(st.totalSales))}（€300 + 末日 €50 = €350；期后 €90 不该进来）`)
  add('① 末日整天算进来了 —— 原实现会把这单切掉',
    (st.orderIds ?? []).includes(orderLastDay),
    `末日晚间单 ${(st.orderIds ?? []).includes(orderLastDay) ? '已计入' : '⛔ 被漏掉'}`)
  add('① 期后订单没被算进来', !(st.orderIds ?? []).includes(orderAfter),
    `期后单 ${(st.orderIds ?? []).includes(orderAfter) ? '⛔ 混进来了' : '正确排除'}`)
  add('① 本期收款 = 司机交账的现金', num(st.totalPayments) === 300, eur(num(st.totalPayments)))
  add('① 期末 = 期初 + 销售 − 收款', num(st.closingBalance) === 250,
    `200 + 350 − 300 = ${eur(num(st.closingBalance))}`)

  // ── ③ 逐笔对上 ──────────────────────────────────────────────────────────
  const detailRes = await fetch(`${BASE}/api/statements/${st.id}?withDetail=1`, { headers: auth })
  const detail = await detailRes.json() as {
    orders?: Array<{ id: string; incTaxTotal: number }>
    payments?: Array<{ id: string; invoiceName: string | null; amount: number; source: string; tripId: string | null; createdBy: string | null }>
    reconciliation?: { ok: boolean; salesFromOrders: number; paymentsFromRecords: number; problems: string[] }
    missingOrderIds?: string[]
  }
  add('③ 明细接口给出逐笔订单与收款', detailRes.ok && (detail.orders?.length ?? 0) === 2 && (detail.payments?.length ?? 0) === 1,
    `订单 ${detail.orders?.length ?? 0} 笔 · 收款 ${detail.payments?.length ?? 0} 笔`)
  add('③ 逐笔合计与汇总一致（服务端当场核对，非人肉比）',
    detail.reconciliation?.ok === true
      && detail.reconciliation.salesFromOrders === 350
      && detail.reconciliation.paymentsFromRecords === 300,
    `ok=${detail.reconciliation?.ok} · 明细销售 ${eur(num(detail.reconciliation?.salesFromOrders))} · 明细收款 ${eur(num(detail.reconciliation?.paymentsFromRecords))} · ${JSON.stringify(detail.reconciliation?.problems ?? [])}`)
  const dp = detail.payments?.[0]
  add('③ 收款明细标出「司机现金」并指到具体发票与行程',
    dp?.source === 'DRIVER_CASH' && dp?.invoiceName === invoice.name && dp?.tripId === trip.id,
    `来源=${dp?.source} · 发票=${dp?.invoiceName} · 行程=${dp?.tripId === trip.id ? '匹配' : dp?.tripId}`)
  // 「经手」列直接显示给人看：交账核销此前写的是 userId，手工登记写的是人名 ——
  // 同一列两种语义，浏览器上一行「张三」一行一串 cuid。这里钉死不能是 id
  add('③ 收款明细的「经手」是人名而非 userId',
    !!dp?.createdBy && !/^c[a-z0-9]{20,}$/.test(dp.createdBy),
    `经手=${dp?.createdBy}`)

  // 明细的核对必须**真的会报错**，否则 ok 永远为真等于没测（B2/E3/D5x 同一个坑）
  await prisma.statement.update({ where: { id: st.id }, data: { totalSales: 999 } })
  const tampered = await (await fetch(`${BASE}/api/statements/${st.id}?withDetail=1`, { headers: auth })).json() as {
    reconciliation?: { ok: boolean; salesDiff: number; problems: string[] }
  }
  add('③ 汇总被改动后核对能报出来（证明这个 ✓ 有约束力）',
    tampered.reconciliation?.ok === false && Math.abs(num(tampered.reconciliation?.salesDiff) + 649) < 0.005,
    `ok=${tampered.reconciliation?.ok} · 差额 ${eur(num(tampered.reconciliation?.salesDiff))} · ${tampered.reconciliation?.problems?.[0]?.slice(0, 60) ?? ''}`)
  await prisma.statement.update({ where: { id: st.id }, data: { totalSales: 350 } })

  // ── 重复生成必须被挡（两张并存时下一期的期初会变成掷骰子）─────────────────
  const dupRes = await fetch(`${BASE}/api/statements`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ customerId: customer.id, periodStart: ymd(periodStart), periodEnd: ymd(periodEnd) }),
  })
  const dupBody = await dupRes.json().catch(() => ({})) as { existingId?: string; error?: string }
  add('同客户同期间重复生成被拒（409，并指出已有那张）',
    dupRes.status === 409 && dupBody.existingId === st.id,
    `HTTP ${dupRes.status} · existingId=${dupBody.existingId === st.id ? '匹配' : dupBody.existingId}`)

  // ── 起止颠倒 / 非法日期 ─────────────────────────────────────────────────
  const badRange = await fetch(`${BASE}/api/statements`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ customerId: customer.id, periodStart: ymd(periodEnd), periodEnd: ymd(periodStart) }),
  })
  add('起止颠倒被拒（400）', badRange.status === 400, `HTTP ${badRange.status}`)

  // ── 第二期：期初必须承接上一期期末，而不是又从历史派生一遍 ────────────────
  const p2Start = addBusinessDays(periodEnd, 1)
  const p2End = addBusinessDays(today, -1)
  const st2Res = await fetch(`${BASE}/api/statements`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ customerId: customer.id, periodStart: ymd(p2Start), periodEnd: ymd(p2End) }),
  })
  const st2 = await st2Res.json() as { id?: string; openingBalance?: number; totalSales?: number; closingBalance?: number; openingSource?: string }
  add('第二期期初 = 第一期期末（账簿连续）',
    st2Res.status === 201 && st2.openingSource === 'previous-statement' && num(st2.openingBalance) === 250,
    `期初 ${eur(num(st2.openingBalance))} · 来源=${st2.openingSource}`)
  add('第二期销售 = 期后那单 €90（期间不重不漏）', num(st2.totalSales) === 90,
    `${eur(num(st2.totalSales))} · 期末 ${eur(num(st2.closingBalance))}`)

  // ── 状态流转 ────────────────────────────────────────────────────────────
  const toConfirmed = await fetch(`${BASE}/api/statements/${st.id}`, { method: 'PUT', headers: auth, body: JSON.stringify({ status: 'confirmed' }) })
  const toSent = await fetch(`${BASE}/api/statements/${st.id}`, { method: 'PUT', headers: auth, body: JSON.stringify({ status: 'sent' }) })
  const afterSent = await fetch(`${BASE}/api/statements/${st.id}`, { method: 'PUT', headers: auth, body: JSON.stringify({ status: 'draft' }) })
  add('状态流转 draft → confirmed → sent，且 sent 后不可再改',
    toConfirmed.ok && toSent.ok && afterSent.status === 400,
    `confirmed ${toConfirmed.status} · sent ${toSent.status} · 再退回 ${afterSent.status}（应 400）`)

  // ── 权限：无财务权限的角色不能生成对账单 ──────────────────────────────────
  const denied = await fetch(`${BASE}/api/statements`, {
    method: 'POST', headers: driverAuth,
    body: JSON.stringify({ customerId: customer.id, periodStart: ymd(periodStart), periodEnd: ymd(periodEnd) }),
  })
  add('无财务权限的角色生成对账单被拒（403）', denied.status === 403, `HTTP ${denied.status}`)

  // ── 「真的出现了记录」——这条任务的原始诉求 ───────────────────────────────
  const statementsAfter = await prisma.statement.count()
  const paymentsAfter = await prisma.payment.count()
  add('库里真的多出了对账单与收款记录', statementsAfter === statementsBefore + 2 && paymentsAfter === paymentsBefore + 1,
    `Statement ${statementsBefore} → ${statementsAfter} · Payment ${paymentsBefore} → ${paymentsAfter}`)

  // 顺带确认运营角色也读得到（对账单不是财务专属信息孤岛）
  const opRead = await fetch(`${BASE}/api/statements?customerId=${customer.id}`, { headers: opAuth })
  const opReadJson = await opRead.json() as { total?: number }
  add('运营角色可读该客户对账单', opRead.ok && (opReadJson.total ?? 0) === 2,
    `HTTP ${opRead.status} · ${opReadJson.total ?? 0} 张`)

  await prisma.$disconnect()
  report()
}

function report() {
  console.log('\n──── 客户对账单 + 司机现金核销（G1）────')
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
