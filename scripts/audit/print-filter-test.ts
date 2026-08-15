/**
 * 打印筛选（客户 / 线路 / 商品）—— 端到端实证
 * ============================================================================
 * 台账 D3。验收：「三个维度可单选可组合；筛选结果条数与预览一致；筛选后打印的份数与预期相符」。
 *
 * 三件事必须分别证明，只证其一都会漏掉真问题：
 *   ① 三维**各自**能筛，且**任意组合**是交集 —— 单维过了不代表组合过；
 *   ② **预览与打印是同一个结果** —— 本脚本按打印中心的取数方式（/api/waves +
 *      /api/orders?include_lines）在本地跑一遍 print-filters 纯函数当作「预览」，
 *      再与 /api/orders/dispatch-print-data 服务端返回的条数逐一比对。两条路径
 *      的数据来源不同（客户端已加载的订单 vs 服务端重新查库），对得上才有意义；
 *   ③ **PDF 两个路由也真的认这两个参数** —— 参数解析原先在三处各抄一遍，
 *      漏改的表现是「屏幕上筛了、打出来是全量」，不会报错，只会打错纸。
 *      这里用「筛一个必然空集 → 必须 404」来证明筛选确实作用到了 PDF 路由上。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npx tsx --env-file=.env.test scripts/audit/print-filter-test.ts
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { applyPrintContentFilter } from '../../lib/print/print-filters'
import { generateTripPickingHtml } from '../../lib/print/trip-picking-template'
import { generateTripSalesHtml } from '../../lib/print/trip-sales-template'
import { toMemoryShape, type TripPrintDataWire } from '../../lib/print/trip-common'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
// 口令收口在 _seed-credentials.ts —— 此前 26 个脚本各写一遍字面量，改一个账号要改 26 处
import { seedPassword } from './_seed-credentials'
/** 挑一个远离种子数据的配送日，避免与既有波次混在一起影响计数 */
const DATE = process.env.D3_DATE ?? '2026-12-01'

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

type Auth = Record<string, string>

