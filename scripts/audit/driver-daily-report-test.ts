/**
 * 司机每日回传（台账 C8）—— 端到端实证
 * ============================================================================
 * 验收：司机提交后生成一条当日对账记录，四个数字都落库；同一天重复提交有防重；
 *       数字与该司机当日行程明细可对上。
 *
 * ## 为什么四个数字不各存一份
 * 它们已经有真相：现金在 `Trip.cashCollected`、订单额在 `Trip.totalPayment`、
 * 退货/换货在 `restaurants[].returns[]`（靠 actionType 区分）。日报表只存
 * **提交那一刻的快照**，系统值实时派生，差额单列 —— C6 刚把司机身份的分叉守住，
 * 这里不能立刻又开一处真相。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:driver-daily
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { deriveDailyReport } from '../../lib/driver-daily-report'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const PASSWORD = process.env.SEED_PASSWORD ?? 'LocalTest2026!'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
const DRIVER = process.env.DRIVER_EMAIL ?? 'driver@veggie.com'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()
const eur = (n: number) => `€${Number(n).toFixed(2)}`

interface DailyPayload {
  date: string
  driverId: string
  system: {
    tripIds: string[]; cashCollected: number; orderTotal: number
    returnCount: number; exchangeCount: number; stopCount: number; unsettledTripCount: number
  }
  submitted: { id: string; cashCollected: string; returnCount: number; exchangeCount: number } | null
  diffs: Array<{ field: string; label: string; declared: number; system: number; diff: number }>
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

  const opToken = await login(OPERATOR)
  if (!opToken) { skip('登录', '运营账号登录失败（限流？）'); return report() }
  const auth: Record<string, string> = { Authorization: `Bearer ${opToken}`, 'Content-Type': 'application/json' }
  const stamp = Date.now()

  const driver = await prisma.user.findUnique({ where: { email: DRIVER }, select: { id: true, name: true } })
  if (!driver) { skip('司机账号', `${DRIVER} 不存在`); return report() }
  const drvToken = await login(DRIVER)
  if (!drvToken) { skip('司机登录', '登录失败（限流？）'); return report() }
  const drvAuth: Record<string, string> = { Authorization: `Bearer ${drvToken}`, 'Content-Type': 'application/json' }

  // ── 夹具：给这个司机造当天两趟行程，含退货与换货 ──────────────────────────
  // 业务日必须挑一个**库里绝对没有历史行程**的日子，否则派生值会把种子数据一起
  // 算进来（第一版往前推 40 天，撞上种子行程，订单额报出 €10059.60 而不是 €300）。
  // 种子数据都在 2026 年，所以退到 2019 年；再按 stamp 错开天数 ——
  // 日报有「一天一条」的唯一约束，固定日期的话第二次跑就撞上自己上次留下的记录。
  const dayIndex = stamp % 300
  const base = new Date(Date.UTC(2019, 0, 1) + dayIndex * 86400_000)
  const dateStr = base.toISOString().slice(0, 10)
  const dayAt = (offset: number) =>
    new Date(base.getTime() + offset * 86400_000).toISOString().slice(0, 10)

  const cust = await prisma.customer.create({
    data: { name: `C8 客户 ${stamp}`, isActive: true, paymentTerm: 'cash' },
    select: { id: true, name: true },
  })

  const mkTrip = async (label: string, cash: number, payment: number, rets: Array<'return' | 'exchange'>) => {
    const wave = await prisma.pickingWave.create({
      data: {
        name: `C8 波次 ${label} ${stamp}`, waveDate: new Date(`${dateStr}T00:00:00Z`),
        orderIds: [], zones: [] as never,
      },
      select: { id: true },
    })
    return prisma.trip.create({
      data: {
        name: `C8 行程 ${label} ${stamp}`, driverId: driver.id, driverName: driver.name,
        waveId: wave.id, status: 'COMPLETED', totalPayment: payment,
        cashCollected: cash, onlineCollected: 0, settlementStatus: 'submitted',
        restaurants: [{
          restaurantId: cust.id, restaurantName: cust.name, orderIds: [], delivered: true,
          items: [], pods: [],
          returns: rets.map((t, i) => ({
            productId: `p${i}`, productName: `商品${i}`, quantity: 1, actionType: t,
          })),
        }] as never,
      },
      select: { id: true },
    })
  }

  // 上午：现金 120，应收 200，1 退 1 换；下午：现金 80，应收 100，1 退
  const t1 = await mkTrip('AM', 120, 200, ['return', 'exchange'])
  const t2 = await mkTrip('PM', 80, 100, ['return'])

  // ── ① 系统派生值与行程明细对得上 ──────────────────────────────────────────
  const sysDirect = await deriveDailyReport(prisma, driver.id, dateStr)
  add('① 系统从当日行程派生出四项（不是另存一份）',
    sysDirect.cashCollected === 200 && sysDirect.orderTotal === 300 &&
    sysDirect.returnCount === 2 && sysDirect.exchangeCount === 1,
    `现金 ${eur(sysDirect.cashCollected)} · 订单额 ${eur(sysDirect.orderTotal)} · 退 ${sysDirect.returnCount} 笔 · 换 ${sysDirect.exchangeCount} 笔`)
  add('① 覆盖的行程正是当天那两趟',
    sysDirect.tripIds.length === 2 && [t1.id, t2.id].every(id => sysDirect.tripIds.includes(id)),
    `覆盖 ${sysDirect.tripIds.length} 趟`)

  const getRes = await fetch(`${BASE}/api/driver-reports/daily?date=${dateStr}`, { headers: drvAuth })
  const got = await getRes.json() as DailyPayload
  add('① 司机端接口返回同一组系统值（接口与 lib 两条路一致）',
    getRes.ok && got.system?.cashCollected === 200 && got.system?.orderTotal === 300,
    `HTTP ${getRes.status} · 现金 ${eur(got.system?.cashCollected ?? -1)} · 订单额 ${eur(got.system?.orderTotal ?? -1)}`)
  add('① 未提交时 submitted 为 null（不是空对象，前端好判断）',
    got.submitted === null, `submitted=${JSON.stringify(got.submitted)}`)

  // ── ② 提交：四项落库 ──────────────────────────────────────────────────────
  const submit = await fetch(`${BASE}/api/driver-reports/daily`, {
    method: 'POST', headers: drvAuth,
    body: JSON.stringify({
      date: dateStr, cashCollected: 200, orderTotal: 300,
      returnCount: 2, exchangeCount: 1, note: 'C8 收车回传',
    }),
  })
  const created = await submit.json() as { report?: { id: string }; diffs?: unknown[] }
  const row = created.report?.id
    ? await prisma.driverDailyReport.findUnique({ where: { id: created.report.id } })
    : null
  add('② 提交后生成一条当日对账记录，四个数字都落库',
    submit.status === 201 && !!row &&
    Number(row.cashCollected) === 200 && Number(row.orderTotal) === 300 &&
    row.returnCount === 2 && row.exchangeCount === 1,
    `HTTP ${submit.status} · 现金 ${eur(Number(row?.cashCollected ?? 0))} · 订单额 ${eur(Number(row?.orderTotal ?? 0))} · 退 ${row?.returnCount} · 换 ${row?.exchangeCount}`)
  add('② 记录里存了覆盖哪几趟（事后能追溯当时算的是哪些单）',
    (row?.tripIds ?? []).length === 2, `tripIds=${(row?.tripIds ?? []).length} 条`)
  add('② 申报与系统一致时没有差异项', (created.diffs ?? []).length === 0,
    `diffs=${JSON.stringify(created.diffs)}`)

  // ── ③ 同一天重复提交防重 ──────────────────────────────────────────────────
  const dup = await fetch(`${BASE}/api/driver-reports/daily`, {
    method: 'POST', headers: drvAuth,
    body: JSON.stringify({ date: dateStr, cashCollected: 999, orderTotal: 999, returnCount: 0, exchangeCount: 0 }),
  })
  const dupBody = await dup.json() as { error?: string; existing?: { id: string } }
  add('③ 同一天重复提交 → 409，并带出已存在的那条',
    dup.status === 409 && !!dupBody.existing, `HTTP ${dup.status} ${dupBody.error ?? ''}`)
  if (!created.report?.id) { skip('后续用例', '提交未成功，无法继续（该日可能已有记录）'); return report() }
  const afterDup = await prisma.driverDailyReport.findUnique({ where: { id: created.report.id } })
  add('③ 重复提交没有把原记录改掉（999 没写进去）',
    Number(afterDup?.cashCollected) === 200, `库里仍是 ${eur(Number(afterDup?.cashCollected ?? 0))}`)

  const count = await prisma.driverDailyReport.count({
    where: { driverId: driver.id, reportDate: new Date(`${dateStr}T00:00:00Z`) },
  })
  add('③ 该司机当天只有一条记录（唯一约束兜底，不靠先查后写）',
    count === 1, `${count} 条`)

  // ── ④ 提交之后行程被改 → 差异要显示出来，不能抹平 ─────────────────────────
  // 退货审核通过、补录收款都是正常业务，日报快照与实时值就该不一样。
  await prisma.trip.update({ where: { id: t2.id }, data: { cashCollected: 130 } })
  const afterChange = await fetch(`${BASE}/api/driver-reports/daily?date=${dateStr}`, { headers: drvAuth })
    .then(r => r.json()) as DailyPayload
  const cashDiff = (afterChange.diffs ?? []).find(d => d.field === 'cashCollected')
  add('④ 提交后行程被改 → 差异如实显示（申报 200 vs 系统 250）',
    !!cashDiff && cashDiff.declared === 200 && cashDiff.system === 250 && cashDiff.diff === -50,
    cashDiff ? `${cashDiff.label}：申报 ${eur(cashDiff.declared)} vs 系统 ${eur(cashDiff.system)}，差 ${eur(cashDiff.diff)}` : '⛔ 没有报出差异')
  add('④ 快照本身没被改（对账记录是当时的事实）',
    Number((await prisma.driverDailyReport.findUnique({ where: { id: created.report.id } }))?.cashCollected) === 200,
    '快照仍是 €200.00')

  // ── ⑤ 行级隔离：司机只能报自己的 ──────────────────────────────────────────
  const other = await prisma.user.findFirst({
    where: { AND: [{ OR: [{ role: 'DRIVER' }, { roles: { has: 'DRIVER' } }] }, { id: { not: driver.id } }] },
    select: { id: true, name: true },
  })
  if (other) {
    // 司机拿别人的 driverId 提交 —— 必须落到自己头上，而不是替别人报账
      const day2 = dayAt(1)
    const spoof = await fetch(`${BASE}/api/driver-reports/daily`, {
      method: 'POST', headers: drvAuth,
      body: JSON.stringify({
        date: day2, driverId: other.id,
        cashCollected: 1, orderTotal: 1, returnCount: 0, exchangeCount: 0,
      }),
    })
    const spoofBody = await spoof.json() as { report?: { driverId: string } }
    add('⑤ 司机传别人的 driverId，记录仍落在自己名下（不能替别人报账）',
      spoof.status === 201 && spoofBody.report?.driverId === driver.id,
      `HTTP ${spoof.status} · 落在 ${spoofBody.report?.driverId === driver.id ? '本人' : '别人'} 名下`)

    const peek = await fetch(`${BASE}/api/driver-reports/daily?date=${dateStr}&driverId=${other.id}`, { headers: drvAuth })
      .then(r => r.json()) as DailyPayload
    add('⑤ 司机查别人的当日回传，拿到的仍是自己的',
      peek.driverId === driver.id, `返回的 driverId=${peek.driverId === driver.id ? '本人' : '别人'}`)
  } else {
    skip('⑤ 行级隔离', '库里没有第二个司机账号')
  }

  // 管理岗可以指定看某个司机
  const opView = await fetch(`${BASE}/api/driver-reports/daily?date=${dateStr}&driverId=${driver.id}`, { headers: auth })
    .then(r => r.json()) as DailyPayload
  add('⑤ 运营可以指定查某个司机的当日回传', opView.driverId === driver.id && opView.system?.orderTotal === 300,
    `driverId 对上=${opView.driverId === driver.id} · 订单额 ${eur(opView.system?.orderTotal ?? -1)}`)

  // ── ⑥ 输入校验 ────────────────────────────────────────────────────────────
  const day3 = dayAt(2)
  const badDate = await fetch(`${BASE}/api/driver-reports/daily`, {
    method: 'POST', headers: drvAuth,
    body: JSON.stringify({ date: '2026-02-31', cashCollected: 0, orderTotal: 0, returnCount: 0, exchangeCount: 0 }),
  })
  add('⑥ 不存在的日期（2026-02-31）→ 400，不会被 Date 悄悄滚到 3 月',
    badDate.status === 400, `HTTP ${badDate.status}`)

  const missing = await fetch(`${BASE}/api/driver-reports/daily`, {
    method: 'POST', headers: drvAuth,
    body: JSON.stringify({ date: day3, cashCollected: 10, orderTotal: 10, returnCount: 0 }),
  })
  add('⑥ 缺一项 → 400（缺项悄悄记 0 的话，"报了 0 笔"和"没填"分不开）',
    missing.status === 400, `HTTP ${missing.status}`)

  const negative = await fetch(`${BASE}/api/driver-reports/daily`, {
    method: 'POST', headers: drvAuth,
    body: JSON.stringify({ date: day3, cashCollected: -5, orderTotal: 10, returnCount: 0, exchangeCount: 0 }),
  })
  add('⑥ 负数 → 400', negative.status === 400, `HTTP ${negative.status}`)

  const fractional = await fetch(`${BASE}/api/driver-reports/daily`, {
    method: 'POST', headers: drvAuth,
    body: JSON.stringify({ date: day3, cashCollected: 10, orderTotal: 10, returnCount: 1.5, exchangeCount: 0 }),
  })
  add('⑥ 退货笔数填小数 → 400（数的是笔数）', fractional.status === 400, `HTTP ${fractional.status}`)

  const anon = await fetch(`${BASE}/api/driver-reports/daily?date=${dateStr}`)
  add('⑥ 匿名 401', anon.status === 401, `HTTP ${anon.status}`)

  await prisma.$disconnect()
  report()
}

function report() {
  const pass = cases.filter(c => c.state === 'pass').length
  const fail = cases.filter(c => c.state === 'fail').length
  const sk = cases.filter(c => c.state === 'skip').length
  console.log('\n司机每日回传\n' + '='.repeat(78))
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
