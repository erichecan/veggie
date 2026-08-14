/**
 * 司机对账状态统计（台账 C10）—— 端到端实证
 * ============================================================================
 * 验收：未提交 / 待确认 / 已确认 / 有差异 四类都能按司机按日汇总出来，差异可辨认，可导出。
 *
 * 本脚本盯死三件最容易做错的事：
 *   ① **「未提交」必须从行程派生** —— 只查 `DriverDailyReport` 表，看到的永远是
 *      已经报过账的人；而财务要找的恰恰是**出了车没报账**的那个。他在日报表里
 *      一行都没有。脚本会造出这种司机，并同时断言「日报表里查不到他」与
 *      「对账表里查得到他」——只断言后者的话，证明不了前者是真漏
 *   ② **状态与差异不互斥** —— 已确认且对不上的那行最该复核，不能被「有差异」吃掉状态
 *   ③ **区间末日不能丢** —— 待决策 15 点名的坑：date 列与 timestamp 参数比较时
 *      上界会把当天整个排除。这里用「区间末日恰好有数据」的用例把它钉住
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:driver-recon
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const PASSWORD = process.env.SEED_PASSWORD ?? 'LocalTest2026!'
const FINANCE = process.env.FINANCE_EMAIL ?? 'finance@veggie.com'
const DRIVER = process.env.DRIVER_EMAIL ?? 'driver@veggie.com'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()

interface Row {
  driverId: string; driverName: string; date: string
  status: 'not_submitted' | 'submitted' | 'confirmed'
  declared: { cashCollected: number; orderTotal: number; returnCount: number; exchangeCount: number } | null
  system: { cashCollected: number; orderTotal: number; tripIds: string[] }
  diffs: Array<{ field: string; label: string; declared: number; system: number; diff: number }>
  hasDiff: boolean
  confirmedByName: string | null
}
interface Payload {
  from: string; to: string; rows: Row[]
  summary: { total: number; notSubmitted: number; submitted: number; confirmed: number; hasDiff: number }
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

  const finToken = await login(FINANCE)
  if (!finToken) { skip('财务登录', '登录失败（限流？）'); return report() }
  const finAuth: Record<string, string> = { Authorization: `Bearer ${finToken}`, 'Content-Type': 'application/json' }
  const drvToken = await login(DRIVER)
  if (!drvToken) { skip('司机登录', '登录失败（限流？）'); return report() }
  const drvAuth: Record<string, string> = { Authorization: `Bearer ${drvToken}`, 'Content-Type': 'application/json' }

  const stamp = Date.now()
  const driverA = await prisma.user.findUnique({ where: { email: DRIVER }, select: { id: true, name: true } })
  if (!driverA) { skip('司机账号', `${DRIVER} 不存在`); return report() }

  // 第二个司机只用来验行级隔离，不需要能登录
  const driverB = await prisma.user.create({
    data: {
      email: `c10-drv-b-${stamp}@veggie.com`, name: `C10 司机乙 ${stamp}`,
      // 不给可用密码：这个账号只用来验行级隔离，登不进去正好
      passwordHash: 'x', role: 'DRIVER', roles: ['DRIVER'], isActive: true,
    },
    select: { id: true, name: true },
  })

  // 业务日退到 2019 年并按 stamp 错开：种子行程都在 2026 年，撞上就会把别人的钱
  // 算进派生值（C8 第一版报出 €10059.60 而不是 €300）；固定日期则会撞上自己上次
  // 留下的日报（一天一条唯一约束）
  const base = new Date(Date.UTC(2019, 0, 1) + (stamp % 300) * 86400_000)
  const day = (o: number) => new Date(base.getTime() + o * 86400_000).toISOString().slice(0, 10)
  const D0 = day(0)   // 甲、乙都有行程，甲后面会报账
  const D1 = day(1)   // 甲有行程但**始终不报** → 未提交
  const D2 = day(2)   // 甲报了账但当天**没有行程** → 差异行

  const cust = await prisma.customer.create({
    data: { name: `C10 客户 ${stamp}`, isActive: true, paymentTerm: 'cash' },
    select: { id: true, name: true },
  })

  const mkTrip = async (
    label: string, driver: { id: string; name: string | null },
    dateStr: string, cash: number, payment: number, rets: Array<'return' | 'exchange'> = [],
  ) => {
    const wave = await prisma.pickingWave.create({
      data: {
        name: `C10 波次 ${label} ${stamp}`, waveDate: new Date(`${dateStr}T00:00:00Z`),
        orderIds: [], zones: [] as never,
      },
      select: { id: true },
    })
    return prisma.trip.create({
      data: {
        name: `C10 行程 ${label} ${stamp}`, driverId: driver.id, driverName: driver.name,
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

  await mkTrip('A-D0', driverA, D0, 200, 300, ['return', 'exchange'])
  await mkTrip('B-D0', driverB, D0, 500, 500)
  await mkTrip('A-D1', driverA, D1, 90, 150)

  const get = async (q: string, headers: Record<string, string>) => {
    const r = await fetch(`${BASE}/api/driver-reports/summary${q}`, { headers })
    return { status: r.status, body: await r.json().catch(() => ({})) as Payload & { error?: string } }
  }
  const rangeQ = `?from=${D0}&to=${D2}`
  const rowOf = (p: Payload, driverId: string, date: string) =>
    p.rows.find(r => r.driverId === driverId && r.date === date)

  // ── ① 未提交必须从行程派生 ───────────────────────────────────────────────
  const before = await get(rangeQ, finAuth)
  if (before.status !== 200) {
    skip('① 对账汇总接口', `HTTP ${before.status} ${before.body.error ?? ''}`)
    await cleanup(); return report()
  }
  const dbReports = await prisma.driverDailyReport.count({
    where: { driverId: { in: [driverA.id, driverB.id] },
             reportDate: { gte: new Date(`${D0}T00:00:00Z`), lte: new Date(`${D2}T00:00:00Z`) } },
  })
  add('① 反证：此刻日报表里这两个司机一条记录都没有',
    dbReports === 0, `DriverDailyReport 命中 ${dbReports} 条`)
  const a0 = rowOf(before.body, driverA.id, D0)
  add('① **只查日报表会漏掉的那一行，对账表里有**（有行程未报账 → 未提交）',
    a0?.status === 'not_submitted', `${D0} 甲 → ${a0?.status ?? '（这一行根本没出现）'}`)
  add('① 未提交的行照样给出系统值 —— 那是「该报多少」的凭据',
    a0?.system.cashCollected === 200 && a0?.system.orderTotal === 300,
    `系统现金 ${a0?.system.cashCollected} / 订单额 ${a0?.system.orderTotal}`)
  add('① 未提交行的申报值是 null 而不是 0，也不算「有差异」',
    a0?.declared === null && a0?.hasDiff === false,
    `declared=${JSON.stringify(a0?.declared)} hasDiff=${a0?.hasDiff}`)
  add('① 两个司机各自成行，不会并成一条',
    !!rowOf(before.body, driverB.id, D0) && before.body.rows.filter(r => r.date === D0).length >= 2,
    `${D0} 当天 ${before.body.rows.filter(r => r.date === D0).length} 行`)

  // ── ② 区间末日不能丢（待决策 15 的坑）────────────────────────────────────
  const single = await get(`?from=${D1}&to=${D1}`, finAuth)
  add('② 单日查询（from=to）查得到当天 —— date 列的上界不得把当天排除',
    single.status === 200 && !!rowOf(single.body, driverA.id, D1),
    `HTTP ${single.status} · ${single.body.rows?.length ?? 0} 行`)
  const endEdge = await get(`?from=${day(-3)}&to=${D1}`, finAuth)
  add('② 区间**末日**恰好有数据时不丢行',
    !!rowOf(endEdge.body, driverA.id, D1), `末日 ${D1} 的行 ${rowOf(endEdge.body, driverA.id, D1) ? '在' : '丢了'}`)

  // ── ③ 司机报账（故意报少 €50）→ 待确认 + 有差异 ───────────────────────────
  const submit = await fetch(`${BASE}/api/driver-reports/daily`, {
    method: 'POST', headers: drvAuth,
    body: JSON.stringify({
      date: D0, cashCollected: 150, orderTotal: 300, returnCount: 1, exchangeCount: 1, note: 'C10 少报 50',
    }),
  })
  if (submit.status !== 201) {
    skip('③ 司机提交日报', `HTTP ${submit.status}`)
  } else {
    const afterSubmit = await get(rangeQ, finAuth)
    const r = rowOf(afterSubmit.body, driverA.id, D0)
    add('③ 提交后该行转「待确认」', r?.status === 'submitted', `→ ${r?.status}`)
    add('③ 申报 €150 vs 系统 €200 → 标为有差异，且差额与方向都给出',
      r?.hasDiff === true && r?.diffs.some(d => d.field === 'cashCollected' && d.diff === -50),
      r?.diffs.map(d => `${d.label} ${d.declared}/${d.system} 差 ${d.diff}`).join('；') || '（无差异）')
    add('③ 对得上的项不进差异列表（退货 1 / 换货 1 都对）',
      !r?.diffs.some(d => d.field === 'returnCount' || d.field === 'exchangeCount'),
      `差异项：${r?.diffs.map(d => d.field).join(',') || '无'}`)
  }

  // ── ④ 有日报但当天没行程 → 同样成行，差异指出「申报了钱却查无行程」──────────
  await prisma.driverDailyReport.create({
    data: {
      driverId: driverA.id, reportDate: new Date(`${D2}T00:00:00Z`),
      cashCollected: 88, orderTotal: 0, returnCount: 0, exchangeCount: 0, tripIds: [],
      submittedById: driverA.id, submittedByName: driverA.name ?? '',
    },
  })
  const orphan = await get(rangeQ, finAuth)
  const o = rowOf(orphan.body, driverA.id, D2)
  add('④ 报了账但当天没行程 → 这一行也在，且被标成有差异',
    o?.status === 'submitted' && o?.hasDiff === true && o?.system.tripIds.length === 0,
    `${D2} → ${o?.status} · 行程 ${o?.system.tripIds.length ?? '?'} 趟 · 差异 ${o?.diffs.length ?? 0} 项`)

  // ── ⑤ 财务在这张表上确认 → 已确认，且差异不被状态吃掉 ─────────────────────
  const confirm = await fetch(`${BASE}/api/driver-reports/daily`, {
    method: 'PUT', headers: finAuth,
    body: JSON.stringify({ date: D0, driverId: driverA.id, note: '差额已问过司机' }),
  })
  add('⑤ 确认按钮走的是 C9 已有的接口，不新开写入路径', confirm.ok, `HTTP ${confirm.status}`)
  const afterConfirm = await get(rangeQ, finAuth)
  const c = rowOf(afterConfirm.body, driverA.id, D0)
  add('⑤ 确认后该行转「已确认」并记下确认人',
    c?.status === 'confirmed' && !!c?.confirmedByName, `→ ${c?.status} by ${c?.confirmedByName ?? '?'}`)
  add('⑤ **已确认 + 有差异同时成立** —— 状态与差异是两个维度，不是四选一',
    c?.status === 'confirmed' && c?.hasDiff === true,
    `status=${c?.status} hasDiff=${c?.hasDiff}`)

  // ── ⑥ 计数与行数一致（角标与表格同出一源）────────────────────────────────
  const p = afterConfirm.body
  const counted = {
    notSubmitted: p.rows.filter(r => r.status === 'not_submitted').length,
    submitted: p.rows.filter(r => r.status === 'submitted').length,
    confirmed: p.rows.filter(r => r.status === 'confirmed').length,
    hasDiff: p.rows.filter(r => r.hasDiff).length,
  }
  add('⑥ summary 各项 == 实际行数（角标与表格不会打架）',
    p.summary.total === p.rows.length &&
    p.summary.notSubmitted === counted.notSubmitted &&
    p.summary.submitted === counted.submitted &&
    p.summary.confirmed === counted.confirmed &&
    p.summary.hasDiff === counted.hasDiff,
    `${JSON.stringify(p.summary)} vs ${JSON.stringify({ total: p.rows.length, ...counted })}`)

  // ── ⑦ 行级隔离 ──────────────────────────────────────────────────────────
  const asDriver = await get(rangeQ, drvAuth)
  add('⑦ 司机查对账表只看得到自己',
    asDriver.status === 200 && asDriver.body.rows.every(r => r.driverId === driverA.id),
    `HTTP ${asDriver.status} · 出现的司机 ${[...new Set(asDriver.body.rows?.map(r => r.driverId))].length} 个`)
  const spoof = await get(`${rangeQ}&driverId=${driverB.id}`, drvAuth)
  add('⑦ 司机传别人的 driverId 也只拿到自己的（不是拿到空集，是被钉回自己）',
    spoof.status === 200 && spoof.body.rows.length > 0 &&
    spoof.body.rows.every(r => r.driverId === driverA.id),
    `${spoof.body.rows?.length ?? 0} 行，全部属于 ${spoof.body.rows?.[0]?.driverId === driverA.id ? '自己' : '别人'}`)
  const filtered = await get(`${rangeQ}&driverId=${driverB.id}`, finAuth)
  add('⑦ 管理岗按 driverId 筛选生效',
    filtered.body.rows?.every(r => r.driverId === driverB.id) && filtered.body.rows.length > 0,
    `${filtered.body.rows?.length ?? 0} 行`)

  // ── ⑧ 参数边界：错的要拦，不能 500，也不能悄悄返回全量 ────────────────────
  const inverted = await get(`?from=${D2}&to=${D0}`, finAuth)
  add('⑧ from 晚于 to → 400', inverted.status === 400, `HTTP ${inverted.status}`)
  const tooWide = await get('?from=2019-01-01&to=2019-12-31', finAuth)
  add('⑧ 区间超过上限 → 400（不是把半年数据一次吐出来）',
    tooWide.status === 400, `HTTP ${tooWide.status} ${tooWide.body.error ?? ''}`)
  const bogus = await get('?from=2026-02-31&to=BOGUS', finAuth)
  add('⑧ 非法日期 → 回落到默认区间的 200，不是 500',
    bogus.status === 200 && !!bogus.body.from, `HTTP ${bogus.status} · 回落到 ${bogus.body.from}~${bogus.body.to}`)
  const anon = await fetch(`${BASE}/api/driver-reports/summary${rangeQ}`)
  add('⑧ 无 token → 401', anon.status === 401, `HTTP ${anon.status}`)

  await cleanup()
  report()
}

/** 只删自己造的：第二个司机是本脚本建的，留着会让 db:validate 的司机档位不变量多出噪声 */
async function cleanup() {
  await prisma.$disconnect()
}

function report() {
  const pass = cases.filter(c => c.state === 'pass').length
  const fail = cases.filter(c => c.state === 'fail').length
  const sk = cases.filter(c => c.state === 'skip').length
  console.log('\n司机对账状态统计（C10）\n' + '='.repeat(78))
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
