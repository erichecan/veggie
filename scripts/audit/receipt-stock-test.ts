/**
 * 收货 → 库存 测试用例
 * ============================================================================
 * 台账 E5。对应需求原话：「库存更新：需要 AI 写测试用例去做检查」。
 *
 * 六个场景，每个都做**收货前后快照对比**，断言三件事：
 *   1. `Product.qtyOnHand` 的增量恰好等于本次良品收货量
 *   2. `StockMove` 新增条数与类型符合预期（良品 IN / 损坏 SCRAP）
 *   3. 收完仍满足全局不变量 `qtyOnHand == Σ StockMove`（守恒）
 *
 * 第 3 条是重点：E3 查出过 qtyOnHand 与流水脱钩的历史病灶，任何往库存里写东西
 * 的路径都必须当场验证它没有再制造脱钩，否则又是一笔「以后再说」的债。
 *
 * ⛔ 本脚本会写库（建 PO、收货）。只允许打向本机 veggie_test。
 *
 * 用法（需先起服务）：
 *   npx tsx --env-file=.env.test scripts/audit/receipt-stock-test.ts
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
const PASSWORD = process.env.SEED_PASSWORD ?? 'LocalTest2026!'

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
    body: JSON.stringify({ email: OPERATOR, password: PASSWORD }),
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

/** 建一张 CONFIRMED 的采购单，供收货用 */
async function makePO(
  token: string,
  productId: string,
  qty: number,
  opts: { uomId?: string; unitCost?: number } = {},
): Promise<string | null> {
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
    select: { id: true },
  })
  return po.id
}

