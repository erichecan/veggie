/**
 * 打印全场景测试矩阵
 * ============================================================================
 * 台账 D5。对应需求原话：「需要处理各种状态、各种筛选条件，并使用 AI 创建不同的测试用例」。
 *
 * 覆盖三个维度：
 *   4 类单据   销售单 / 司机送货汇总单 / 配送单 / 客户签收单
 *   7 种状态   PENDING → CONFIRMED → WAVE_ASSIGNED → IN_DELIVERY → COMPLETED / LOCKED / CANCELLED
 *   4 类筛选   按日期 / 按线路(司机批次) / 按波次 / 无筛选（整日全打）
 *
 * 断言的是**数据层**（打印页消费的那几个接口），不是像素。理由：像素级比对脆弱
 * 且看不出错在哪；而 D2 走查查出的三个真问题——配送单据打成空白、司机名与波次
 * 不一致、税率量纲错——全都能在数据层断言出来，且失败时直接指向根因。
 *
 * ⚠️ 打印页内嵌 <script>window.print()</script>，会弹对话框阻塞 JS。
 *    不要用浏览器自动化跑打印页的 evaluate/screenshot（会挂住），
 *    要么走本脚本这样的接口层，要么用 browser_snapshot（读无障碍树，不执行页面 JS）。
 *
 * 用法（需先起服务）：
 *   BASE_URL=http://localhost:3002 npx tsx --env-file=.env.test \
 *     scripts/audit/print-matrix-test.ts
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
const PASSWORD = process.env.SEED_PASSWORD ?? 'LocalTest2026!'

interface Case { doc: string; scenario: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (doc: string, scenario: string, ok: boolean, detail: string) =>
  cases.push({ doc, scenario, state: ok ? 'pass' : 'fail', detail })
/**
 * 跳过必须与通过分开计。把「库里没有这种数据所以没测」记成 ✅，
 * 等于让报告替没做过的验证背书 —— 本项目已经在提成（B2）和库存守恒（E3）
 * 上各栽过一次「假性通过」。
 */
const skip = (doc: string, scenario: string, detail: string) =>
  cases.push({ doc, scenario, state: 'skip', detail })

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR, password: PASSWORD }),
  })
  const j = await r.json() as { token?: string; error?: string }
  if (!j.token) throw new Error(`登录失败：${j.error ?? ''}`)
  return j.token
}

