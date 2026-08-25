/**
 * 收货 ↔ 采购单关联 + 预计到货 —— 端到端实证
 * ============================================================================
 * 台账 E6 + E7。E6 验收三条：
 *   ① 从采购单一键生成收货单，行项目自动带入
 *   ② 收货单上显示预计到货日
 *   ③ 未关联采购单的收货要能被识别出来
 *
 * 第 ③ 条最容易做成假的：`GoodsReceipt.purchaseOrderId` 是**非空外键**，
 * 去那张表里查「未关联」永远是 0 条，看着像「全都关联好了」。
 * 真正会漏的是绕过收货单直接进库存的流水，所以这里**故意造一笔**那样的入库，
 * 断言它真的被识别出来 —— 只测「正常收货不被误报」是自欺。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:receipt-linkage
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { arrivalDelay, summarizeOnTime } from '../../lib/receipt-linkage'

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
const num = (v: unknown) => Number(v ?? 0)

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR, password: seedPassword(OPERATOR) }),
  })
  const j = await r.json() as { token?: string; error?: string }
  if (!j.token) throw new Error(`登录失败：${j.error ?? ''}`)
  return j.token
}

const dayStr = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10)

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? ''
  if (!/localhost|127\.0\.0\.1/.test(dbUrl)) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }
  const token = await login()
  const auth: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const stamp = Date.now()

  const supplier = await prisma.customer.findFirst({ where: { isVendor: true }, select: { id: true, name: true } })
  if (!supplier) { skip('准备供应商', '测试库没有供应商'); return report() }

  // ── 夹具：一个商品 + 一张预计到货日在 3 天前的采购单（用来验「迟到」）──────
  const pname = `E6 关联测试商品 ${stamp}`
  const product = await prisma.product.create({
    data: {
      name: pname, type: 'PRODUCT', status: 'ACTIVE', listPrice: 20, standardPrice: 8,
      uomId: 'uom_pcs', canBeSold: true, canBePurchased: true, qtyOnHand: 0, active: true,
    },
    select: { id: true },
  })
  const productId = product.id

  const EXPECTED = dayStr(-3)   // 预计 3 天前到
  const po = await prisma.purchaseOrder.create({
    data: {
      name: `E6-PO-${stamp}`, supplierId: supplier.id, status: 'CONFIRMED',
      orderDate: new Date(), expectedDate: new Date(`${EXPECTED}T00:00:00.000Z`),
      subtotalExTax: 800, totalTax: 0, totalIncTax: 800,
      lines: {
        create: [{
          productId, productName: pname, orderedQty: 100, receivedQty: 0,
          unitCost: 8, unitCostEur: 8, taxRate: 0,
          subtotalExTax: 800, taxAmount: 0, subtotalIncTax: 800,
        }],
      },
    },
    select: { id: true, name: true },
  })

  // ── ① 从采购单取详情 → 行项目可自动带入（收货页 openPo 走的就是这个接口）──
  const poDetail = await (await fetch(`${BASE}/api/purchase-orders/${po.id}`, { headers: auth }))
    .json() as { id: string; expectedDate?: string | null; lines: Array<{ id: string; productId: string; orderedQty: string | number; receivedQty: string | number }> }
  const line = poDetail.lines?.[0]
  const remaining = line ? num(line.orderedQty) - num(line.receivedQty) : 0
  add('① 采购单详情可直接驱动收货表单（行项目 + 待收数量）',
    poDetail.lines?.length === 1 && remaining === 100,
    `行数 ${poDetail.lines?.length ?? 0} · 剩余待收 ${remaining}（应 100）`)

  // ── ② 预计到货日随采购单带出，并能算出与实际到货的偏差 ──────────────────
  add('② 采购单详情带出预计到货日', !!poDetail.expectedDate,
    `expectedDate = ${String(poDetail.expectedDate ?? '(空)').slice(0, 10)}（应 ${EXPECTED}）`)

  const ARRIVED = dayStr(0)     // 今天才到 → 迟到 3 天
  const delay = arrivalDelay(poDetail.expectedDate, ARRIVED)
  add('② 预计 vs 实际算出「迟到 3 天」', delay.timing === 'LATE' && delay.days === 3,
    `timing=${delay.timing} days=${delay.days}`)

  // 收货
  const recv = await fetch(`${BASE}/api/goods-receipts`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      purchaseOrderId: po.id, arrivedAt: `${ARRIVED}T00:00:00.000Z`,
      lines: [{ productId, productName: pname, qty: 100, condition: 'ok' }],
    }),
  })
  add('① 一键收货成功，收货单挂在该采购单下', recv.status === 201, `HTTP ${recv.status}`)

  const grs = await prisma.goodsReceipt.findMany({ where: { purchaseOrderId: po.id }, select: { id: true, name: true, arrivedAt: true } })
  add('① 收货单与采购单是外键关联（不是靠单号文本对）', grs.length === 1,
    `该 PO 下收货单 ${grs.length} 张 · ${grs[0]?.name ?? '—'}`)

  const poLineAfter = await prisma.purchaseOrderLine.findFirst({ where: { purchaseOrderId: po.id }, select: { receivedQty: true } })
  add('① 收货回写采购单行的已收数量', num(poLineAfter?.receivedQty) === 100,
    `receivedQty = ${num(poLineAfter?.receivedQty)}（应 100）`)

  // ── ② 收货历史接口要把预计到货日一起带出来（否则页面上算不出偏差）────────
  const hist = await (await fetch(`${BASE}/api/goods-receipts?limit=100`, { headers: auth })).json() as {
    items: Array<{ id: string; arrivedAt: string; purchaseOrder?: { name: string; expectedDate?: string | null } | null }>
  }
  const mine = hist.items?.find(h => h.purchaseOrder?.name === po.name)
  add('② 收货历史带出预计到货日，页面据此显示偏差',
    !!mine?.purchaseOrder?.expectedDate,
    mine ? `expectedDate=${String(mine.purchaseOrder?.expectedDate ?? '(空)').slice(0, 10)} arrivedAt=${String(mine.arrivedAt).slice(0, 10)}` : '⛔ 历史里找不到这张收货单')

  // ── ③ 未关联采购单的入库 ────────────────────────────────────────────────
  const beforeUnlinked = await (await fetch(`${BASE}/api/goods-receipts/unlinked?days=30&limit=200`, { headers: auth }))
    .json() as { count: number; scanned: number; items: Array<{ productName: string; sourceType: string | null }> }

  // 正常收货**不该**被误报
  const falsePositive = beforeUnlinked.items?.some(i => i.productName === pname)
  add('③ 正常收货不被误报成「未关联」', !falsePositive,
    `未关联清单里${falsePositive ? '错误地出现了' : '没有'}本次收货的商品`)

  // 故意造一笔绕过收货单的入库（手工调整），它必须被识别出来。
  // ⚠️ 连 qtyOnHand 一起改，否则夹具自己就破坏守恒
  await prisma.$transaction([
    prisma.stockMove.create({
      data: {
        productId, productName: pname, type: 'IN', qty: 7, movedAt: new Date(),
        note: 'E6：模拟绕过采购单的手工入库', sourceType: 'MANUAL', sourceRef: `E6-MANUAL-${stamp}`,
      },
    }),
    prisma.product.update({ where: { id: productId }, data: { qtyOnHand: { increment: 7 } } }),
  ])

  const afterUnlinked = await (await fetch(`${BASE}/api/goods-receipts/unlinked?days=30&limit=200`, { headers: auth }))
    .json() as { count: number; scanned: number; qty: number; items: Array<{ productName: string; sourceType: string | null; qty: string | number }> }
  const found = afterUnlinked.items?.find(i => i.productName === pname && i.sourceType === 'MANUAL')
  add('③ 绕过采购单的入库被识别出来', !!found && num(found?.qty) === 7,
    found ? `识别到 ${found.productName} ${num(found.qty)} 件 · 来源 ${found.sourceType}` : '⛔ 没被识别 —— 这条链等于没做')
  add('③ 未关联条数相应 +1', afterUnlinked.count - beforeUnlinked.count === 1,
    `${beforeUnlinked.count} → ${afterUnlinked.count}`)
  add('③ 同时给出扫描总数（只报未关联数会让人无从判断严重程度）',
    afterUnlinked.scanned > afterUnlinked.count,
    `未关联 ${afterUnlinked.count} / 入库总数 ${afterUnlinked.scanned}`)

  // ── E7：实际到货日回写采购单 ────────────────────────────────────────────
  {
    const poAfter = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: po.id }, select: { firstArrivedAt: true, lastArrivedAt: true, status: true },
    })
    add('E7 收货后回写首次/最近到货日',
      poAfter.firstArrivedAt?.toISOString().slice(0, 10) === ARRIVED
      && poAfter.lastArrivedAt?.toISOString().slice(0, 10) === ARRIVED,
      `first=${poAfter.firstArrivedAt?.toISOString().slice(0, 10) ?? 'null'} last=${poAfter.lastArrivedAt?.toISOString().slice(0, 10) ?? 'null'}（应各 ${ARRIVED}）`)
    add('E7 收齐后采购单转 RECEIVED', poAfter.status === 'RECEIVED', `status=${poAfter.status}`)
  }

  // 分批：再补一张**日期更早**的收货单（现实中常见的补录），
  // first 必须往前挪、last 不能被这张旧的顶掉 —— 「first 为空才填、last 直接覆盖」的写法在这里就会错
  {
    const BACKDATED = dayStr(-5)
    const r = await fetch(`${BASE}/api/goods-receipts`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        purchaseOrderId: po.id, arrivedAt: `${BACKDATED}T00:00:00.000Z`,
        lines: [{ productId, productName: pname, qty: 1, condition: 'ok' }],
      }),
    })
    const poAfter = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: po.id }, select: { firstArrivedAt: true, lastArrivedAt: true },
    })
    add('E7 补录一张更早的收货单：首次到货日前移，最近到货日不被顶掉',
      r.status === 201
      && poAfter.firstArrivedAt?.toISOString().slice(0, 10) === BACKDATED
      && poAfter.lastArrivedAt?.toISOString().slice(0, 10) === ARRIVED,
      `HTTP ${r.status} · first=${poAfter.firstArrivedAt?.toISOString().slice(0, 10)}（应 ${BACKDATED}）· last=${poAfter.lastArrivedAt?.toISOString().slice(0, 10)}（应 ${ARRIVED}）`)
  }

  // 准时率：本单预计 3 天前、收齐日是今天 → 计入「迟到」
  {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT po."expectedDate" AS expected, po."lastArrivedAt" AS last_arrived,
              BOOL_AND(COALESCE(pol."receivedQty",0) >= COALESCE(pol."orderedQty",0)) AS fully
       FROM "PurchaseOrder" po LEFT JOIN "PurchaseOrderLine" pol ON pol."purchaseOrderId" = po.id
       WHERE po.id = $1 GROUP BY po.id, po."expectedDate", po."lastArrivedAt"`,
      po.id,
    ) as Array<{ expected: Date | null; last_arrived: Date | null; fully: boolean | null }>
    const stats = summarizeOnTime(rows.map(r => ({
      expectedDate: r.expected, lastArrivedAt: r.last_arrived, fullyReceived: r.fully === true,
    })))
    add('E7 该单计入准时率并判为迟到', stats.measured === 1 && stats.late === 1 && stats.rate === 0,
      `measured=${stats.measured} late=${stats.late} rate=${stats.rate}`)
  }

  // 采购分析接口要真的把准时率算出来（不是只有纯函数会算）
  {
    const from = dayStr(-7), to = dayStr(0)
    const proc = await (await fetch(`${BASE}/api/analytics/procurement?from=${from}&to=${to}&_=${stamp}`, { headers: auth }))
      .json() as { bySupplier: Array<{ supplierId: string; onTimeRate: number | null; onTimeMeasured: number; onTimeLate: number; onTimePending: number }> }
    const row = proc.bySupplier?.find(x => x.supplierId === supplier.id)
    add('E7 采购分析按供应商给出准时率', !!row && row.onTimeMeasured >= 1 && row.onTimeLate >= 1,
      row ? `供应商 ${supplier.name}：已判定 ${row.onTimeMeasured} 单 · 迟到 ${row.onTimeLate} · 未收齐 ${row.onTimePending} · 准时率 ${row.onTimeRate === null ? '—' : `${Math.round(row.onTimeRate * 100)}%`}` : '⛔ 分析接口里找不到该供应商')
  }

  // ── 守恒底线 ────────────────────────────────────────────────────────────
  const prod = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { qtyOnHand: true } })
  const agg = await prisma.stockMove.aggregate({ where: { productId }, _sum: { qty: true } })
  add('收货与手工入库后库存仍守恒',
    Math.abs(num(prod.qtyOnHand) - num(agg._sum.qty)) < 0.001,
    `qtyOnHand ${num(prod.qtyOnHand)} vs Σ流水 ${num(agg._sum.qty)}（100 + 1 补录收货 + 7 手工）`)

  await prisma.$disconnect()
  report()
}

function report() {
  console.log('\n──── 收货 ↔ 采购单关联 + 预计/实际到货 ────')
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
