/**
 * 采购质检 MVP —— 端到端实证
 * ============================================================================
 * 台账 F4。验收三条：
 *   ① 收货界面上可填三项质检信息（重量 / 新鲜度 / 农残），**可留空**
 *   ② 已填的能在**采购单**与**批次追溯**里看到
 *   ③ 不合格能触发**拒收**流程
 *
 * 走真实 HTTP 接口，不直接调 Prisma 写 —— 直接写库只能证明「数据能长成这样」，
 * 证明不了「用户那样操作时系统真的这么做」（B2 已经证实这个区别有多要命）。
 * Prisma 只用来读，核对落库结果。
 *
 * ③ 的关键不是「有个字段叫 rejected」，而是**拒收产生了与报废不同的后果**：
 * 不入库、不写流水、**不计入 receivedQty**、采购单因此保持未收齐。
 * 只断言「接口返回 201」是查不出这些的。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:purchase-qc
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
// 口令收口在 _seed-credentials.ts —— 此前 26 个脚本各写一遍字面量，改一个账号要改 26 处
import { seedPassword } from './_seed-credentials'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
/** 没有收货权限的角色，用来验「无权者被 403」 */
const NO_RECEIPT = process.env.DRIVER_EMAIL ?? 'driver@veggie.com'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()
const num = (v: unknown) => Number(v ?? 0)

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

  const supplier = await prisma.customer.findFirst({ where: { isVendor: true }, select: { id: true, name: true } })
  if (!supplier) { skip('准备供应商', '测试库没有供应商'); return report() }

  // ── 夹具：两个**专用**商品。借共享商品会被别的用例改掉期望值（E5x 栽过） ──
  async function makeProduct(label: string) {
    const name = `F4 质检测试${label} ${stamp}`
    const t = await prisma.productTemplate.create({
      data: {
        name, type: 'PRODUCT', status: 'ACTIVE', listPrice: 20, standardPrice: 5,
        uomId: 'uom_pcs', canBeSold: true, canBePurchased: true,
        products: { create: [{ name, listPrice: 20, standardPrice: 5, qtyOnHand: 0, active: true, status: 'ACTIVE' }] },
      },
      select: { products: { select: { id: true }, take: 1 } },
    })
    return { id: t.products[0]!.id, name }
  }
  const pA = await makeProduct('A')   // 走质检合格 + 拒收
  const pB = await makeProduct('B')   // 走「农残超标让步接收」

  const stockOf = async (id: string) =>
    num((await prisma.product.findUniqueOrThrow({ where: { id }, select: { qtyOnHand: true } })).qtyOnHand)
  const movesOf = async (id: string) => prisma.stockMove.count({ where: { productId: id } })

  const today = new Date().toISOString().slice(0, 10)
  const poRes = await fetch(`${BASE}/api/purchase-orders`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      supplierId: supplier.id, expectedDate: today,
      lines: [
        { productId: pA.id, productName: pA.name, orderedQty: 100, unitCost: 5, taxRate: 0 },
        { productId: pB.id, productName: pB.name, orderedQty: 40, unitCost: 5, taxRate: 0 },
      ],
    }),
  })
  const po = await poRes.json() as { id?: string; name?: string; error?: string }
  if (!po.id) { skip('准备采购单', `创建失败 HTTP ${poRes.status} ${po.error ?? ''}`); return report() }
  await fetch(`${BASE}/api/purchase-orders/${po.id}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ action: 'approve' }),
  })
  const poConfirmed = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, select: { status: true } })
  if (poConfirmed.status !== 'CONFIRMED') {
    skip('准备采购单', `审核后状态为 ${poConfirmed.status}，无法收货`); return report()
  }

  const receive = async (body: Record<string, unknown>, headers = auth) => {
    const r = await fetch(`${BASE}/api/goods-receipts`, {
      method: 'POST', headers, body: JSON.stringify({ purchaseOrderId: po.id, arrivedAt: today, ...body }),
    })
    const j = await r.json().catch(() => ({})) as { id?: string; name?: string; error?: string }
    return { status: r.status, body: j }
  }

  // ── ① 质检可留空：什么都不填的日常收货必须照旧 ───────────────────────────
  const before1 = await stockOf(pA.id)
  const r1 = await receive({ lines: [{ productId: pA.id, productName: pA.name, qty: 10, condition: 'ok' }] })
  const after1 = await stockOf(pA.id)
  add('① 三项质检全部留空，收货照旧成功', r1.status === 201 && after1 - before1 === 10,
    `HTTP ${r1.status} · 库存 ${before1} → ${after1}`)
  {
    const gr = await prisma.goodsReceipt.findFirst({ where: { name: r1.body.name }, select: { lines: true } })
    const l = (gr?.lines as Array<Record<string, unknown>> | undefined)?.[0]
    add('① 没填质检时 qc 存 null，不是空对象',
      !!l && l.qc === null,
      `qc=${JSON.stringify(l?.qc)}（空对象会让「没做质检」与「做了但全空」再也分不开）`)
  }

  // ── ① 三项都填 → 落库可查，且签字人由服务端盖章 ──────────────────────────
  const r2 = await receive({
    lines: [{
      productId: pA.id, productName: pA.name, qty: 40, condition: 'ok',
      qc: { weightKg: 39.6, freshness: 'A', pesticide: 'PASS', note: '车厢温度 4℃', checkedBy: '伪造的签字人' },
    }],
  })
  const gr2 = await prisma.goodsReceipt.findFirst({ where: { name: r2.body.name }, select: { lines: true } })
  const qc2 = ((gr2?.lines as Array<Record<string, unknown>> | undefined)?.[0]?.qc ?? null) as Record<string, unknown> | null
  add('① 重量/新鲜度/农残三项落库可查',
    r2.status === 201 && qc2?.weightKg === 39.6 && qc2?.freshness === 'A' && qc2?.pesticide === 'PASS',
    `HTTP ${r2.status} · ${JSON.stringify(qc2 && { w: qc2.weightKg, f: qc2.freshness, p: qc2.pesticide })}`)
  add('① 签字人由服务端盖章，客户端传的假名字被忽略',
    qc2?.checkedBy != null && qc2.checkedBy !== '伪造的签字人',
    `checkedBy=${String(qc2?.checkedBy)}（客户端传的是「伪造的签字人」）`)

  // ── ① 非法值必须 400，不能静默丢弃（填了等于没填是最坏的结果）────────────
  const badGrade = await receive({
    lines: [{ productId: pA.id, productName: pA.name, qty: 1, condition: 'ok', qc: { freshness: 'S' } }],
  })
  add('① 非法新鲜度评级被拒（400）', badGrade.status === 400, `HTTP ${badGrade.status} · ${badGrade.body.error ?? ''}`)
  const badWeight = await receive({
    lines: [{ productId: pA.id, productName: pA.name, qty: 1, condition: 'ok', qc: { weightKg: -3 } }],
  })
  add('① 负数实测重量被拒（400）', badWeight.status === 400, `HTTP ${badWeight.status} · ${badWeight.body.error ?? ''}`)

  // ── ③ 拒收必须给原因 ─────────────────────────────────────────────────────
  const noReason = await receive({
    lines: [{ productId: pA.id, productName: pA.name, qty: 5, condition: 'rejected', qc: { freshness: 'D' } }],
  })
  add('③ 拒收未选原因被拒（400）', noReason.status === 400, `HTTP ${noReason.status} · ${noReason.body.error ?? ''}`)
  const bogusReason = await receive({
    lines: [{ productId: pA.id, productName: pA.name, qty: 5, condition: 'rejected', rejectReason: 'BECAUSE_I_SAID_SO', qc: null }],
  })
  add('③ 白名单外的拒收原因等同没填（400）', bogusReason.status === 400,
    `HTTP ${bogusReason.status} · ${bogusReason.body.error ?? ''}`)

  // ── ③ 拒收的真正后果：不入库 / 不写流水 / 不计已收 / 采购单保持未收齐 ────
  const stockBefore = await stockOf(pA.id)
  const movesBefore = await movesOf(pA.id)
  const lineBefore = await prisma.purchaseOrderLine.findFirstOrThrow({
    where: { purchaseOrderId: po.id, productId: pA.id }, select: { id: true, receivedQty: true },
  })
  const r3 = await receive({
    lines: [{
      productId: pA.id, productName: pA.name, qty: 20, condition: 'rejected', rejectReason: 'FRESHNESS',
      qc: { freshness: 'D', weightKg: 19.2, note: '叶片发黄，整托退回' },
    }],
  })
  const stockAfter = await stockOf(pA.id)
  const movesAfter = await movesOf(pA.id)
  const lineAfter = await prisma.purchaseOrderLine.findUniqueOrThrow({
    where: { id: lineBefore.id }, select: { receivedQty: true },
  })
  add('③ 拒收提交成功', r3.status === 201, `HTTP ${r3.status} · ${r3.body.name ?? r3.body.error ?? ''}`)
  add('③ 拒收不进库存', stockAfter === stockBefore, `qtyOnHand ${stockBefore} → ${stockAfter}`)
  add('③ 拒收不写任何库存流水（货压根没进过门）', movesAfter === movesBefore,
    `StockMove ${movesBefore} → ${movesAfter}`)
  add('③ 拒收不计入已收数量', num(lineAfter.receivedQty) === num(lineBefore.receivedQty),
    `receivedQty ${num(lineBefore.receivedQty)} → ${num(lineAfter.receivedQty)}（拒收 20 件不该计入）`)
  const lotsForReject = await prisma.lot.count({ where: { productId: pA.id, sourceRef: r3.body.name ?? '—' } })
  add('③ 拒收不建批次', lotsForReject === 0, `批次数 ${lotsForReject}`)

  // 拒收当下不能把单据推成「已收齐」—— 若计入了，这张 PO 就此关闭，
  // 那 20 件永远没人再追。这是拒收与「按实收入库」最实质的差别
  const poAfterReject = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, select: { status: true } })
  add('③ 拒收后采购单保持未收齐（不会静默关单）', poAfterReject.status === 'CONFIRMED',
    `status=${poAfterReject.status} · 已收 ${num(lineAfter.receivedQty)}/100`)

  // 补货收满后才该转 RECEIVED
  const remainA = 100 - num(lineAfter.receivedQty)
  await receive({ lines: [
    { productId: pA.id, productName: pA.name, qty: remainA, condition: 'ok' },
    { productId: pB.id, productName: pB.name, qty: 40, condition: 'ok' },
  ] })
  const poAfterAll = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, select: { status: true } })
  add('③ 拒收后把余量收完 → 采购单转 RECEIVED（拒收部分需另行补货）',
    poAfterAll.status === 'RECEIVED',
    `status=${poAfterAll.status} · A 已收 ${num((await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: lineBefore.id }, select: { receivedQty: true } })).receivedQty)}/100`)

  // ── ③ 拒收在**采购单**的操作记录里留痕（收货单的日志采购员不会去翻）──────
  const rejectLog = await prisma.actionLog.findFirst({
    where: { resource: 'purchase_order', resourceId: po.id, detail: { contains: '质检拒收' } },
    select: { detail: true },
  })
  add('③ 拒收记进采购单操作记录', !!rejectLog,
    rejectLog?.detail?.slice(0, 90) ?? '⛔ 采购单 chatter 里查不到拒收记录')

  // ── ① 让步接收：农残超标却一件不拒，必须写明理由 ──────────────────────────
  const waiveNoNote = await receive({
    lines: [{ productId: pB.id, productName: pB.name, qty: 1, condition: 'ok', qc: { pesticide: 'FAIL' } }],
  })
  add('① 农残超标未拒收且无说明被拒（400）', waiveNoNote.status === 400,
    `HTTP ${waiveNoNote.status} · ${waiveNoNote.body.error ?? ''}`)
  const waived = await receive({
    lines: [{
      productId: pB.id, productName: pB.name, qty: 1, condition: 'ok',
      qc: { pesticide: 'FAIL', note: '供应商承诺复检报告明日补，先入库隔离' },
    }],
  })
  add('① 写明让步接收理由后放行（不拦截，但逼它留下说法）', waived.status === 201,
    `HTTP ${waived.status} · ${waived.body.name ?? waived.body.error ?? ''}`)

  // ── ② 采购单详情看得到质检 ───────────────────────────────────────────────
  const poDetail = await fetch(`${BASE}/api/purchase-orders/${po.id}`, { headers: auth })
  const poJson = await poDetail.json() as {
    receipts?: Array<{ name: string; lines: Array<{ productId: string; condition?: string; qc?: Record<string, unknown> | null; rejectReason?: string | null }> }>
  }
  const allLines = (poJson.receipts ?? []).flatMap(r => r.lines)
  const qcInPo = allLines.find(l => l.qc && l.qc.freshness === 'A')
  const rejectInPo = allLines.find(l => l.condition === 'rejected')
  add('② 采购单详情接口返回质检记录', !!qcInPo,
    qcInPo ? `新鲜度 ${String(qcInPo.qc?.freshness)} · 农残 ${String(qcInPo.qc?.pesticide)} · 实测 ${String(qcInPo.qc?.weightKg)}kg` : '⛔ 采购单上查不到质检')
  add('② 采购单详情能看到拒收行与原因', rejectInPo?.rejectReason === 'FRESHNESS',
    `condition=${rejectInPo?.condition} · rejectReason=${rejectInPo?.rejectReason}`)

  // ── ② 批次追溯看得到质检（派生自收货单，不是另存一份）────────────────────
  const lot = await prisma.lot.findFirst({
    where: { productId: pA.id, sourceRef: r2.body.name ?? '—' }, select: { lotNumber: true },
  })
  if (!lot) {
    skip('② 批次追溯显示质检', '未找到质检那次收货建的批次')
  } else {
    const traceRes = await fetch(`${BASE}/api/lots/trace?lotNumber=${encodeURIComponent(lot.lotNumber)}`, { headers: auth })
    const trace = await traceRes.json() as {
      receiptQc?: { qc?: Record<string, unknown>; verdict?: string | null; goodsReceiptName?: string; receivedBy?: string | null } | null
    }
    add('② 批次追溯返回该批次收货时的质检',
      traceRes.ok && trace.receiptQc?.qc?.freshness === 'A' && trace.receiptQc?.qc?.weightKg === 39.6,
      `HTTP ${traceRes.status} · ${lot.lotNumber} ← ${trace.receiptQc?.goodsReceiptName ?? '—'} · ${JSON.stringify(trace.receiptQc?.qc ?? null)}`)
    add('② 质检结论是派生的，不是另存的字段', trace.receiptQc?.verdict === 'PASS',
      `verdict=${trace.receiptQc?.verdict}（A 级 + 农残合格 ⇒ PASS）`)
  }

  // ── ② 不合格批次的结论必须是 FAIL（否则追溯页会给出错误的安全结论）───────
  const failRes = await receive({
    lines: [{
      productId: pB.id, productName: pB.name, qty: 3, condition: 'ok',
      qc: { freshness: 'D', note: '边缘发蔫，让步接收做促销' },
    }],
  })
  const failLot = await prisma.lot.findFirst({
    where: { productId: pB.id, sourceRef: failRes.body.name ?? '—' }, select: { lotNumber: true },
  })
  if (!failLot) {
    skip('② 不合格批次追溯显示「不合格」', '未找到该批次')
  } else {
    const t = await fetch(`${BASE}/api/lots/trace?lotNumber=${encodeURIComponent(failLot.lotNumber)}`, { headers: auth })
    const tj = await t.json() as { receiptQc?: { verdict?: string | null } | null }
    add('② 新鲜度 D 的批次追溯显示「不合格」', tj.receiptQc?.verdict === 'FAIL',
      `verdict=${tj.receiptQc?.verdict}（入了库不代表合格，追溯必须如实说）`)
  }

  // ── 权限：无收货权者被 403（本项目出过 13 个装饰性权限点，只能真打一次）──
  const weak = await login(NO_RECEIPT)
  if (!weak) {
    skip('无收货权限的角色被 403', `${NO_RECEIPT} 登录失败（限流？稍后重试）`)
  } else {
    const denied = await receive(
      { lines: [{ productId: pA.id, productName: pA.name, qty: 1, condition: 'ok' }] },
      { Authorization: `Bearer ${weak}`, 'Content-Type': 'application/json' },
    )
    add('无收货权限的角色提交收货被拒（403）', denied.status === 403,
      `HTTP ${denied.status} · ${denied.body.error ?? ''}`)
  }

  // ── 守恒：整轮跑完两个商品都必须 qtyOnHand == Σ StockMove ─────────────────
  for (const p of [pA, pB]) {
    const onHand = await stockOf(p.id)
    const agg = await prisma.stockMove.aggregate({ where: { productId: p.id }, _sum: { qty: true } })
    add(`守恒：${p.name.slice(0, 12)}… qtyOnHand == Σ流水`,
      Math.abs(onHand - num(agg._sum.qty)) < 0.001, `${onHand} vs ${num(agg._sum.qty)}`)
  }

  await prisma.$disconnect()
  report()
}

function report() {
  console.log('\n──── 采购质检 MVP（F4）────')
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