async function main() {
  const prisma = createPrismaClient()
  const token = await login()
  const auth = { Authorization: `Bearer ${token}` }
  const num = (v: unknown) => Number(v ?? 0)

  // ── 单据 1：销售单 —— 覆盖 7 种订单状态 ─────────────────────────────────
  const STATES = ['PENDING', 'CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED', 'LOCKED', 'CANCELLED'] as const
  for (const st of STATES) {
    const order = await prisma.order.findFirst({
      where: { status: st, lines: { some: {} } },
      select: {
        id: true, code: true, totalAmount: true,
        lines: { select: { subtotal: true, taxRate: true } },
      },
    })
    if (!order) { skip('销售单', `状态 ${st}`, '库中无「该状态且有明细」的订单 → 本状态未获验证'); continue }

    const r = await fetch(`${BASE}/api/orders/${order.id}`, { headers: auth })
    if (!r.ok) { add('销售单', `状态 ${st}`, false, `接口 ${r.status}`); continue }
    const d = await r.json() as { lines?: unknown[]; totalAmount?: unknown }

    const lineSum = order.lines.reduce((s, l) => s + num(l.subtotal), 0)
    const amountOk = Math.abs(num(order.totalAmount) - lineSum) < 0.02
    // 税率量纲：SSOT 是百分数。0<rate<1 说明是小数，会让 order-pdf 少算 100 倍税
    const badDim = order.lines.filter(l => l.taxRate != null && num(l.taxRate) > 0 && num(l.taxRate) < 1).length
    add('销售单', `状态 ${st}`,
      amountOk && badDim === 0 && (d.lines?.length ?? 0) > 0,
      `${order.code} · ${d.lines?.length ?? 0} 行 · 金额${amountOk ? '一致' : '不符'} · 小数量纲行 ${badDim}`)
  }

  // ── 单据 2-4：行程三单（汇总/配送/签收）—— 覆盖行程状态 ──────────────
  const trips = await prisma.trip.findMany({
    where: { waveId: { not: null } },
    select: { id: true, status: true, driverName: true, waveId: true },
    take: 30,
  })
  const seen = new Set<string>()
  for (const t of trips) {
    if (seen.has(t.status)) continue
    seen.add(t.status)

    const r = await fetch(`${BASE}/api/trips/${t.id}/print-data`, { headers: auth })
    if (!r.ok) { add('行程三单', `状态 ${t.status}`, false, `print-data ${r.status}`); continue }
    const d = await r.json() as {
      trip?: { driverName?: string }
      orders?: Array<{ code?: string; lines?: unknown[] }>
      customers?: unknown[]
    }
    const orders = d.orders ?? []

    // D2 查出的空白问题：有波次却打不出订单
    const wave = await prisma.pickingWave.findUnique({
      where: { id: t.waveId! }, select: { orderIds: true, driverName: true },
    })
    const expected = wave?.orderIds.length ?? 0
    add('司机送货汇总单', `行程状态 ${t.status}`, orders.length > 0 && orders.length === expected,
      `波次 ${expected} 单 → 打印 ${orders.length} 单`)
    add('配送单', `行程状态 ${t.status}`, orders.every(o => (o.lines?.length ?? 0) > 0),
      `${orders.length} 单，每单均有明细行`)
    add('客户签收单', `行程状态 ${t.status}`, (d.customers?.length ?? 0) > 0,
      `${d.customers?.length ?? 0} 个客户分单`)

    // D2 点名的历史坑：司机名必须与波次一致
    add('行程三单', `司机一致性 ${t.status}`,
      (d.trip?.driverName ?? '') === (wave?.driverName ?? ''),
      `行程「${d.trip?.driverName}」 vs 波次「${wave?.driverName}」`)
  }

  // ── 筛选维度：dispatch-print-data 的 4 类筛选 ────────────────────────────
  const anyWave = await prisma.pickingWave.findFirst({
    where: { orderIds: { isEmpty: false } },
    select: { id: true, waveDate: true, driverSlotId: true, orderIds: true },
    orderBy: { waveDate: 'desc' },
  })
  if (anyWave) {
    const date = (anyWave.waveDate ?? new Date()).toISOString().slice(0, 10)
    const filters: Array<[string, string]> = [
      ['无筛选（整日全打）', `date=${date}`],
      ['按波次', `date=${date}&waveIds=${anyWave.id}`],
      ['按线路（司机批次）', `date=${date}&driverSlotId=${anyWave.driverSlotId ?? ''}`],
      ['按日期区间', `date=${date}&fromDate=${date}`],
    ]
    for (const [name, qs] of filters) {
      const r = await fetch(`${BASE}/api/orders/dispatch-print-data?${qs}`, { headers: auth })
      // 404 = 该组合无数据，是合法结果而非故障
      if (r.status === 404) { skip('配送打印筛选', name, '该组合无数据（404 合法，但本筛选未获验证）'); continue }
      if (!r.ok) { add('配送打印筛选', name, false, `HTTP ${r.status}`); continue }
      const d = await r.json() as { orders?: unknown[] }
      add('配送打印筛选', name, Array.isArray(d.orders), `返回 ${d.orders?.length ?? 0} 单`)
    }
    // 边界：不存在的波次 id 应给空/404，不能 500
    const bad = await fetch(`${BASE}/api/orders/dispatch-print-data?date=${date}&waveIds=nonexistent-id`, { headers: auth })
    add('配送打印筛选', '不存在的波次 id', bad.status !== 500, `HTTP ${bad.status}（不得为 500）`)
    // 边界：缺 date 必须 400 而不是崩
    const noDate = await fetch(`${BASE}/api/orders/dispatch-print-data`, { headers: auth })
    add('配送打印筛选', '缺少 date 参数', noDate.status === 400, `HTTP ${noDate.status}（应为 400）`)
  }

  // ── 边界：不存在的单据 ──────────────────────────────────────────────────
  const r404a = await fetch(`${BASE}/api/orders/does-not-exist`, { headers: auth })
  add('边界', '不存在的订单', r404a.status === 404, `HTTP ${r404a.status}`)
  const r404b = await fetch(`${BASE}/api/trips/does-not-exist/print-data`, { headers: auth })
  add('边界', '不存在的行程', r404b.status === 404, `HTTP ${r404b.status}`)

  await prisma.$disconnect()

  // ── 报告 ────────────────────────────────────────────────────────────────
  const groups = new Map<string, Case[]>()
  for (const c of cases) {
    if (!groups.has(c.doc)) groups.set(c.doc, [])
    groups.get(c.doc)!.push(c)
  }
  console.log('\n──── 打印全场景矩阵 ────')
  for (const [doc, list] of groups) {
    console.log(`\n【${doc}】`)
    for (const c of list) {
      const icon = c.state === 'pass' ? '✅' : c.state === 'fail' ? '❌' : '⚠️ '
      console.log(`  ${icon} ${c.scenario.padEnd(22)} ${c.detail}`)
    }
  }
  const failed = cases.filter(c => c.state === 'fail')
  const skipped = cases.filter(c => c.state === 'skip')
  console.log(`\n合计 ${cases.length} 例 · 通过 ${cases.length - failed.length - skipped.length} · 失败 ${failed.length} · ⚠️ 未获验证 ${skipped.length}`)
  if (skipped.length > 0) {
    console.log('\n⚠️ 下列场景因缺少测试数据而**未被验证**，不要当作已通过：')
    for (const c of skipped) console.log(`   · ${c.doc} / ${c.scenario} —— ${c.detail}`)
  }
  if (failed.length > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