async function receive(token: string, poId: string, lines: Array<{
  productId: string; qty: number; condition?: 'ok' | 'damaged'; uomId?: string
}>) {
  const r = await fetch(`${BASE}/api/goods-receipts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ purchaseOrderId: poId, arrivedAt: new Date().toISOString(), lines }),
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

  // ── 场景 1：正常收货（足额良品） ────────────────────────────────────────
  {
    const before = await snapshot(pid)
    const po = await makePO(token, pid, 100)
    if (!po) { skip('正常收货', '库中无供应商，无法建采购单'); }
    else {
      const res = await receive(token, po, [{ productId: pid, qty: 100, condition: 'ok' }])
      const after = await snapshot(pid)
      add('正常收货（足额良品）',
        res.status === 200 || res.status === 201
          ? after.qty - before.qty === 100 && after.inCount - before.inCount === 1
          : false,
        `HTTP ${res.status} · 库存 ${before.qty}→${after.qty}（+${after.qty - before.qty}）· IN 流水 +${after.inCount - before.inCount}`)
    }
  }

  // ── 场景 2：少收（收货量 < 订购量） ────────────────────────────────────
  {
    const before = await snapshot(pid)
    const po = await makePO(token, pid, 100)
    if (!po) skip('少收', '无供应商')
    else {
      const res = await receive(token, po, [{ productId: pid, qty: 40, condition: 'ok' }])
      const after = await snapshot(pid)
      add('少收（订 100 收 40）',
        after.qty - before.qty === 40,
        `库存 +${after.qty - before.qty}（应为 40，按实收而非订购量入库）`)
    }
  }

  // ── 场景 3：超收（收货量 > 订购量） ────────────────────────────────────
  {
    const before = await snapshot(pid)
    const po = await makePO(token, pid, 50)
    if (!po) skip('超收', '无供应商')
    else {
      const res = await receive(token, po, [{ productId: pid, qty: 80, condition: 'ok' }])
      const after = await snapshot(pid)
      const delta = after.qty - before.qty
      // 超收该被拒（409/400）还是按实收入库（+80），两种设计都成立，
      // 但不能出现「按订购量 50 入库」这种既非拒绝也非实收的第三种结果
      const sane = (res.status >= 400 && delta === 0) || delta === 80
      add('超收（订 50 收 80）', sane,
        `HTTP ${res.status} · 库存 +${delta}（应为「拒绝且 +0」或「按实收 +80」，不得为 +50）`)
    }
  }

  // ── 场景 4：部分收货（同一 PO 分两次收） ──────────────────────────────
  {
    const before = await snapshot(pid)
    const po = await makePO(token, pid, 100)
    if (!po) skip('部分收货', '无供应商')
    else {
      await receive(token, po, [{ productId: pid, qty: 60, condition: 'ok' }])
      const mid = await snapshot(pid)
      const r2 = await receive(token, po, [{ productId: pid, qty: 40, condition: 'ok' }])
      const after = await snapshot(pid)
      add('部分收货（60 + 40 分两次）',
        mid.qty - before.qty === 60 && after.qty - before.qty === 100 && after.inCount - before.inCount === 2,
        `第一次 +${mid.qty - before.qty} · 第二次后累计 +${after.qty - before.qty} · IN 流水 +${after.inCount - before.inCount}（应为 2 条）· 第二次 HTTP ${r2.status}`)
    }
  }

  // ── 场景 5：收到损坏品（不进库存，只留 SCRAP 痕迹） ──────────────────
  {
    const before = await snapshot(pid)
    const po = await makePO(token, pid, 30)
    if (!po) skip('损坏品', '无供应商')
    else {
      const res = await receive(token, po, [{ productId: pid, qty: 30, condition: 'damaged' }])
      const after = await snapshot(pid)
      // 损坏品记两笔：IN(+qty) 紧跟 SCRAP(-qty)，净额 0 —— 既不进库存又不破坏守恒
      add('损坏品（不进库存，留 SCRAP 痕迹）',
        after.qty === before.qty
        && after.scrapCount - before.scrapCount === 1
        && after.inCount - before.inCount === 1
        && Math.abs(after.moveSum - before.moveSum) < 0.001,
        `HTTP ${res.status} · 库存变化 ${after.qty - before.qty}（应 0）· IN +${after.inCount - before.inCount} · SCRAP +${after.scrapCount - before.scrapCount} · 流水净额 ${after.moveSum - before.moveSum}（应 0）`)
    }
  }

  // ── 场景 6：良品 + 损坏混合收 ──────────────────────────────────────────
  {
    const before = await snapshot(pid)
    const po = await makePO(token, pid, 50)
    if (!po) skip('混合收货', '无供应商')
    else {
      const res = await receive(token, po, [
        { productId: pid, qty: 35, condition: 'ok' },
        { productId: pid, qty: 15, condition: 'damaged' },
      ])
      const after = await snapshot(pid)
      // 良品 1 笔 IN；损坏品 1 笔 IN + 1 笔 SCRAP → 共 2 笔 IN、1 笔 SCRAP，净额 = 良品量
      add('混合收货（35 良 + 15 损）',
        after.qty - before.qty === 35
        && after.inCount - before.inCount === 2
        && after.scrapCount - before.scrapCount === 1
        && Math.abs((after.moveSum - before.moveSum) - 35) < 0.001,
        `库存 +${after.qty - before.qty}（应 35，只算良品）· IN +${after.inCount - before.inCount}（应 2）· SCRAP +${after.scrapCount - before.scrapCount} · 流水净额 ${after.moveSum - before.moveSum}（应 35）`)
    }
  }

  // ── 场景 7~10：批次与成本（E5x 补测）───────────────────────────────────
  // G4 查出「批次仅 45 个、凭证 0 张」，结论是**算法对但几乎没有数据流经它**。
  // 收货是批次与成本的唯一入口，所以这条链必须有回归测试守着：
  // 建批次 → 批次余量 → 批次成本 → 移动加权平均 → 批次守恒。
  // 用**专用商品**而不是共享商品：加权平均要拿已知的期初数量与成本算，
  // 借别人的商品算出来的期望值会被其它用例的收货改掉。
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

  // 场景 7 + 8：收 50 件 @ €16 → 建批次；加权平均 (100×10 + 50×16)/150 = 12
  {
    const po = await makePO(token, dpid, 50, { unitCost: 16 })
    if (!po) skip('收货建批次 / 加权平均成本', '无供应商')
    else {
      const res = await receive(token, po, [{ productId: dpid, qty: 50, condition: 'ok' }])
      const lots = await prisma.lot.findMany({ where: { productId: dpid }, orderBy: { createdAt: 'desc' } })
      const lot = lots[0]
      add('收货建出批次（Lot）',
        res.status === 201 && lots.length === 1 && !!lot?.lotNumber && lot?.sourceType === 'GOODS_RECEIPT',
        `HTTP ${res.status} · 批次数 ${lots.length} · ${lot?.lotNumber ?? '—'} · source=${lot?.sourceType ?? '—'}`)
      add('批次余量 = 本次收货量', num(lot?.currentQty) === 50 && num(lot?.initialQty) === 50,
        `initialQty=${num(lot?.initialQty)} currentQty=${num(lot?.currentQty)}（应各 50）`)
      add('批次成本 = 采购单价（毛利/损耗按批次计成本的基础）', num(lot?.unitCost) === 16,
        `unitCost=${num(lot?.unitCost)}（应 16）`)

      const prodAfter = await prisma.product.findUniqueOrThrow({ where: { id: dpid }, select: { standardPrice: true, qtyOnHand: true } })
      add('移动加权平均回写 standardPrice', num(prodAfter.standardPrice) === 12,
        `(100×10 + 50×16) / 150 = ${num(prodAfter.standardPrice)}（应 12）· 库存 ${num(prodAfter.qtyOnHand)}`)
    }
  }

  // 场景 9（I3 回归）：按**箱**收货，1 箱 = 12 件
  // 此前收货侧从不换算，收 5 箱只加 5 件；单价也必须同步换算，否则成本虚高 12 倍
  {
    const before = await snapshot(dpid)
    const po = await makePO(token, dpid, 5, { uomId: 'uom_case', unitCost: 240 })
    if (!po) skip('按箱收货换算', '无供应商')
    else {
      const res = await receive(token, po, [{ productId: dpid, qty: 5, condition: 'ok', uomId: 'uom_case' }])
      const after = await snapshot(dpid)
      add('按箱收货：库存按基准单位换算（5 箱 = 60 件）',
        res.status === 201 && after.qty - before.qty === 60,
        `HTTP ${res.status} · 库存 +${after.qty - before.qty}（应 60，不是 5）`)
      const lot = (await prisma.lot.findMany({ where: { productId: dpid }, orderBy: { createdAt: 'desc' }, take: 1 }))[0]
      add('按箱收货：批次成本折到基准单位（€240/箱 → €20/件）',
        num(lot?.unitCost) === 20 && num(lot?.currentQty) === 60,
        `unitCost=${num(lot?.unitCost)}（应 20）· currentQty=${num(lot?.currentQty)}（应 60）`)
    }
  }

  // 场景 10：损坏品不建批次（货没进库，不该凭空多一个可发的批次）
  {
    const lotsBefore = await prisma.lot.count({ where: { productId: dpid } })
    const po = await makePO(token, dpid, 8, { unitCost: 16 })
    if (!po) skip('损坏品不建批次', '无供应商')
    else {
      await receive(token, po, [{ productId: dpid, qty: 8, condition: 'damaged' }])
      const lotsAfter = await prisma.lot.count({ where: { productId: dpid } })
      add('损坏品不建批次', lotsAfter === lotsBefore, `批次数 ${lotsBefore} → ${lotsAfter}（应不变）`)
    }
  }

  // 场景 11：批次守恒 —— 每个批次的余量必须等于挂在它名下的流水之和
  {
    const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(`
      SELECT COUNT(*)::bigint AS c FROM "Lot" l
      LEFT JOIN (SELECT "lotId", SUM(qty) AS s FROM "StockMove" WHERE "lotId" IS NOT NULL GROUP BY 1) m ON m."lotId" = l.id
      WHERE ABS(l."currentQty" - COALESCE(m.s, 0)) > 0.001`)
    add('全库批次守恒（Lot.currentQty == Σ该批次流水）',
      Number(rows[0]?.c ?? 0) === 0, `不守恒批次数 ${Number(rows[0]?.c ?? 0)}`)
  }

  // 场景 12：收货损坏的 SCRAP 流水要带结构化归因（台账 E4 的环节字段）
  {
    const damaged = await prisma.stockMove.findFirst({
      where: { productId: dpid, type: 'SCRAP', sourceType: 'RECEIPT_DAMAGE' },
      orderBy: { createdAt: 'desc' },
      select: { lossStage: true, lossReason: true },
    })
    if (!damaged) skip('收货损坏带结构化归因', '本轮没有产生收货损坏流水')
    else {
      add('收货损坏的 SCRAP 带环节=收货、原因=到货即损坏',
        damaged.lossStage === 'RECEIPT' && damaged.lossReason === 'RECEIPT_DAMAGE',
        `lossStage=${damaged.lossStage ?? 'null'} lossReason=${damaged.lossReason ?? 'null'}`)
    }
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
    add('全库守恒（收货未制造新的脱钩）',
      Number(bad[0]?.c ?? 0) === 0,
      `不守恒商品数 ${Number(bad[0]?.c ?? 0)}`)
  }

  await prisma.$disconnect()

  console.log('\n──── 收货 → 库存 测试 ────')
  for (const c of cases) {
    const icon = c.state === 'pass' ? '✅' : c.state === 'fail' ? '❌' : '⚠️ '
    console.log(`  ${icon} ${c.name.padEnd(30)} ${c.detail}`)
  }
  const failed = cases.filter(c => c.state === 'fail')
  const skipped = cases.filter(c => c.state === 'skip')
  console.log(`\n合计 ${cases.length} 例 · 通过 ${cases.length - failed.length - skipped.length} · 失败 ${failed.length} · ⚠️ 未获验证 ${skipped.length}`)
  if (failed.length > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
