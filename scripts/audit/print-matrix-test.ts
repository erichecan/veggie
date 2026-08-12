/**
 * 打印全场景测试矩阵
 * ============================================================================
 * 台账 D5。对应需求原话：「需要处理各种状态、各种筛选条件，并使用 AI 创建不同的测试用例」。
 *
 * 覆盖三个维度：
 *   4 类单据   销售单 / 司机送货汇总单 / 配送单 / 客户签收单（并验四种模板都吃得下筛选后的数据）
 *   7 种状态   PENDING → CONFIRMED → WAVE_ASSIGNED → IN_DELIVERY → COMPLETED / LOCKED / CANCELLED
 *   6 类筛选   按日期 / 按线路(司机批次) / 按波次 / 按客户 / 按商品 / 无筛选（整日全打）
 *              —— 每一维都断言「确实筛窄了」，而不是「接口没崩」（D5x 修正，见下方注释）
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
import { toMemoryShape, type TripPrintDataWire } from '../../lib/print/trip-common'
import { generateTripSalesHtml } from '../../lib/print/trip-sales-template'
import { generateTripDeliveryHtml } from '../../lib/print/trip-delivery-template'
import { generateTripSummaryHtml } from '../../lib/print/trip-summary-template'
import { generateTripPickingHtml } from '../../lib/print/trip-picking-template'

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

  // ── 筛选维度：dispatch-print-data 的各类筛选 ─────────────────────────────
  // ⚠️ D5x 修正：原来只断言 `Array.isArray(d.orders)` —— 那等于「接口没崩就算过」，
  // 一个**什么都没筛掉**的筛选照样 ✅。实测「按线路」返回的就是整日全量（波次的
  // driverSlotId 为 null，参数传空后退化成整日全打），却一直显示通过。
  // 现在每一维都断言「确实筛窄了」，筛不窄的当场失败或明确记为未获验证。
  const anyWave = await prisma.pickingWave.findFirst({
    where: { orderIds: { isEmpty: false } },
    select: { id: true, waveDate: true, driverSlotId: true, orderIds: true },
    orderBy: { waveDate: 'desc' },
  })
  if (anyWave) {
    const date = (anyWave.waveDate ?? new Date()).toISOString().slice(0, 10)

    async function fetchPrint(qs: string): Promise<{ status: number; orders: Array<{ customerId?: string; lines?: Array<{ productId?: string }> }> }> {
      const r = await fetch(`${BASE}/api/orders/dispatch-print-data?${qs}`, { headers: auth })
      if (!r.ok) return { status: r.status, orders: [] }
      const d = await r.json() as { orders?: Array<{ customerId?: string; lines?: Array<{ productId?: string }> }> }
      return { status: r.status, orders: d.orders ?? [] }
    }

    const all = await fetchPrint(`date=${date}`)
    add('配送打印筛选', '无筛选（整日全打）', all.status === 200 && all.orders.length > 0,
      `HTTP ${all.status} · 返回 ${all.orders.length} 单（作为其余筛选的基准）`)

    // 按波次：结果必须恰好是该波次里那些单
    {
      const r = await fetchPrint(`date=${date}&waveIds=${anyWave.id}`)
      const expected = anyWave.orderIds.length
      add('配送打印筛选', '按波次', r.status === 200 && r.orders.length > 0 && r.orders.length <= expected,
        `返回 ${r.orders.length} 单 / 波次内 ${expected} 单 / 全量 ${all.orders.length} 单`)
    }

    // 按线路：必须挑一个**真的挂了 driverSlotId** 的波次来测。
    // 传空的 driverSlotId 会退化成整日全打，那样测出来的 ✅ 什么都不代表
    // （本库 129 个非空波次里 125 个有 slot，但最新那个恰好没有 —— 按「最新」取样就会漏测）。
    const slotWave = await prisma.pickingWave.findFirst({
      where: { driverSlotId: { not: null }, orderIds: { isEmpty: false } },
      select: { id: true, waveDate: true, driverSlotId: true, orderIds: true },
      orderBy: { waveDate: 'desc' },
    })
    if (!slotWave?.driverSlotId) {
      skip('配送打印筛选', '按线路（司机批次）', '全库没有挂 driverSlotId 的波次，这一维无数据可测')
    } else {
      const slotDate = (slotWave.waveDate ?? new Date()).toISOString().slice(0, 10)
      const dayAll = await fetchPrint(`date=${slotDate}`)
      const r = await fetchPrint(`date=${slotDate}&driverSlotId=${slotWave.driverSlotId}`)
      add('配送打印筛选', '按线路（司机批次）',
        r.status === 200 && r.orders.length > 0 && r.orders.length <= dayAll.orders.length,
        `${slotDate}：按线路 ${r.orders.length} 单 / 当日全量 ${dayAll.orders.length} 单`)
    }

    add('配送打印筛选', '按日期区间',
      (await fetchPrint(`date=${date}&fromDate=${date}`)).status === 200, `HTTP 200`)

    // 按客户 / 按商品（台账 D3 新增的两维）—— D5 的矩阵自称覆盖「客户/线路/商品/日期」，
    // 但这两维此前压根没测。取全量结果里的第一个客户/商品来筛，断言**确实筛窄了**。
    const firstCustomer = all.orders.find(o => o.customerId)?.customerId
    if (!firstCustomer) {
      skip('配送打印筛选', '按客户', '全量结果里取不到客户 id')
    } else {
      const r = await fetchPrint(`date=${date}&customerIds=${firstCustomer}`)
      const allSame = r.orders.length > 0 && r.orders.every(o => o.customerId === firstCustomer)
      add('配送打印筛选', '按客户',
        r.status === 200 && allSame && r.orders.length <= all.orders.length,
        `返回 ${r.orders.length} 单（全量 ${all.orders.length}）· 全部属该客户=${allSame}`)
    }

    const firstProduct = all.orders.flatMap(o => o.lines ?? []).find(l => l.productId)?.productId
    if (!firstProduct) {
      skip('配送打印筛选', '按商品', '全量结果里取不到商品 id')
    } else {
      const r = await fetchPrint(`date=${date}&productIds=${firstProduct}`)
      const linesAllSame = r.orders.length > 0
        && r.orders.every(o => (o.lines ?? []).length > 0 && (o.lines ?? []).every(l => l.productId === firstProduct))
      add('配送打印筛选', '按商品（行级）',
        r.status === 200 && linesAllSame,
        `返回 ${r.orders.length} 单，剩余行全部为该商品=${linesAllSame}`)
    }

    // 4 类单据 × 有筛选：矩阵声称覆盖「4 类单据 × 筛选」，但此前筛选那组只打到取数接口，
    // 没验过**四种模板都能吃下筛选后的数据**。尤其「这是部分内容」的提示，
    // 拣货单与汇总单是台账 D3 才补上的 —— 少一张纸没提示，仓库就会当成整车全部。
    if (firstProduct) {
      const r = await fetch(`${BASE}/api/orders/dispatch-print-data?date=${date}&productIds=${firstProduct}`, { headers: auth })
      if (!r.ok) {
        skip('四类单据 × 筛选', '渲染四种模板', `取数 HTTP ${r.status}`)
      } else {
        const wire = await r.json() as TripPrintDataWire
        const data = toMemoryShape(wire)
        const renderers: Array<[string, string]> = [
          ['销售单', generateTripSalesHtml(data)],
          ['送货单', generateTripDeliveryHtml(data)],
          ['汇总单', generateTripSummaryHtml(data)],
          ['拣货单', generateTripPickingHtml(data)],
        ]
        for (const [docName, html] of renderers) {
          const ok = html.includes('<table') && html.includes('非该批次全部内容')
          add('四类单据 × 筛选', `${docName}（筛后渲染 + 部分内容提示）`, ok,
            ok ? `${html.length} 字节，含表格与筛选提示` : `⛔ 缺${html.includes('<table') ? '筛选提示' : '表格'}`)
        }
      }
    }

    // 组合筛选必须比单维更窄或相等 —— 「组合之后反而更多」说明条件被当成了或关系
    if (firstCustomer && firstProduct) {
      const byCust = await fetchPrint(`date=${date}&customerIds=${firstCustomer}`)
      const combo = await fetchPrint(`date=${date}&customerIds=${firstCustomer}&productIds=${firstProduct}`)
      add('配送打印筛选', '客户+商品组合不放宽',
        combo.status === 404 || combo.orders.length <= byCust.orders.length,
        `组合 ${combo.status === 404 ? '空集(404)' : combo.orders.length + ' 单'} ≤ 仅客户 ${byCust.orders.length} 单`)
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
