/**
 * 缺货批量改单 / 转单 —— 端到端实证
 * ============================================================================
 * 台账 D6。验收四条，逐条对应本脚本的分组：
 *   ① 录入一个缺货商品 → 立即列出全部受影响订单与行
 *   ② 可勾选批量改量 / 转单
 *   ③ 每次操作写入缺货原因并可追溯
 *   ④ 已锁定的单被正确拦截
 *
 * 「正确拦截」的口径（本周期定死，见 bulk-adjust 路由文件头）：
 *   拣货锁下 **减量/删行放行、加量拦截**。拣货锁是打印拣货单时自动上的，
 *   而缺货正是拣货时发现的 —— 彻底锁死等于让缺货 tab 没法用。
 *   所以这里要同时证明「该放的放了」和「该拦的拦了」，只测一边都是自欺。
 *
 * 另有一条不属于验收但必须守住的底线：改量后**库存仍守恒**（qtyOnHand == ΣStockMove）。
 * 缺货路径此前只改 qtyOnHand 不写流水，本脚本对受影响商品逐个复核。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:shortage-bulk
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
// 口令收口在 _seed-credentials.ts —— 此前 26 个脚本各写一遍字面量，改一个账号要改 26 处
import { seedPassword } from './_seed-credentials'
const DATE = process.env.D6_DATE ?? '2026-12-05'

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

/** 单个商品是否守恒：qtyOnHand == Σ StockMove.qty */
async function stockConserved(productId: string): Promise<{ ok: boolean; onHand: number; moved: number }> {
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { qtyOnHand: true } })
  const agg = await prisma.stockMove.aggregate({ where: { productId }, _sum: { qty: true } })
  const onHand = Number(p?.qtyOnHand ?? 0)
  const moved = Number(agg._sum.qty ?? 0)
  return { ok: Math.abs(onHand - moved) < 0.001, onHand, moved }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? ''
  if (!/localhost|127\.0\.0\.1/.test(dbUrl)) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }

  const token = await login()
  const auth: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const stamp = Date.now()

  // ── 夹具：1 个缺货商品 + 1 个不缺的对照商品；3 家现结客户各一张单 ──────────
  const products: Array<{ id: string; name: string }> = []
  for (const tag of ['缺货品', '对照品']) {
    const name = `D6 ${tag} ${stamp}`
    const product = await prisma.product.create({
      data: {
        name, type: 'PRODUCT', status: 'ACTIVE', listPrice: 10, standardPrice: 6,
        canBeSold: true, canBePurchased: true, qtyOnHand: 0, active: true,
      },
      select: { id: true },
    })
    const pid = product.id
    // 期初库存连流水一起写，否则夹具自己就不守恒（周期 25/26 的教训）
    await prisma.$transaction([
      prisma.stockMove.create({
        data: {
          productId: pid, productName: name, type: 'ADJUSTMENT', qty: 1000, movedAt: new Date(),
          note: 'D6 测试期初', sourceType: 'TEST_OPENING', sourceRef: 'D6',
        },
      }),
      prisma.product.update({ where: { id: pid }, data: { qtyOnHand: 1000 } }),
    ])
    products.push({ id: pid, name })
  }
  const [SHORT, CTRL] = products

  const customers: Array<{ id: string; name: string }> = []
  for (const tag of ['甲', '乙', '丙']) {
    customers.push(await prisma.customer.create({
      data: { name: `D6 缺货测试客户${tag} ${stamp}`, paymentTerm: 'cash', isCustomer: true, isActive: true },
      select: { id: true, name: true },
    }))
  }

  const orderIds: string[] = []
  for (const c of customers) {
    const res = await fetch(`${BASE}/api/orders`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        restaurantId: c.id, deliveryDate: DATE,
        items: [
          { productId: SHORT.id, quantity: 10 },
          { productId: CTRL.id, quantity: 4 },
        ],
      }),
    })
    const j = await res.json() as { id?: string; error?: string }
    if (!j.id) { skip('建单', `${c.name}: ${j.error ?? res.status}`); return report() }
    const cf = await fetch(`${BASE}/api/orders/${j.id}`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ status: 'CONFIRMED' }),
    })
    if (!cf.ok) { skip('确认订单', `HTTP ${cf.status}`); return report() }
    orderIds.push(j.id)
  }
  add('夹具就位：3 张已确认单，每单 10 个缺货品 + 4 个对照品', true, `订单 ${orderIds.length} 张`)

  const stockAfterConfirm = await prisma.product.findUnique({ where: { id: SHORT.id }, select: { qtyOnHand: true } })
  add('确认扣库存正常', Number(stockAfterConfirm?.qtyOnHand) === 970,
    `1000 − 3×10 = ${Number(stockAfterConfirm?.qtyOnHand)}（应 970）`)

  // ── ① 录一个缺货商品即列出全部受影响订单行 ──────────────────────────────
  // 缺货 tab 的取数就是这个查询（同一 URL），只是它在浏览器里跑
  const listed = await (await fetch(
    `${BASE}/api/orders?include_lines=true&status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY&dateField=deliveryDate&fromDate=${DATE}&toDate=${DATE}`,
    { headers: auth },
  )).json() as Array<{ id: string; lines?: Array<{ id: string; productId: string; orderedQty: string | number }> }>
  const mine = listed.filter(o => orderIds.includes(o.id))
  const shortLines = mine.flatMap(o => (o.lines ?? [])
    .filter(l => l.productId === SHORT.id)
    .map(l => ({ orderId: o.id, lineId: l.id, qty: Number(l.orderedQty) })))
  add('① 录入缺货商品即列出全部受影响订单行', shortLines.length === 3,
    `受影响行 ${shortLines.length}（应 3，每单一行）`)

  // ── ③ 原因是硬要求：不给就 400 ────────────────────────────────────────
  const noReason = await fetch(`${BASE}/api/daily-sales/shortage/bulk-adjust`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ mode: 'ADJUST', items: [{ ...shortLines[0], newQty: 5 }] }),
  })
  add('③ 不填原因被拒（400）', noReason.status === 400, `HTTP ${noReason.status}`)

  const bogusReason = await fetch(`${BASE}/api/daily-sales/shortage/bulk-adjust`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ mode: 'ADJUST', reasonCode: 'NOT_A_REASON', items: [{ ...shortLines[0], newQty: 5 }] }),
  })
  add('③ 伪造的原因代码同样被拒', bogusReason.status === 400, `HTTP ${bogusReason.status}`)

  // ── ② 批量改量：一次提交两张单 ──────────────────────────────────────────
  const adjustRes = await (await fetch(`${BASE}/api/daily-sales/shortage/bulk-adjust`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      mode: 'ADJUST', reasonCode: 'SUPPLIER_SHORT', reasonNote: '供应商今早只到一半',
      items: [
        { orderId: shortLines[0].orderId, lineId: shortLines[0].lineId, newQty: 6 },
        { orderId: shortLines[1].orderId, lineId: shortLines[1].lineId, newQty: 0 },
      ],
    }),
  })).json() as { applied: Array<{ oldQty: number; newQty: number }>; blocked: unknown[] }
  add('② 批量改量一次提交两行', adjustRes.applied?.length === 2 && adjustRes.blocked?.length === 0,
    `applied ${adjustRes.applied?.length ?? 0} · blocked ${adjustRes.blocked?.length ?? 0}`)

  const line0 = await prisma.orderLine.findUnique({ where: { id: shortLines[0].lineId }, select: { orderedQty: true, subtotal: true } })
  const line1 = await prisma.orderLine.findUnique({ where: { id: shortLines[1].lineId } })
  add('② 改量落库且小计跟着重算', Number(line0?.orderedQty) === 6 && Number(line0?.subtotal) === 60,
    `数量 ${Number(line0?.orderedQty)} · 小计 ${Number(line0?.subtotal)}（10×6=60）`)
  add('② 改成 0 即删行', line1 === null, line1 === null ? '该行已删除' : '⛔ 行仍在')

  const order1 = await prisma.order.findUnique({ where: { id: shortLines[1].orderId }, select: { totalAmount: true } })
  add('② 订单合计随之重算', Number(order1?.totalAmount) === 40,
    `删掉 10×10 后剩对照品 4×10 = ${Number(order1?.totalAmount)}（应 40）`)

  // ⚠️ 关键底线：改量后库存必须仍守恒
  const consAdjust = await stockConserved(SHORT.id)
  add('改量后库存仍守恒（qtyOnHand == ΣStockMove）', consAdjust.ok,
    `qtyOnHand ${consAdjust.onHand} vs Σ流水 ${consAdjust.moved}${consAdjust.ok ? '' : ' ⛔ 只改了库存没记流水'}`)
  add('改量释放的库存数额正确', consAdjust.onHand === 970 + 4 + 10,
    `970 + 4(改 10→6) + 10(删行) = ${consAdjust.onHand}（应 984）`)

  // ── ③ 原因可追溯：操作记录 + 订单 chatter 两条轨迹都要有 ──────────────────
  const logs = await prisma.actionLog.findMany({
    where: { resource: 'order', resourceId: shortLines[0].orderId },
    orderBy: { createdAt: 'desc' }, take: 5, select: { detail: true },
  })
  const hasReasonInLog = logs.some(l => l.detail?.includes('原因：供应商缺货') && l.detail.includes('供应商今早只到一半'))
  add('③ 原因写进操作记录（缺货 tab 那个面板读的就是它）', hasReasonInLog,
    hasReasonInLog ? logs[0]?.detail?.slice(0, 60) ?? '' : `⛔ 最近一条：${logs[0]?.detail ?? '(无)'}`)

  const auditRows = await prisma.orderAuditLog.findMany({
    where: { orderId: shortLines[0].orderId, action: 'shortage_adjust' },
    orderBy: { createdAt: 'desc' }, take: 1,
  })
  const changed = auditRows[0]?.changedFields as { reasonCode?: string; oldQty?: number; newQty?: number } | undefined
  add('③ 原因同时以结构化形式进订单审计（chatter 可见）',
    changed?.reasonCode === 'SUPPLIER_SHORT' && changed?.oldQty === 10 && changed?.newQty === 6,
    `changedFields = ${JSON.stringify(changed ?? null).slice(0, 120)}`)

  // ── ② 转单到次日 ───────────────────────────────────────────────────────
  const deferRes = await (await fetch(`${BASE}/api/daily-sales/shortage/bulk-adjust`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      mode: 'DEFER', reasonCode: 'QUALITY', reasonNote: '到货一半发霉',
      items: [{ orderId: shortLines[2].orderId, lineId: shortLines[2].lineId, newQty: 4 }],
    }),
  })).json() as {
    applied: Array<{ deferredQty?: number; deferOrderId?: string; deferOrderCode?: string }>
    blocked: unknown[]
    deferOrders: Array<{ code: string; date: string }>
  }
  const deferOrderId = deferRes.applied?.[0]?.deferOrderId
  add('② 转单到次日：今日行减到 4，差额 6 转出', deferRes.applied?.[0]?.deferredQty === 6 && !!deferOrderId,
    `deferredQty ${deferRes.applied?.[0]?.deferredQty} · 新单 ${deferRes.applied?.[0]?.deferOrderCode ?? '—'}`)

  if (!deferOrderId) {
    skip('转单结果核对', '没拿到次日单 id')
  } else {
    const deferOrder = await prisma.order.findUnique({
      where: { id: deferOrderId },
      select: { status: true, deliveryDate: true, restaurantId: true, totalAmount: true, internalNote: true, lines: true },
    })
    const dLine = deferOrder?.lines.find(l => l.productId === SHORT.id)
    add('② 次日单：日期 = 原配送日 + 1 天',
      deferOrder?.deliveryDate?.toISOString().slice(0, 10) === '2026-12-06',
      `deliveryDate = ${deferOrder?.deliveryDate?.toISOString().slice(0, 10)}`)
    add('② 次日单是草稿（PENDING）—— 缺的货此刻并不存在，不能现在扣库存',
      deferOrder?.status === 'PENDING', `status = ${deferOrder?.status}`)
    const srcOrder = await prisma.order.findUnique({
      where: { id: shortLines[2].orderId }, select: { restaurantId: true },
    })
    add('② 次日单归属同一客户、数量与单价照抄原单快照',
      deferOrder?.restaurantId === srcOrder?.restaurantId
        && Number(dLine?.orderedQty) === 6 && Number(dLine?.unitPrice) === 10,
      `同客户=${deferOrder?.restaurantId === srcOrder?.restaurantId} · qty ${Number(dLine?.orderedQty)} · unitPrice ${Number(dLine?.unitPrice)} · total ${Number(deferOrder?.totalAmount)}`)
    add('② 次日单留下了来源与原因', !!deferOrder?.internalNote?.includes('缺货转单') && !!deferOrder?.internalNote?.includes('质量不合格'),
      deferOrder?.internalNote?.slice(0, 80) ?? '')
  }

  const consDefer = await stockConserved(SHORT.id)
  add('转单后库存仍守恒', consDefer.ok, `qtyOnHand ${consDefer.onHand} vs Σ流水 ${consDefer.moved}`)
  add('转单只释放今日差额，不重复扣次日的量', consDefer.onHand === 984 + 6,
    `984 + 6 = ${consDefer.onHand}（应 990；次日单还是草稿，未扣库存）`)

  // ── ④ 拣货锁：减量放行、加量拦截 ───────────────────────────────────────
  const lockOrderId = shortLines[0].orderId
  const lockWave = await prisma.pickingWave.create({
    data: {
      name: `D6-WAVE-${stamp}`, waveDate: new Date(`${DATE}T00:00:00.000Z`), status: 'PENDING',
      orderIds: [lockOrderId], driverName: `D6 司机 ${stamp}`, timeOfDay: 'am',
      pickLockedAt: new Date(), pickLockedBy: 'D6 测试',
    },
    select: { id: true },
  })

  const lockedLine = await prisma.orderLine.findFirst({
    where: { orderId: lockOrderId, productId: SHORT.id },
    select: { id: true, orderedQty: true },
  })
  if (!lockedLine) {
    skip('④ 拣货锁用例', '锁定单上找不到缺货行')
  } else {
    // 减量：应放行（缺货就发生在拣货中，锁死等于让这个功能没法用）
    const decRes = await (await fetch(`${BASE}/api/daily-sales/shortage/bulk-adjust`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        mode: 'ADJUST', reasonCode: 'DAMAGED',
        items: [{ orderId: lockOrderId, lineId: lockedLine.id, newQty: 3 }],
      }),
    })).json() as { applied: unknown[]; blocked: Array<{ reason: string }> }
    add('④ 已锁定批次：缺货减量放行', decRes.applied?.length === 1 && decRes.blocked?.length === 0,
      `applied ${decRes.applied?.length ?? 0} · blocked ${JSON.stringify(decRes.blocked ?? [])}`)

    // 加量：必须被拦（否则等于借缺货接口在锁定期间偷偷加单）
    const incRes = await fetch(`${BASE}/api/orders/${lockOrderId}/lines/${lockedLine.id}`, {
      method: 'PATCH', headers: auth, body: JSON.stringify({ newQty: 99 }),
    })
    add('④ 已锁定批次：加量被拦截（409）', incRes.status === 409, `HTTP ${incRes.status}`)

    // 批量接口本身也不接受加量（缺货处理天然只会减少）
    const incBulk = await (await fetch(`${BASE}/api/daily-sales/shortage/bulk-adjust`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        mode: 'ADJUST', reasonCode: 'OTHER',
        items: [{ orderId: lockOrderId, lineId: lockedLine.id, newQty: 99 }],
      }),
    })).json() as { applied: unknown[]; blocked: Array<{ reason: string; message: string }> }
    add('④ 批量接口拒绝加量并说明原因', incBulk.blocked?.[0]?.reason === 'INVALID_QTY',
      incBulk.blocked?.[0]?.message ?? JSON.stringify(incBulk).slice(0, 100))

    // 已完成/已取消的单：无论锁不锁都不许改
    const doneOrderId = shortLines[2].orderId
    await prisma.order.update({ where: { id: doneOrderId }, data: { status: 'CANCELLED' } })
    const doneLine = await prisma.orderLine.findFirst({ where: { orderId: doneOrderId }, select: { id: true } })
    const statusRes = await (await fetch(`${BASE}/api/daily-sales/shortage/bulk-adjust`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        mode: 'ADJUST', reasonCode: 'OTHER',
        items: [{ orderId: doneOrderId, lineId: doneLine?.id, newQty: 1 }],
      }),
    })).json() as { blocked: Array<{ reason: string }> }
    add('④ 不可编辑状态的单被拦并注明状态', statusRes.blocked?.[0]?.reason === 'ORDER_STATUS',
      JSON.stringify(statusRes.blocked?.[0] ?? null).slice(0, 100))
    // 还原，避免把夹具留在 CANCELLED 影响后续复跑
    await prisma.order.update({ where: { id: doneOrderId }, data: { status: 'CONFIRMED' } })
  }

  await prisma.pickingWave.delete({ where: { id: lockWave.id } })

  const consFinal = await stockConserved(SHORT.id)
  add('全流程结束后库存仍守恒', consFinal.ok, `qtyOnHand ${consFinal.onHand} vs Σ流水 ${consFinal.moved}`)

  await prisma.$disconnect()
  report()
}

function report() {
  console.log('\n──── 缺货批量改单 / 转单 ────')
  for (const c of cases) {
    const icon = c.state === 'pass' ? '✅' : c.state === 'fail' ? '❌' : '⚠️ '
    console.log(`  ${icon} ${c.name.padEnd(38)} ${c.detail}`)
  }
  const failed = cases.filter(c => c.state === 'fail')
  const skipped = cases.filter(c => c.state === 'skip')
  console.log(`\n合计 ${cases.length} 例 · 通过 ${cases.length - failed.length - skipped.length} · 失败 ${failed.length} · ⚠️ 未获验证 ${skipped.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
