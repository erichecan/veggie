/**
 * 收货 → 库存 测试用例
 * ============================================================================
 * 台账 E5。对应需求原话：「库存更新：需要 AI 写测试用例去做检查」。
 *
 * ⚠️ 20260823 改写：改库存的动作从 `POST /api/goods-receipts` 搬到了
 * `PATCH /api/purchase-orders/[id]` action=receive（采购单详情页「确认收货」，
 * 见 lib/purchase/receive-purchase-order.ts）。goods-receipts 现在只记录到货，
 * 不再碰库存——这份脚本原先测的是前者，现在拆成两段：
 *   1. 验证 goods-receipts 确实**零库存副作用**（不管 condition 是什么）——
 *      这是本次重构最容易漏测的回归点：忘删一行库存写入，这里就会当场炸。
 *   2. 把原来测「收货改库存」的场景搬到新端点上，断言三件事不变：
 *      - `Product.qtyOnHand` 的增量恰好等于本次确认的数量
 *      - `StockMove` 新增条数与类型符合预期
 *      - 收完仍满足全局不变量 `qtyOnHand == Σ StockMove`（守恒）
 *
 * 良品/损坏/拒收的**记录**仍在 goods-receipts（决策#1：全部录入项保留，只是不再
 * 触发库存），但那三态本身不再产生任何库存后果，所以原先「损坏不进库存」「拒收
 * 不进库存」这类场景在新架构下对**所有** condition 都成立、且已被场景 0 覆盖，
 * 不必再各测一遍。
 *
 * ⛔ 本脚本会写库（建 PO、收货）。只允许打向本机 veggie_test。
 *
 * 用法（需先起服务）：
 *   npx tsx --env-file=.env.test scripts/audit/receipt-stock-test.ts
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
// 口令收口在 _seed-credentials.ts —— 此前 26 个脚本各写一遍字面量，改一个账号要改 26 处
import { seedPassword } from './_seed-credentials'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
/** skip 与 pass 分开计：把「没测」记成「通过」是本项目栽过多次的坑 */
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

/** 某商品当前的库存与流水条数 */
async function snapshot(productId: string) {
  const [p, moves] = await Promise.all([
    prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { qtyOnHand: true } }),
    prisma.stockMove.findMany({ where: { productId }, select: { type: true, qty: true } }),
  ])
  return {
    qty: num(p.qtyOnHand),
    moveCount: moves.length,
    inCount: moves.filter(m => m.type === 'IN').length,
    scrapCount: moves.filter(m => m.type === 'SCRAP').length,
    moveSum: moves.reduce((s, m) => s + num(m.qty), 0),
  }
}

