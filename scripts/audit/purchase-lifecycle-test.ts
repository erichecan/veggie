/**
 * 采购单全生命周期 —— 端到端实证
 * ============================================================================
 * 台账 F3。验收四条：
 *   ① 一张采购单从创建走到发票核销全程无阻断
 *   ② 审核权限生效（无权者被 403）
 *   ③ 退货能正确冲减库存
 *   ④ 发票金额与入库金额可对账
 *
 * ②「无权者被 403」必须**用一个真的没有该权限的角色去打**，不能只看代码里写了
 * requirePermission —— 装饰性权限点（配置页上勾了什么也不发生）在这个项目里出现过
 * 13 个，只有真拿别人的 token 打一次才算数。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:purchase-lifecycle
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const PASSWORD = process.env.SEED_PASSWORD ?? 'LocalTest2026!'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
/** 没有采购审批权的角色：司机 —— 用来验「无权者被 403」 */
const NO_APPROVE = process.env.DRIVER_EMAIL ?? 'driver@veggie.com'

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

  const token = await login(OPERATOR)
  if (!token) { skip('登录', '运营账号登录失败'); return report() }
  const auth: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const stamp = Date.now()

  const supplier = await prisma.customer.findFirst({ where: { isVendor: true }, select: { id: true, name: true, email: true } })
  if (!supplier) { skip('准备供应商', '测试库没有供应商'); return report() }

  // ── 夹具：一个带期初库存的商品 ──────────────────────────────────────────
  const pname = `F3 生命周期测试商品 ${stamp}`
  const tmpl = await prisma.productTemplate.create({
    data: {
      name: pname, type: 'PRODUCT', status: 'ACTIVE', listPrice: 20, standardPrice: 6,
      uomId: 'uom_pcs', canBeSold: true, canBePurchased: true,
      products: { create: [{ name: pname, listPrice: 20, standardPrice: 6, qtyOnHand: 0, active: true, status: 'ACTIVE' }] },
    },
    select: { products: { select: { id: true }, take: 1 } },
  })
  const productId = tmpl.products[0]!.id
  await prisma.$transaction([
    prisma.stockMove.create({
      data: {
        productId, productName: pname, type: 'ADJUSTMENT', qty: 50, movedAt: new Date(),
        note: 'F3 期初', sourceType: 'TEST_OPENING', sourceRef: 'F3',
      },
    }),
    prisma.product.update({ where: { id: productId }, data: { qtyOnHand: 50 } }),
  ])

  const stockOf = async () =>
    num((await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { qtyOnHand: true } })).qtyOnHand)
  const conserved = async () => {
    const p = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { qtyOnHand: true } })
    const agg = await prisma.stockMove.aggregate({ where: { productId }, _sum: { qty: true } })
    return { ok: Math.abs(num(p.qtyOnHand) - num(agg._sum.qty)) < 0.001, onHand: num(p.qtyOnHand), moved: num(agg._sum.qty) }
  }

  // ── ① 创建 ──────────────────────────────────────────────────────────────
  const createRes = await fetch(`${BASE}/api/purchase-orders`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      supplierId: supplier.id,
      expectedDate: new Date().toISOString().slice(0, 10),
      lines: [{ productId, productName: pname, orderedQty: 30, unitCost: 6, taxRate: 0 }],
    }),
  })
  const created = await createRes.json() as { id?: string; name?: string; status?: string; error?: string }
  add('① 创建采购单', createRes.status === 201 && !!created.id,
    `HTTP ${createRes.status} · ${created.name ?? created.error ?? ''} · 状态 ${created.status ?? '—'}`)
  if (!created.id) { await prisma.$disconnect(); return report() }
  const poId = created.id

  // ── ① 修改（DRAFT 阶段可改）─────────────────────────────────────────────
  const editRes = await fetch(`${BASE}/api/purchase-orders/${poId}`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ notes: 'F3 生命周期测试', expectedDate: new Date().toISOString().slice(0, 10) }),
  })
  add('① 草稿阶段可修改', editRes.ok, `HTTP ${editRes.status}`)

  // ── ② 审核权限：无权角色必须 403 ────────────────────────────────────────
  const weakToken = await login(NO_APPROVE)
  if (!weakToken) {
    skip('② 无审批权者被 403', `${NO_APPROVE} 登录失败（限流？稍后重试）`)
  } else {
    const denied = await fetch(`${BASE}/api/purchase-orders/${poId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${weakToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    })
    const body = await denied.json().catch(() => ({})) as { error?: string }
    add('② 无审批权的角色执行「审核」被拒（403）', denied.status === 403,
      `HTTP ${denied.status} · ${body.error ?? ''}`)
    // 拒绝之后状态不能被改动 —— 「返回 403 但事已经做了」是最难查的一类漏洞
    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { status: true } })
    add('② 被拒后采购单状态没有被改动', after.status === 'DRAFT', `status=${after.status}（应仍为 DRAFT）`)
  }

  // ── ① 审核通过（有权角色）────────────────────────────────────────────────
  const approveRes = await fetch(`${BASE}/api/purchase-orders/${poId}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ action: 'approve' }),
  })
  const poAfterApprove = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { status: true, confirmedAt: true } })
  add('① 有权角色可审核通过 → CONFIRMED',
    approveRes.ok && poAfterApprove.status === 'CONFIRMED' && !!poAfterApprove.confirmedAt,
    `HTTP ${approveRes.status} · status=${poAfterApprove.status} · confirmedAt=${poAfterApprove.confirmedAt ? '已填' : '(空)'}`)

  // 确认即自动生成 DRAFT 供应商账单（应付确定的那一刻）
  const draftBill = await prisma.vendorBill.findFirst({ where: { purchaseOrderId: poId } })
  add('① 确认后自动生成草稿供应商账单', !!draftBill,
    draftBill ? `${draftBill.name} · €${num(draftBill.totalIncTax)} · ${draftBill.status}` : '⛔ 没有生成账单')

  // ── ① 入库 ──────────────────────────────────────────────────────────────
  const stockBefore = await stockOf()
  const recvRes = await fetch(`${BASE}/api/goods-receipts`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      purchaseOrderId: poId, arrivedAt: new Date().toISOString(),
      lines: [{ productId, productName: pname, qty: 30, condition: 'ok' }],
    }),
  })
  const stockAfterRecv = await stockOf()
  add('① 收货入库，库存 +30', recvRes.status === 201 && stockAfterRecv - stockBefore === 30,
    `HTTP ${recvRes.status} · 库存 ${stockBefore} → ${stockAfterRecv}`)

  const poAfterRecv = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: poId }, select: { status: true, lastArrivedAt: true, lines: true },
  })
  add('① 收齐后自动转 RECEIVED 且回写实际到货日',
    poAfterRecv.status === 'RECEIVED' && !!poAfterRecv.lastArrivedAt,
    `status=${poAfterRecv.status} · lastArrivedAt=${poAfterRecv.lastArrivedAt?.toISOString().slice(0, 10) ?? '(空)'}`)

  // ── ③ 退货冲减库存 ──────────────────────────────────────────────────────
  const RETURN_QTY = 4
  const retRes = await fetch(`${BASE}/api/purchase-orders/${poId}/return`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ lines: [{ productId, qty: RETURN_QTY }], reason: 'F3：品质不合格退回' }),
  })
  const retBody = await retRes.json().catch(() => ({})) as { refundExTax?: number; error?: string }
  const stockAfterReturn = await stockOf()
  add('③ 退货成功', retRes.status === 201, `HTTP ${retRes.status} · ${retBody.error ?? `应退 €${retBody.refundExTax}`}`)
  add('③ 退货冲减库存（−4）', stockAfterRecv - stockAfterReturn === RETURN_QTY,
    `库存 ${stockAfterRecv} → ${stockAfterReturn}（应 −${RETURN_QTY}）`)

  const consAfterReturn = await conserved()
  add('③ 退货后库存仍守恒（qtyOnHand == ΣStockMove）', consAfterReturn.ok,
    `qtyOnHand ${consAfterReturn.onHand} vs Σ流水 ${consAfterReturn.moved}`)

  // ⛔ 批次守恒要单独验：第一版退货只扣了 Lot.currentQty 却把流水记成 lotId=null，
  // 商品级守恒照样成立（总量对得上），**只有批次级会露馅**。
  // 这正是「只测总量」漏掉的那一类错。
  const lotBad = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(`
    SELECT COUNT(*)::bigint AS c FROM "Lot" l
    LEFT JOIN (SELECT "lotId", SUM(qty) AS s FROM "StockMove" WHERE "lotId" IS NOT NULL GROUP BY 1) m ON m."lotId" = l.id
    WHERE l."productId" = $1 AND ABS(l."currentQty" - COALESCE(m.s, 0)) > 0.001`, productId)
  add('③ 退货后批次也守恒（Lot.currentQty == Σ该批次流水）',
    Number(lotBad[0]?.c ?? 0) === 0, `该商品不守恒批次数 ${Number(lotBad[0]?.c ?? 0)}`)

  const lineAfterReturn = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: poId } })
  add('③ 已收数量回冲（30 → 26），否则这单看起来还是收齐的',
    num(lineAfterReturn.receivedQty) === 26, `receivedQty=${num(lineAfterReturn.receivedQty)}（应 26）`)

  add('③ 退货金额按采购价算出应退额（供财务开贷记单）',
    retBody.refundExTax === RETURN_QTY * 6, `refundExTax=${retBody.refundExTax}（应 ${RETURN_QTY * 6}）`)

  // 退超量必须被拒
  const overRet = await fetch(`${BASE}/api/purchase-orders/${poId}/return`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ lines: [{ productId, qty: 9999 }] }),
  })
  add('③ 退货量超过已收量被拒（409）', overRet.status === 409, `HTTP ${overRet.status}`)

  // ── ④ 发票：过账并与入库金额对账 ────────────────────────────────────────
  const bill = await prisma.vendorBill.findFirst({ where: { purchaseOrderId: poId } })
  if (!bill) {
    skip('④ 发票对账', '没有可用的供应商账单')
  } else {
    // 账单过账走 PUT + status（这个端点没有 PATCH —— 第一版按 PATCH 打，收了 403，
    // 差点被读成「权限有问题」，其实是方法用错了）
    const postRes = await fetch(`${BASE}/api/vendor-bills/${bill.id}`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ status: 'POSTED' }),
    })
    const posted = await prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } })
    add('④ 账单可过账（POSTED）', postRes.ok && posted.status === 'POSTED',
      `HTTP ${postRes.status} · status=${posted.status}`)

    // 对账：账单税前金额 = 订购量 × 单价（本单 30 × 6 = 180）；
    // 退货 4 件 → 实收 26 件 × 6 = 156，差额 24 正是应由贷记单冲回的部分
    const receivedValue = num(lineAfterReturn.receivedQty) * 6
    const refund = retBody.refundExTax
    // ⛔ refund 为 undefined 时直接判失败，不要让它参与算术 ——
    // `undefined ?? 0` 会让这条断言在退货根本没成功时照样变绿（第一版就是这样）
    add('④ 发票金额与入库金额可对账（差额 = 退货额）',
      typeof refund === 'number' && Math.abs(num(posted.subtotalExTax) - receivedValue - refund) < 0.01,
      typeof refund === 'number'
        ? `账单税前 €${num(posted.subtotalExTax)} = 实收 €${receivedValue} + 应退 €${refund}`
        : '⛔ 退货没成功（refundExTax 缺失），这条对账不成立')

    const invRes = await fetch(`${BASE}/api/purchase-orders/${poId}`, {
      method: 'PATCH', headers: auth, body: JSON.stringify({ action: 'invoice' }),
    })
    const poInv = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { status: true } })
    add('① 采购单推进到 INVOICED', invRes.ok && poInv.status === 'INVOICED',
      `HTTP ${invRes.status} · status=${poInv.status}`)

    const lockRes = await fetch(`${BASE}/api/purchase-orders/${poId}`, {
      method: 'PATCH', headers: auth, body: JSON.stringify({ action: 'lock' }),
    })
    const poLocked = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { status: true, lockedAt: true } })
    add('① 核销后锁定（LOCKED，全程无阻断）',
      lockRes.ok && poLocked.status === 'LOCKED' && !!poLocked.lockedAt,
      `HTTP ${lockRes.status} · status=${poLocked.status}`)

    // 锁定后不可再动 —— 否则「已核销」这件事就没有意义
    const afterLock = await fetch(`${BASE}/api/purchase-orders/${poId}`, {
      method: 'PATCH', headers: auth, body: JSON.stringify({ action: 'reset_to_draft' }),
    })
    add('① 锁定后拒绝再变更（409）', afterLock.status === 409, `HTTP ${afterLock.status}`)
  }

  const consFinal = await conserved()
  add('全流程结束后库存仍守恒', consFinal.ok,
    `qtyOnHand ${consFinal.onHand} vs Σ流水 ${consFinal.moved}（50 期初 + 30 收货 − 4 退货 = 76）`)

  await prisma.$disconnect()
  report()
}

function report() {
  console.log('\n──── 采购单全生命周期 ────')
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
