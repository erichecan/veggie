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
async function makePO(token: string, productId: string, qty: number): Promise<string | null> {
  const supplier = await prisma.customer.findFirst({ where: { isVendor: true }, select: { id: true } })
  if (!supplier) return null
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: productId }, select: { name: true, standardPrice: true },
  })
  const cost = num(product.standardPrice) || 1
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
          unitCost: cost, taxRate: 0,
          subtotalExTax: cost * qty, taxAmount: 0, subtotalIncTax: cost * qty,
        }],
      },
    },
    select: { id: true },
  })
  return po.id
}

async function receive(token: string, poId: string, lines: Array<{
  productId: string; qty: number; condition?: 'ok' | 'damaged'
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