/** 建一张 CONFIRMED 的采购单，供收货用。返回 PO id 与唯一那行的 lineId */
async function makePO(
  token: string,
  productId: string,
  qty: number,
  opts: { uomId?: string; unitCost?: number } = {},
): Promise<{ poId: string; lineId: string } | null> {
  const supplier = await prisma.customer.findFirst({ where: { isVendor: true }, select: { id: true } })
  if (!supplier) return null
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: productId }, select: { name: true, standardPrice: true },
  })
  const cost = opts.unitCost ?? (num(product.standardPrice) || 1)
  const po = await prisma.purchaseOrder.create({
    data: {
      name: `E5-PO-${Date.now()}-${Math.floor(qty)}`,
      supplierId: supplier.id,
      status: 'CONFIRMED',
      orderDate: new Date(),
      expectedDate: new Date(),
      currency: 'EUR',
      subtotalExTax: cost * qty,
      totalTax: 0,
      totalIncTax: cost * qty,
      lines: {
        create: [{
          productId, productName: product.name,
          orderedQty: qty, receivedQty: 0,
          unitCost: cost, unitCostEur: cost, taxRate: 0,
          ...(opts.uomId ? { uomId: opts.uomId } : {}),
          subtotalExTax: cost * qty, taxAmount: 0, subtotalIncTax: cost * qty,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  return { poId: po.id, lineId: po.lines[0]!.id }
}

/** 记录到货（不再改库存）——POST /api/goods-receipts */
async function recordGoodsReceipt(token: string, poId: string, lines: Array<{
  productId: string; qty: number; condition?: 'ok' | 'damaged' | 'rejected'
}>) {
  const r = await fetch(`${BASE}/api/goods-receipts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ purchaseOrderId: poId, arrivedAt: new Date().toISOString(), lines }),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}

/** 采购确认收货（真正改库存的动作）——PATCH /api/purchase-orders/:id action=receive */
async function confirmReceive(token: string, poId: string, lines?: Array<{ lineId: string; qty: number }>) {
  const r = await fetch(`${BASE}/api/purchase-orders/${poId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: 'receive', ...(lines ? { lines } : {}) }),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}

async function main() {
  const url = process.env.DATABASE_URL ?? ''
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库。当前：', url.replace(/:\/\/[^@]*@/, '://***@'))
    process.exit(1)
  }
  const token = await login()

  const product = await prisma.product.findFirst({
    where: { active: true, qtyOnHand: { gt: 0 } },
    select: { id: true, name: true },
  })
  if (!product) { console.error('测试库没有可用商品'); process.exit(1) }
  const pid = product.id

  // ── 场景 0：goods-receipts 记录到货 = 零库存副作用（不管 condition） ──────
  // 这是本次重构最该守住的回归点：三种 condition 各测一遍，任何一个悄悄改了库存
  // 都当场暴露。同时验证 receivedQty / PO 状态也纹丝不动——那两个现在只归
  // action=receive 管。
  for (const condition of ['ok', 'damaged', 'rejected'] as const) {
    const before = await snapshot(pid)
    const made = await makePO(token, pid, 20)
    if (!made) { skip(`goods-receipts 零副作用（${condition}）`, '无供应商'); continue }
    const res = await recordGoodsReceipt(token, made.poId, [{ productId: pid, qty: 20, condition }])
    const after = await snapshot(pid)
    const line = (await prisma.purchaseOrderLine.findFirst({ where: { id: made.lineId } }))!
    const po = (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: made.poId } }))
    add(`goods-receipts 记录到货零库存副作用（condition=${condition}）`,
      res.status === 201 && after.qty === before.qty && after.moveCount === before.moveCount
      && num(line.receivedQty) === 0 && po.status === 'CONFIRMED',
      `HTTP ${res.status} · 库存 ${before.qty}→${after.qty} · 流水 +${after.moveCount - before.moveCount}`
      + ` · receivedQty=${num(line.receivedQty)}（应 0）· PO 状态=${po.status}（应仍 CONFIRMED）`)
  }

  // ── 场景 1：确认收货（默认按订购量，不传 lines） ──────────────────────────
  {
    const before = await snapshot(pid)
    const made = await makePO(token, pid, 100)
    if (!made) { skip('正常确认收货', '库中无供应商，无法建采购单') }
    else {
      const res = await confirmReceive(token, made.poId)
      const after = await snapshot(pid)
      add('确认收货（不传 lines，默认按订购量 100 全收）',
        res.status === 200
          ? after.qty - before.qty === 100 && after.inCount - before.inCount === 1
          : false,
        `HTTP ${res.status} · 库存 ${before.qty}→${after.qty}（+${after.qty - before.qty}）· IN 流水 +${after.inCount - before.inCount}`)
    }
  }

  // ── 场景 2：按行覆盖为少收（qty < 订购量） ────────────────────────────────
  {
    const before = await snapshot(pid)
    const made = await makePO(token, pid, 100)
    if (!made) skip('少收', '无供应商')
    else {
      const res = await confirmReceive(token, made.poId, [{ lineId: made.lineId, qty: 40 }])
      const after = await snapshot(pid)
      const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: made.poId } })
      add('少收（订 100 确认 40）：库存按确认量入库，未收满维持 CONFIRMED',
        res.status === 200 && after.qty - before.qty === 40 && po.status === 'CONFIRMED',
        `HTTP ${res.status} · 库存 +${after.qty - before.qty}（应 40）· PO 状态=${po.status}（应仍 CONFIRMED）`)
    }
  }

  // ── 场景 3：超收（qty > 订购量） ───────────────────────────────────────────
  {
    const before = await snapshot(pid)
    const made = await makePO(token, pid, 50)
    if (!made) skip('超收', '无供应商')
    else {
      const res = await confirmReceive(token, made.poId, [{ lineId: made.lineId, qty: 80 }])
      const after = await snapshot(pid)
      const delta = after.qty - before.qty
      add('超收（订 50 确认 80）：按确认量入库，不封顶',
        res.status === 200 && delta === 80,
        `HTTP ${res.status} · 库存 +${delta}（应 80）`)
    }
  }

  // ── 场景 4：分批确认（60 + 40 两次调用，每次显式指定本次数量） ────────────
  {
    const before = await snapshot(pid)
    const made = await makePO(token, pid, 100)
    if (!made) skip('分批确认', '无供应商')
    else {
      const r1 = await confirmReceive(token, made.poId, [{ lineId: made.lineId, qty: 60 }])
      const mid = await snapshot(pid)
      const midPo = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: made.poId } })
      const r2 = await confirmReceive(token, made.poId, [{ lineId: made.lineId, qty: 40 }])
      const after = await snapshot(pid)
      const afterPo = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: made.poId } })
      add('分批确认（60 + 40 两次）：中途维持 CONFIRMED，收满转 RECEIVED',
        mid.qty - before.qty === 60 && midPo.status === 'CONFIRMED'
        && after.qty - before.qty === 100 && after.inCount - before.inCount === 2 && afterPo.status === 'RECEIVED',
        `第一次 +${mid.qty - before.qty}（中途状态 ${midPo.status}）· 第二次后累计 +${after.qty - before.qty}`
        + ` · IN 流水 +${after.inCount - before.inCount}（应 2）· 最终状态 ${afterPo.status}（应 RECEIVED）`
        + ` · HTTP ${r1.status}/${r2.status}`)
    }
  }

  // ── 场景 5～8：批次与成本（E5x 补测，原逻辑照搬到新端点）──────────────────
  // G4 查出「批次仅 45 个、凭证 0 张」，结论是**算法对但几乎没有数据流经它**。
  // 确认收货是批次与成本现在的唯一入口，这条链必须有回归测试守着。
  const stamp = Date.now()
  const dedicatedName = `E5x 批次成本测试商品 ${stamp}`
  const tmpl = await prisma.productTemplate.create({
    data: {
      name: dedicatedName, type: 'PRODUCT', status: 'ACTIVE', listPrice: 30, standardPrice: 10,
      uomId: 'uom_pcs', canBeSold: true, canBePurchased: true,
      products: { create: [{ name: dedicatedName, listPrice: 30, standardPrice: 10, qtyOnHand: 0, active: true, status: 'ACTIVE' }] },
    },
    select: { products: { select: { id: true }, take: 1 } },
  })
  const dpid = tmpl.products[0]!.id
  // 期初 100 件 @ €10，连流水一起写（夹具自身必须守恒）
  await prisma.$transaction([
    prisma.stockMove.create({
      data: {
        productId: dpid, productName: dedicatedName, type: 'ADJUSTMENT', qty: 100, movedAt: new Date(),
        note: 'E5x 期初', sourceType: 'TEST_OPENING', sourceRef: 'E5x',
      },
    }),
    prisma.product.update({ where: { id: dpid }, data: { qtyOnHand: 100 } }),
  ])

  // 场景 5 + 6：确认收货 50 件 @ €16 → 建批次；加权平均 (100×10 + 50×16)/150 = 12
  {
    const made = await makePO(token, dpid, 50, { unitCost: 16 })
    if (!made) skip('确认收货建批次 / 加权平均成本', '无供应商')
    else {
      const res = await confirmReceive(token, made.poId, [{ lineId: made.lineId, qty: 50 }])
      const lots = await prisma.lot.findMany({ where: { productId: dpid }, orderBy: { createdAt: 'desc' } })
      const lot = lots[0]
      add('确认收货建出批次（Lot）：sourceType=PURCHASE_RECEIVE（不是历史的 GOODS_RECEIPT）',
        res.status === 200 && lots.length === 1 && !!lot?.lotNumber && lot?.sourceType === 'PURCHASE_RECEIVE' && lot?.sourceId === made.poId,
        `HTTP ${res.status} · 批次数 ${lots.length} · ${lot?.lotNumber ?? '—'} · source=${lot?.sourceType ?? '—'}/${lot?.sourceId ?? '—'}`)
      add('批次余量 = 本次确认量', num(lot?.currentQty) === 50 && num(lot?.initialQty) === 50,
        `initialQty=${num(lot?.initialQty)} currentQty=${num(lot?.currentQty)}（应各 50）`)
      add('批次成本 = 采购单价（毛利/损耗按批次计成本的基础）', num(lot?.unitCost) === 16,
        `unitCost=${num(lot?.unitCost)}（应 16）`)

      const prodAfter = await prisma.product.findUniqueOrThrow({ where: { id: dpid }, select: { standardPrice: true, qtyOnHand: true } })
      add('移动加权平均回写 standardPrice', num(prodAfter.standardPrice) === 12,
        `(100×10 + 50×16) / 150 = ${num(prodAfter.standardPrice)}（应 12）· 库存 ${num(prodAfter.qtyOnHand)}`)
    }
  }

  // 场景 7（I3 回归）：按**箱**确认收货，1 箱 = 12 件
  {
    const before = await snapshot(dpid)
    const made = await makePO(token, dpid, 5, { uomId: 'uom_case', unitCost: 240 })
    if (!made) skip('按箱确认收货换算', '无供应商')
    else {
      const res = await confirmReceive(token, made.poId, [{ lineId: made.lineId, qty: 5 }])
      const after = await snapshot(dpid)
      add('按箱确认收货：库存按基准单位换算（5 箱 = 60 件）',
        res.status === 200 && after.qty - before.qty === 60,
        `HTTP ${res.status} · 库存 +${after.qty - before.qty}（应 60，不是 5）`)
      const lot = (await prisma.lot.findMany({ where: { productId: dpid }, orderBy: { createdAt: 'desc' }, take: 1 }))[0]
      add('按箱确认收货：批次成本折到基准单位（€240/箱 → €20/件）',
        num(lot?.unitCost) === 20 && num(lot?.currentQty) === 60,
        `unitCost=${num(lot?.unitCost)}（应 20）· currentQty=${num(lot?.currentQty)}（应 60）`)
    }
  }

  // ── 场景 8：批次守恒 —— 每个批次的余量必须等于挂在它名下的流水之和 ────────
  {
    const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(`
      SELECT COUNT(*)::bigint AS c FROM "Lot" l
      LEFT JOIN (SELECT "lotId", SUM(qty) AS s FROM "StockMove" WHERE "lotId" IS NOT NULL GROUP BY 1) m ON m."lotId" = l.id
      WHERE ABS(l."currentQty" - COALESCE(m.s, 0)) > 0.001`)
    add('全库批次守恒（Lot.currentQty == Σ该批次流水）',
      Number(rows[0]?.c ?? 0) === 0, `不守恒批次数 ${Number(rows[0]?.c ?? 0)}`)
  }

  // ── 全局：守恒必须仍然成立 ──────────────────────────────────────────────
  {
    const final = await snapshot(pid)
    add('该商品守恒 qtyOnHand == Σ流水',
      Math.abs(final.qty - final.moveSum) < 0.001,
      `qtyOnHand=${final.qty} vs Σ流水=${final.moveSum}`)

    const bad = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(`
      SELECT COUNT(*)::bigint AS c FROM "Product" p
      LEFT JOIN (SELECT "productId", SUM(qty) AS s FROM "StockMove" GROUP BY 1) m ON m."productId" = p.id
      WHERE ABS(p."qtyOnHand" - COALESCE(m.s, 0)) > 0.001`)
    add('全库守恒（本轮测试未制造新的脱钩）',
      Number(bad[0]?.c ?? 0) === 0,
      `不守恒商品数 ${Number(bad[0]?.c ?? 0)}`)
  }

  await prisma.$disconnect()

  console.log('\n──── 收货 → 库存 测试 ────')
  for (const c of cases) {
    const icon = c.state === 'pass' ? '✅' : c.state === 'fail' ? '❌' : '⚠️ '
    console.log(`  ${icon} ${c.name.padEnd(40)} ${c.detail}`)
  }
  const failed = cases.filter(c => c.state === 'fail')
  const skipped = cases.filter(c => c.state === 'skip')
  console.log(`\n合计 ${cases.length} 例 · 通过 ${cases.length - failed.length - skipped.length} · 失败 ${failed.length} · ⚠️ 未获验证 ${skipped.length}`)
  if (failed.length > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
