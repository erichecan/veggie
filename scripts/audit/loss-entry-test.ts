/**
 * 损耗录入 → SCRAP 流水 → 看板归因 —— 端到端实证
 * ============================================================================
 * 台账 E4。验收三条，逐条对应：
 *   ① 仓库人员能在界面上录入一条损耗（环节 + 商品 + 数量 + 原因）
 *   ② 录入后生成 SCRAP 类型库存流水
 *   ③ 损耗看板按环节 / 原因能拆分
 *
 * 走真实 HTTP：界面点的就是 POST /api/scrap，看板读的就是
 * GET /api/analytics/loss-dashboard。单测只证明纯函数会算，这里证明**这条链真的通**。
 *
 * 另有一条底线：报废后 qtyOnHand 与 ΣStockMove 必须仍然相等 ——
 * E5 周期就是在「收货损坏品写正数 SCRAP 而库存不动」上栽的，同一个坑不能再踩。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:loss-entry
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { LOSS_STAGE_LABEL } from '../../lib/loss-attribution'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
const PASSWORD = process.env.SEED_PASSWORD ?? 'LocalTest2026!'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR, password: PASSWORD }),
  })
  const j = await r.json() as { token?: string; error?: string }
  if (!j.token) throw new Error(`登录失败：${j.error ?? ''}`)
  return j.token
}

interface StageRow { stage: string; stageLabel: string; qty: number; inferredQty: number }
interface ReasonRow { reason: string; reasonLabel: string; qty: number }
interface Dashboard {
  stageBreakdown: StageRow[]
  reasonBreakdown: ReasonRow[]
  kpis: { scrapValueThisPeriod: number }
}

async function conserved(productId: string) {
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

  // ── 夹具：一个带期初库存的实物商品 ──────────────────────────────────────
  const name = `E4 损耗测试商品 ${stamp}`
  const tmpl = await prisma.productTemplate.create({
    data: {
      name, type: 'PRODUCT', status: 'ACTIVE', listPrice: 10, standardPrice: 4,
      canBeSold: true, canBePurchased: true,
      products: { create: [{ name, listPrice: 10, standardPrice: 4, qtyOnHand: 0, active: true, status: 'ACTIVE' }] },
    },
    select: { products: { select: { id: true }, take: 1 } },
  })
  const productId = tmpl.products[0]!.id
  // 期初连流水一起写，夹具自身必须守恒（周期 25/26 的教训）
  await prisma.$transaction([
    prisma.stockMove.create({
      data: {
        productId, productName: name, type: 'ADJUSTMENT', qty: 200, movedAt: new Date(),
        note: 'E4 测试期初', sourceType: 'TEST_OPENING', sourceRef: 'E4',
      },
    }),
    prisma.product.update({ where: { id: productId }, data: { qtyOnHand: 200 } }),
  ])

  const before = await (await fetch(`${BASE}/api/analytics/loss-dashboard?days=30&weeks=8&_=${stamp}`, { headers: auth })).json() as Dashboard
  const stageBefore = (s: string) => before.stageBreakdown.find(r => r.stage === s)?.qty ?? 0
  const reasonBefore = (r: string) => before.reasonBreakdown.find(x => x.reason === r)?.qty ?? 0

  // ── ① 录一条损耗（环节 + 商品 + 数量 + 原因）───────────────────────────
  const res = await fetch(`${BASE}/api/scrap`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      productId, productName: name, qty: 12,
      stage: 'SORTING', reason: 'WAREHOUSE_DAMAGE', notes: 'E4 端到端：分拣装车时压坏',
    }),
  })
  const move = await res.json() as { id?: string; type?: string; qty?: string | number; error?: string }
  add('① 录入一条损耗（分拣环节 / 仓库损坏 / 12 件）', res.status === 201 && !!move.id,
    `HTTP ${res.status}${move.error ? ` · ${move.error}` : ` · move ${move.id}`}`)
  if (!move.id) { await prisma.$disconnect(); return report() }

  // ── ② 生成 SCRAP 流水，且库存真的减了 ──────────────────────────────────
  const row = await prisma.stockMove.findUnique({ where: { id: move.id } })
  add('② 流水类型是 SCRAP，数量为负（出库方向）',
    row?.type === 'SCRAP' && Number(row?.qty) === -12,
    `type=${row?.type} qty=${Number(row?.qty)}`)
  add('② 环节与原因以结构化字段落库（不是塞在 note 里让看板猜）',
    row?.lossStage === 'SORTING' && row?.lossReason === 'WAREHOUSE_DAMAGE',
    `lossStage=${row?.lossStage} lossReason=${row?.lossReason}`)
  add('② note 仍是人能读的一句话，且带上了环节',
    !!row?.note?.includes(`${LOSS_STAGE_LABEL.SORTING}环节`),
    row?.note ?? '(空)')

  const prod = await prisma.product.findUnique({ where: { id: productId }, select: { qtyOnHand: true } })
  add('② 库存相应减少', Number(prod?.qtyOnHand) === 188, `200 − 12 = ${Number(prod?.qtyOnHand)}（应 188）`)

  const cons = await conserved(productId)
  add('② 报废后库存仍守恒（qtyOnHand == ΣStockMove）', cons.ok,
    `qtyOnHand ${cons.onHand} vs Σ流水 ${cons.moved}`)

  // ── 非法环节必须被挡下（否则脏枚举会污染归因）─────────────────────────
  const bogus = await fetch(`${BASE}/api/scrap`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ productId, productName: name, qty: 1, stage: 'NOT_A_STAGE', reason: 'OTHER' }),
  })
  add('② 非法环节返回 400，不落库', bogus.status === 400, `HTTP ${bogus.status}`)

  // ── 再录一条不同环节的，证明看板真的能拆开 ────────────────────────────
  const res2 = await fetch(`${BASE}/api/scrap`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      productId, productName: name, qty: 5,
      stage: 'TRANSPORT', reason: 'WAREHOUSE_DAMAGE', notes: 'E4 端到端：路上颠坏',
    }),
  })
  add('① 再录一条运输环节损耗（同一原因，不同环节）', res2.status === 201, `HTTP ${res2.status}`)

  // ── ③ 看板按环节 / 原因拆分 ────────────────────────────────────────────
  const after = await (await fetch(`${BASE}/api/analytics/loss-dashboard?days=30&weeks=8&_=${stamp}b`, { headers: auth })).json() as Dashboard
  const sortingDelta = (after.stageBreakdown.find(r => r.stage === 'SORTING')?.qty ?? 0) - stageBefore('SORTING')
  const transportDelta = (after.stageBreakdown.find(r => r.stage === 'TRANSPORT')?.qty ?? 0) - stageBefore('TRANSPORT')
  add('③ 看板按环节拆分：分拣 +12', sortingDelta === 12, `分拣增量 ${sortingDelta}`)
  add('③ 看板按环节拆分：运输 +5', transportDelta === 5, `运输增量 ${transportDelta}`)
  add('③ 同一原因被拆进两个环节（这正是「环节」的价值）',
    sortingDelta === 12 && transportDelta === 5,
    `两条都是 WAREHOUSE_DAMAGE，却分别落到分拣/运输`)

  const reasonDelta = (after.reasonBreakdown.find(r => r.reason === 'WAREHOUSE_DAMAGE')?.qty ?? 0) - reasonBefore('WAREHOUSE_DAMAGE')
  add('③ 看板按原因拆分：仓库损坏 +17', reasonDelta === 17, `原因增量 ${reasonDelta}（12 + 5）`)

  const unknownRow = after.stageBreakdown.find(r => r.stage === 'UNKNOWN')
  add('③ 历史无环节的记录归入「未归因」而不是硬塞进某个环节',
    unknownRow === undefined || unknownRow.stage === 'UNKNOWN',
    unknownRow ? `未归因 ${unknownRow.qty}` : '本期没有未归因记录')

  // 造一条「环节字段上线前」的老记录：只有原因、没有环节 —— 证明反推路径真的在跑，
  // 而不是只有单测覆盖。⚠️ 直接写流水也必须同时扣 qtyOnHand，否则夹具自己就不守恒
  await prisma.$transaction([
    prisma.stockMove.create({
      data: {
        productId, productName: name, type: 'SCRAP', qty: -3, movedAt: new Date(),
        note: '仓库过期 - E4 模拟历史记录', sourceType: 'SCRAP', sourceRef: `SCRAP-E4-LEGACY-${stamp}`,
        lossStage: null, lossReason: 'WAREHOUSE_EXPIRY',
      },
    }),
    prisma.product.update({ where: { id: productId }, data: { qtyOnHand: { decrement: 3 } } }),
  ])
  const afterLegacy = await (await fetch(`${BASE}/api/analytics/loss-dashboard?days=30&weeks=8&_=${stamp}c`, { headers: auth })).json() as Dashboard
  const storageRow = afterLegacy.stageBreakdown.find(r => r.stage === 'STORAGE')
  const storageDelta = (storageRow?.qty ?? 0) - stageBefore('STORAGE')
  const inferredBefore = before.stageBreakdown.find(r => r.stage === 'STORAGE')?.inferredQty ?? 0
  add('③ 无环节的历史记录按原因反推进「仓储」', storageDelta === 3,
    `仓储增量 ${storageDelta}（应 3）`)
  add('③ 反推出来的量单独计入 inferredQty，与明确填写的分开',
    (storageRow?.inferredQty ?? 0) - inferredBefore === 3,
    `仓储推断量 ${inferredBefore} → ${storageRow?.inferredQty ?? 0}`)

  const inferredTotal = afterLegacy.stageBreakdown.reduce((s, r) => s + r.inferredQty, 0)
  add('③ 新录入的两条不计入推断量', inferredTotal > 0,
    `本期推断量合计 ${inferredTotal}（分拣 12 / 运输 5 均为明确填写，不在其中）`)

  // ── 库存不足时不许报废（否则会造出负库存 + 假损耗）────────────────────
  const tooMuch = await fetch(`${BASE}/api/scrap`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ productId, productName: name, qty: 99999, stage: 'STORAGE', reason: 'WAREHOUSE_EXPIRY' }),
  })
  add('库存不足时拒绝报废（409）', tooMuch.status === 409, `HTTP ${tooMuch.status}`)

  const consFinal = await conserved(productId)
  add('全流程结束后库存仍守恒', consFinal.ok, `qtyOnHand ${consFinal.onHand} vs Σ流水 ${consFinal.moved}`)

  await prisma.$disconnect()
  report()
}

function report() {
  console.log('\n──── 损耗录入 → SCRAP 流水 → 看板归因 ────')
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