interface PreviewOrder {
  id: string
  restaurantId: string
  restaurantName: string
  totalAmount: string | number
  lines?: Array<{ productId: string; subtotal: string | number }>
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? ''
  if (!/localhost|127\.0\.0\.1/.test(dbUrl)) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }

  const token = await login()
  const auth: Auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const get = async (path: string) => fetch(`${BASE}${path}`, { headers: auth })
  const getJson = async <T>(path: string): Promise<T> => (await get(path)).json() as Promise<T>

  // ── 造两个专用商品：不用既有商品，否则别的订单里也有它，条数不可控 ──────────
  const stamp = Date.now()
  const productIds: string[] = []
  const productNames: string[] = []
  for (const tag of ['X', 'Y']) {
    const name = `D3 筛选测试商品${tag} ${stamp}`
    const tmpl = await prisma.productTemplate.create({
      data: {
        name, type: 'PRODUCT', status: 'ACTIVE', listPrice: 10, standardPrice: 6,
        canBeSold: true, canBePurchased: true,
        products: { create: [{ name, listPrice: 10, standardPrice: 6, qtyOnHand: 0, active: true, status: 'ACTIVE' }] },
      },
      select: { products: { select: { id: true }, take: 1 } },
    })
    const pid = tmpl.products[0]!.id
    // 期初库存连流水一起写：直接塞 qtyOnHand 会破坏 qtyOnHand == ΣStockMove
    // （周期 25、26 各踩过一次，那是测试数据的缺陷，不是产品缺陷）
    await prisma.$transaction([
      prisma.stockMove.create({
        data: {
          productId: pid, productName: name, type: 'ADJUSTMENT', qty: 1000,
          movedAt: new Date(), note: 'D3 测试期初', sourceType: 'TEST_OPENING', sourceRef: 'D3',
        },
      }),
      prisma.product.update({ where: { id: pid }, data: { qtyOnHand: 1000 } }),
    ])
    productIds.push(pid)
    productNames.push(name)
  }
  const [PX, PY] = productIds

  // 自建 3 个现结客户，而不是借用既有客户：本库 1324/1331 是月结，只要有一张逾期
  // POSTED 发票下单就会被信用冻结挡在 403（第一版就是这么失败的）。
  // 条数断言依赖「这 4 张单就是全部」，借来的客户身上挂着历史单据会把计数搅乱。
  const customers: Array<{ id: string; name: string }> = []
  for (const tag of ['甲', '乙', '丙']) {
    customers.push(await prisma.customer.create({
      data: { name: `D3 筛选测试客户${tag} ${stamp}`, paymentTerm: 'cash', isCustomer: true, isActive: true },
      select: { id: true, name: true },
    }))
  }
  const [c1, c2, c3] = customers

  // ── 四张单，刻意让每一维都能切出不同的子集 ──────────────────────────────
  //   波次 A：单1 = c1[X,Y]   单2 = c2[X]
  //   波次 B：单3 = c3[Y]     单4 = c1[X]
  const spec: Array<{ cust: { id: string; name: string }; items: string[] }> = [
    { cust: c1, items: [PX, PY] },
    { cust: c2, items: [PX] },
    { cust: c3, items: [PY] },
    { cust: c1, items: [PX] },
  ]
  const orderIds: string[] = []
  for (const s of spec) {
    const res = await fetch(`${BASE}/api/orders`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        restaurantId: s.cust.id,
        deliveryDate: DATE,
        items: s.items.map(pid => ({ productId: pid, quantity: 5 })),
      }),
    })
    const j = await res.json() as { id?: string; error?: string }
    if (!j.id) { skip('建单', `${s.cust.name}: ${j.error ?? res.status}`); return report() }
    // 走真实确认路径（会正常扣库存），而不是直接改 status
    const cf = await fetch(`${BASE}/api/orders/${j.id}`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ status: 'CONFIRMED' }),
    })
    if (!cf.ok) { skip('确认订单', `HTTP ${cf.status}: ${(await cf.text()).slice(0, 160)}`); return report() }
    orderIds.push(j.id)
  }
  add('夹具就位：4 张单 / 3 客户 / 2 商品', true,
    `${spec.map((s, i) => `单${i + 1}=${s.cust.name.slice(0, 8)}[${s.items.map(p => p === PX ? 'X' : 'Y').join(',')}]`).join(' · ')}`)

  // ── 两个波次（= 两条线路）：建空波次 → assign（会回写 deliveryDate）→ 标记分配完成 ──
  const waveIds: string[] = []
  for (const [i, drv] of [['am', `D3 司机甲 ${stamp}`], ['pm', `D3 司机乙 ${stamp}`]].entries()) {
    const res = await fetch(`${BASE}/api/waves`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ waveDate: `${DATE}T00:00:00.000Z`, timeOfDay: drv[0], driverName: drv[1], orderIds: [] }),
    })
    const w = await res.json() as { id?: string; error?: string }
    if (!w.id) { skip('建波次', `${w.error ?? res.status}`); return report() }
    const mine = i === 0 ? orderIds.slice(0, 2) : orderIds.slice(2)
    const asg = await fetch(`${BASE}/api/waves/${w.id}/assign`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ orderIds: mine }),
    })
    if (!asg.ok) { skip('分配订单到波次', `HTTP ${asg.status}: ${(await asg.text()).slice(0, 160)}`); return report() }
    await fetch(`${BASE}/api/waves/${w.id}/assignment-done`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ done: true }),
    })
    waveIds.push(w.id)
  }
  const [WA, WB] = waveIds
  add('两条线路就位（波次 A/B 各 2 单）', true, `A=${WA.slice(-6)} · B=${WB.slice(-6)}`)

  // ── 预览侧：完全按打印中心的取数方式重来一遍 ────────────────────────────
  // （/api/waves?date → 可见波次 → /api/orders?include_lines&ids）
  const wavesOfDay = await getJson<Array<{ id: string; orderIds: string[]; assignmentDoneAt: string | null; completedAt: string | null }>>(
    `/api/waves?date=${DATE}`,
  )
  const visibleWaves = wavesOfDay.filter(w => w.assignmentDoneAt != null && !w.completedAt)
  const visibleOrderIds = [...new Set(visibleWaves.flatMap(w => w.orderIds))]
  const previewOrders = await getJson<PreviewOrder[]>(
    `/api/orders?include_lines=true&ids=${visibleOrderIds.join(',')}`,
  )
  add('预览取数与打印中心一致', visibleWaves.length >= 2 && previewOrders.length >= 4,
    `可见波次 ${visibleWaves.length} · 订单 ${previewOrders.length}`)

  /** 打印中心的预览计数：同一段 print-filters 纯函数 */
  function previewCount(waves: string[], customerIds: string[], products: string[]) {
    const inWaves = new Set(
      visibleWaves.filter(w => waves.includes(w.id)).flatMap(w => w.orderIds),
    )
    const scoped = previewOrders
      .filter(o => inWaves.has(o.id))
      .map(o => ({ ...o, customerId: o.restaurantId, lines: o.lines ?? [] }))
    const kept = applyPrintContentFilter(scoped, { customerIds, productIds: products })
    return { orders: kept.length, lines: kept.reduce((s, o) => s + o.lines.length, 0) }
  }

  /** 打印侧：服务端 loader 重新查库的结果 */
  async function printData(waves: string[], customerIds: string[], products: string[]) {
    const p = new URLSearchParams({ date: DATE, waveIds: waves.join(',') })
    if (customerIds.length) p.set('customerIds', customerIds.join(','))
    if (products.length) p.set('productIds', products.join(','))
    const res = await get(`/api/orders/dispatch-print-data?${p}`)
    if (res.status === 404) return { status: 404, orders: 0, lines: 0, wire: null }
    const wire = await res.json() as TripPrintDataWire
    return {
      status: res.status,
      orders: wire.orders?.length ?? 0,
      lines: (wire.orders ?? []).reduce((s, o) => s + o.lines.length, 0),
      wire,
    }
  }

  // ── ① 三维单选 + 组合，每一例都同时比对「预览 == 打印」和「== 预期」 ──────
  const AB = [WA, WB]
  const combos: Array<{ name: string; waves: string[]; cust: string[]; prod: string[]; expect: number }> = [
    { name: '不筛（基线）', waves: AB, cust: [], prod: [], expect: 4 },
    { name: '仅线路：波次 A', waves: [WA], cust: [], prod: [], expect: 2 },
    { name: '仅客户：c1', waves: AB, cust: [c1.id], prod: [], expect: 2 },
    { name: '仅客户：c1+c2', waves: AB, cust: [c1.id, c2.id], prod: [], expect: 3 },
    { name: '仅商品：Y', waves: AB, cust: [], prod: [PY], expect: 2 },
    { name: '仅商品：X', waves: AB, cust: [], prod: [PX], expect: 3 },
    { name: '组合 线路+客户', waves: [WA], cust: [c1.id], prod: [], expect: 1 },
    { name: '组合 线路+商品', waves: [WB], cust: [], prod: [PX], expect: 1 },
    { name: '组合 客户+商品', waves: AB, cust: [c1.id], prod: [PY], expect: 1 },
    { name: '三维组合', waves: [WA], cust: [c1.id], prod: [PX], expect: 1 },
    { name: '组合到空集', waves: AB, cust: [c2.id], prod: [PY], expect: 0 },
  ]

  for (const c of combos) {
    const pv = previewCount(c.waves, c.cust, c.prod)
    const pd = await printData(c.waves, c.cust, c.prod)
    const ok = pv.orders === c.expect && pd.orders === c.expect
    add(`${c.name}`, ok,
      `预期 ${c.expect} 单 · 预览 ${pv.orders} · 打印 ${pd.orders}${c.expect === 0 ? `（HTTP ${pd.status}，应为 404）` : ''}`)
    if (pv.orders !== pd.orders) {
      add(`  └ 预览与打印条数一致（${c.name}）`, false, `⛔ 预览 ${pv.orders} ≠ 打印 ${pd.orders}`)
    }
  }
  add('预览与打印逐例一致', cases.every(x => !x.name.startsWith('  └')),
    `${combos.length} 个组合，条数两侧全部相等`)

  // ── ② 商品筛选下行级也要真的被砍掉，且金额按剩余行重算 ────────────────────
  const onlyY = await printData(AB, [], [PY])
  const yLines = (onlyY.wire?.orders ?? []).flatMap(o => o.lines)
  add('商品筛选砍到行级', yLines.length > 0 && yLines.every(l => l.productId === PY),
    `剩余 ${yLines.length} 行，全部为商品 Y`)

  const mixOrder = (onlyY.wire?.orders ?? []).find(o => o.customerId === c1.id)
  const mixExpected = (mixOrder?.lines ?? []).reduce((s, l) => s + Number(l.subtotal), 0)
  add('订单金额按剩余行重算（汇总单读的就是这个字段）',
    !!mixOrder && Math.abs(Number(mixOrder.totalAmount) - mixExpected) < 0.005,
    mixOrder ? `单1 金额 ${Number(mixOrder.totalAmount).toFixed(2)} == 剩余行合计 ${mixExpected.toFixed(2)}（未筛时该单是两行）` : '⛔ 没找到 c1 的单',
  )

  // ── ③ 纸面：只出现所选商品，且必须写明「这是部分内容」 ──────────────────
  if (onlyY.wire) {
    const data = toMemoryShape(onlyY.wire)
    const picking = generateTripPickingHtml(data)
    const sales = generateTripSalesHtml(data)
    add('拣货单纸面只出现所选商品',
      picking.includes(productNames[1]) && !picking.includes(productNames[0]),
      `含「商品Y」=${picking.includes(productNames[1])} · 含「商品X」=${picking.includes(productNames[0])}（应为 false）`)
    add('拣货单印出「按筛选打印」提示', picking.includes('非该批次全部内容'),
      picking.includes('非该批次全部内容') ? '黄色提示条已渲染' : '⛔ 拣货单没有提示，仓库会当成整车全部')
    add('销售单印出「按筛选打印」提示', sales.includes('非该批次全部内容'),
      sales.includes('非该批次全部内容') ? '黄色提示条已渲染' : '⛔ 缺提示')
  } else {
    skip('纸面断言', '取不到筛选后的打印数据')
  }

  // ── ④ 两个 PDF 路由是否也真的认这两个参数 ───────────────────────────────
  // 正例只能证明「能出 PDF」，不能证明筛选起了作用；用必然空集的筛选看是否 404，
  // 才能区分「参数生效」与「参数被忽略」。
  const impossible = `customerIds=${c2.id}&productIds=${PY}`
  for (const [label, path] of [
    ['拣货单 PDF', `/api/print/dispatch-picking-pdf?date=${DATE}&waveIds=${AB.join(',')}`],
    ['汇总单 PDF', `/api/print/dispatch-summary-pdf?date=${DATE}&waveIds=${AB.join(',')}`],
  ] as const) {
    const full = await get(path)
    const fullBytes = (await full.arrayBuffer()).byteLength
    const filtered = await get(`${path}&${impossible}`)
    add(`${label} 认筛选参数`, full.status === 200 && fullBytes > 1000 && filtered.status === 404,
      `不筛 HTTP ${full.status}/${fullBytes} 字节 · 空集筛选 HTTP ${filtered.status}（应 404，若 200 说明参数被忽略）`)
  }

  // ── ⑤ 未知 id 不该 500 ──────────────────────────────────────────────────
  const bogus = await get(`/api/orders/dispatch-print-data?date=${DATE}&waveIds=${AB.join(',')}&customerIds=BOGUS-NOT-A-CUSTOMER`)
  add('未知客户 id 返回 404 而非 500', bogus.status === 404, `HTTP ${bogus.status}`)

  await prisma.$disconnect()
  report()
}

function report() {
  console.log('\n──── 打印筛选：客户 / 线路 / 商品 ────')
  for (const c of cases) {
    const icon = c.state === 'pass' ? '✅' : c.state === 'fail' ? '❌' : '⚠️ '
    console.log(`  ${icon} ${c.name.padEnd(34)} ${c.detail}`)
  }
  const failed = cases.filter(c => c.state === 'fail')
  const skipped = cases.filter(c => c.state === 'skip')
  console.log(`\n合计 ${cases.length} 例 · 通过 ${cases.length - failed.length - skipped.length} · 失败 ${failed.length} · ⚠️ 未获验证 ${skipped.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
