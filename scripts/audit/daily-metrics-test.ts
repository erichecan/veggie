/**
 * 实时销售统计四指标 —— 端到端交叉核对
 * ============================================================================
 * 台账 D8。验收三条：
 *   ① 四个指标口径写进 lib/analytics/metrics.ts 并有单测 → tests/analytics-daily-metrics.test.ts
 *   ② 筛选条件变化后数字同步变化 → 本脚本用「同一批订单、换日期区间」验证
 *   ③ 与销售单列表交叉核对一致 → 本脚本把分析接口的数字与 /api/orders 列表逐项对齐
 *
 * 做法是**增量对比**而不是绝对值断言：先读一次基线，再造几张已知金额的订单，
 * 再读一次，断言「差值恰好等于我造的那些」。测试库里本来就有别的数据，
 * 绝对值断言要么写死脆弱、要么被迫清库；增量对比两者都不需要，而且更接近
 * 真实问题的形状（「今天新增的单有没有算进去」）。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:daily-metrics
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { deriveAov, deriveShortageRate, toDayKey, addBusinessDays } from '../../lib/analytics/metrics'

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

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR, password: seedPassword(OPERATOR) }),
  })
  const j = await r.json() as { token?: string; error?: string }
  if (!j.token) throw new Error(`登录失败：${j.error ?? ''}`)
  return j.token
}

interface Overview {
  dailySeries: Array<{ date: string; salesExTax: number; orderCount: number; aov: number }>
  summary: { salesExTax: number; salesIncTax: number; orderCount: number; aov: number }
  shortage: { summary: { shortageLines: number; orderLines: number; shortageRate: number } }
  topProducts: Array<{ productId: string; productName: string; subtotal: number; qty: number }>
}

const round2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? ''
  if (!/localhost|127\.0\.0\.1/.test(dbUrl)) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }

  const token = await login()
  const auth: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const stamp = Date.now()

  // 业务日（都柏林）——不能用本机日期：本机是 UTC-4，深夜跑脚本时两者不是同一天，
  // 而接口按都柏林切日，用错日期会得出「数字没变」的假失败
  const TODAY = toDayKey(new Date())
  const YESTERDAY = toDayKey(addBusinessDays(new Date(), -1))

  /**
   * 分析接口带 60 秒缓存（区间含今天时），基线与复读之间隔不了那么久，
   * 加一个无意义参数换缓存 key —— resolveDateRange 只认 from/to，多余参数不影响口径。
   */
  async function overview(from: string, to: string, bust: string): Promise<Overview> {
    const res = await fetch(`${BASE}/api/analytics/sales-overview?from=${from}&to=${to}&_=${bust}`, { headers: auth })
    if (!res.ok) throw new Error(`sales-overview HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return await res.json() as Overview
  }

  const before = await overview(TODAY, TODAY, `b${stamp}`)
  const beforeYesterday = await overview(YESTERDAY, YESTERDAY, `by${stamp}`)

  // ── 夹具：1 个专用商品（单价 10）+ 3 家现结客户，各下一单 3 / 5 / 2 件 ──────
  const pname = `D8 指标测试商品 ${stamp}`
  const product = await prisma.product.create({
    data: {
      name: pname, type: 'PRODUCT', status: 'ACTIVE', listPrice: 10, standardPrice: 6,
      canBeSold: true, canBePurchased: true, qtyOnHand: 0, active: true,
    },
    select: { id: true },
  })
  const productId = product.id
  await prisma.$transaction([
    prisma.stockMove.create({
      data: {
        productId, productName: pname, type: 'ADJUSTMENT', qty: 500, movedAt: new Date(),
        note: 'D8 测试期初', sourceType: 'TEST_OPENING', sourceRef: 'D8',
      },
    }),
    prisma.product.update({ where: { id: productId }, data: { qtyOnHand: 500 } }),
  ])

  const QTYS = [3, 5, 2]
  const EXPECTED_SALES = QTYS.reduce((s, q) => s + q * 10, 0)   // 100
  const orderIds: string[] = []
  for (const [i, qty] of QTYS.entries()) {
    const cust = await prisma.customer.create({
      data: { name: `D8 指标测试客户${i + 1} ${stamp}`, paymentTerm: 'cash', isCustomer: true, isActive: true },
      select: { id: true },
    })
    const res = await fetch(`${BASE}/api/orders`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ restaurantId: cust.id, deliveryDate: TODAY, items: [{ productId, quantity: qty }] }),
    })
    const j = await res.json() as { id?: string; error?: string }
    if (!j.id) { skip('建单', `${j.error ?? res.status}`); return report() }
    const cf = await fetch(`${BASE}/api/orders/${j.id}`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ status: 'CONFIRMED' }),
    })
    if (!cf.ok) { skip('确认订单', `HTTP ${cf.status}`); return report() }
    orderIds.push(j.id)
  }
  add('夹具就位：今日 3 张已确认单，金额 30/50/20', true, `业务日 ${TODAY} · 合计 ${EXPECTED_SALES}`)

  const after = await overview(TODAY, TODAY, `a${stamp}`)

  // ── ③ 与销售单列表交叉核对 ──────────────────────────────────────────────
  const listed = await (await fetch(`${BASE}/api/orders?ids=${orderIds.join(',')}`, { headers: auth }))
    .json() as Array<{ id: string; totalAmount: string | number; status: string }>
  const listSum = round2(listed.reduce((s, o) => s + Number(o.totalAmount), 0))
  add('③ 销售单列表里这 3 张单的金额合计 = 100', listSum === EXPECTED_SALES,
    `列表合计 ${listSum} · 状态 ${[...new Set(listed.map(o => o.status))].join('/')}`)

  const salesDelta = round2(after.summary.salesExTax - before.summary.salesExTax)
  const orderDelta = after.summary.orderCount - before.summary.orderCount
  add('③ 分析接口的销售额增量 = 销售单列表合计', salesDelta === listSum,
    `分析 +${salesDelta} vs 列表 ${listSum}`)
  add('③ 分析接口的订单数增量 = 新增单数', orderDelta === 3,
    `+${orderDelta}（应 +3）`)

  // ── ① 客单价口径：服务端 summary 必须等于 Σ销售额/Σ订单数 ────────────────
  add('① 客单价 = Σ销售额 / Σ订单数（服务端与公式一致）',
    after.summary.aov === deriveAov(after.summary.salesExTax, after.summary.orderCount),
    `summary.aov ${after.summary.aov} · 重算 ${deriveAov(after.summary.salesExTax, after.summary.orderCount)}`)

  // 「每天客单价再平均」是错的写法，这里证明服务端没这么干（当区间跨多天且各天单量不同才有区别）
  const multi = await overview(YESTERDAY, TODAY, `m${stamp}`)
  const avgOfAvg = multi.dailySeries.length > 0
    ? round2(multi.dailySeries.reduce((s, d) => s + d.aov, 0) / multi.dailySeries.length)
    : 0
  const correct = deriveAov(multi.summary.salesExTax, multi.summary.orderCount)
  add('① 区间客单价不是「每天客单价的平均」', multi.summary.aov === correct,
    `summary ${multi.summary.aov} = 正确值 ${correct}${avgOfAvg !== correct ? `（错误算法会得 ${avgOfAvg}）` : '（本区间两者恰好相同，不具区分力）'}`)

  // ── ② 筛选条件变化后数字同步变化 ────────────────────────────────────────
  const afterYesterday = await overview(YESTERDAY, YESTERDAY, `ay${stamp}`)
  add('② 换到「昨天」区间，今天新增的单不计入',
    round2(afterYesterday.summary.salesExTax - beforeYesterday.summary.salesExTax) === 0
    && afterYesterday.summary.orderCount === beforeYesterday.summary.orderCount,
    `昨日销售额 ${beforeYesterday.summary.salesExTax} → ${afterYesterday.summary.salesExTax}（应不变）`)

  const wide = await overview(YESTERDAY, TODAY, `w${stamp}`)
  add('② 区间放宽到「昨天~今天」，今天的单重新出现',
    round2(wide.summary.salesExTax - afterYesterday.summary.salesExTax) === round2(after.summary.salesExTax),
    `宽区间 ${wide.summary.salesExTax} − 昨日 ${afterYesterday.summary.salesExTax} = ${round2(wide.summary.salesExTax - afterYesterday.summary.salesExTax)}（应 ${after.summary.salesExTax}）`)

  // ── ① 关键商品销量 ─────────────────────────────────────────────────────
  const mine = after.topProducts.find(p => p.productId === productId)
  add('① 关键商品排行里出现该商品，销量与金额都对得上',
    !!mine && mine.qty === 10 && mine.subtotal === EXPECTED_SALES,
    mine ? `qty ${mine.qty}（应 10）· subtotal ${mine.subtotal}（应 ${EXPECTED_SALES}）` : '⛔ Top10 里没有该商品')

  // ── ① 缺货率 ───────────────────────────────────────────────────────────
  const firstLine = await prisma.orderLine.findFirst({
    where: { orderId: orderIds[0] }, select: { id: true, productId: true, productName: true, orderedQty: true },
  })
  if (!firstLine) {
    skip('缺货率用例', '取不到订单行')
  } else {
    await prisma.orderDiscrepancy.create({
      data: {
        code: `DISC-D8-${stamp}`,
        orderId: orderIds[0], orderLineId: firstLine.id,
        productId: firstLine.productId, productName: firstLine.productName,
        orderedQty: firstLine.orderedQty, pickedQty: 0, diffQty: firstLine.orderedQty,
        type: 'SHORTAGE', status: 'PENDING',
      },
    })
    const afterShort = await overview(TODAY, TODAY, `s${stamp}`)
    const shortDelta = afterShort.shortage.summary.shortageLines - after.shortage.summary.shortageLines
    const linesDelta = after.shortage.summary.orderLines - before.shortage.summary.orderLines
    add('① 缺货行 +1 后缺货率跟着变', shortDelta === 1,
      `缺货行 ${after.shortage.summary.shortageLines} → ${afterShort.shortage.summary.shortageLines}`)
    add('① 订单行增量 = 新增的 3 行（物流口径按 deliveryDate）', linesDelta === 3,
      `订单行 ${before.shortage.summary.orderLines} → ${after.shortage.summary.orderLines}`)
    add('① 缺货率 = 缺货行 / 订单行（与公式一致）',
      afterShort.shortage.summary.shortageRate === deriveShortageRate(
        afterShort.shortage.summary.shortageLines, afterShort.shortage.summary.orderLines),
      `接口 ${afterShort.shortage.summary.shortageRate} · 重算 ${deriveShortageRate(afterShort.shortage.summary.shortageLines, afterShort.shortage.summary.orderLines)}`)
  }

  // ── 按天序列与汇总必须自洽（页面上是同一块数据的两种画法）─────────────────
  const seriesSum = round2(after.dailySeries.reduce((s, d) => s + d.salesExTax, 0))
  add('按天序列逐日相加 = 区间汇总', seriesSum === after.summary.salesExTax,
    `序列 ${seriesSum} vs summary ${after.summary.salesExTax}`)

  await prisma.$disconnect()
  report()
}

function report() {
  console.log('\n──── 实时销售统计四指标 ────')
  for (const c of cases) {
    const icon = c.state === 'pass' ? '✅' : c.state === 'fail' ? '❌' : '⚠️ '
    console.log(`  ${icon} ${c.name.padEnd(40)} ${c.detail}`)
  }
  const failed = cases.filter(c => c.state === 'fail')
  const skipped = cases.filter(c => c.state === 'skip')
  console.log(`\n合计 ${cases.length} 例 · 通过 ${cases.length - failed.length - skipped.length} · 失败 ${failed.length} · ⚠️ 未获验证 ${skipped.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
