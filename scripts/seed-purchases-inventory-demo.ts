/**
 * 采购 + 库存管理 演示种子数据
 * ================================================================================
 * 目的：让"采购总览/询价单/生鲜次日备货/目录挑选/干货年度计划/采购单详情"和
 * "库存总览/批次台账·追溯/仓库地图·温区/损耗与退货"这些预览页面有真实感的内容可看，
 * 而不是空页面。按事件链真实调用业务逻辑（建单→发送→确认→收货→开票→锁定），
 * 让 PurchaseOrder/VendorBill/GoodsReceipt/Lot/StockMove 自然产生、互相对得上，
 * 不是分表各插一条互不相关的记录。
 *
 * 数据分两类：
 *   1. 永久配置（不进 manifest，不会被 unseed 脚本删除）：
 *      - ProductSupplierInfo（商品-供应商-进价，真实功能依赖，删了采购建议就退回"无供应商"）
 *      - CategoryGroup.ownerUserId（品类负责人，仅在原先为空时才设置）
 *   2. 演示数据（进 manifest，可整体删除）：
 *      - PurchaseOrder/PurchaseOrderLine/VendorBill/GoodsReceipt/Lot/StockMove(IN/SCRAP)/
 *        PurchaseSuggestion/StockTake+Lines/ActionLog
 *      - 对已有 Product 的 qtyOnHand 只做"增量式"修改（记录每笔 delta），unseed 时按
 *        delta 精确回滚，不整体覆盖快照——避免真实业务在这期间发生的库存变动被误删。
 *
 * 用法：
 *   node --import tsx -r dotenv/config scripts/seed-purchases-inventory-demo.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/seed-purchases-inventory-demo.ts dotenv_config_path=.env.local --apply    # 写库
 *
 * 配套的删除脚本：scripts/unseed-purchases-inventory-demo.ts（读 manifest 按 id 精确删除）
 */
import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { createPurchaseOrder } from '../lib/create-purchase-order'
import { createDraftVendorBillForPurchaseOrder } from '../lib/vendor-bill-from-po'
import { generateFreshDailySuggestions } from '../lib/purchase-suggestions-fresh'
import { generateAnnualDryGoodsPlan } from '../lib/purchase-suggestions-annual'
import { SCRAP_REASON_LABEL } from '../lib/scrap-reasons'

const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) }) as any
const APPLY = process.argv.includes('--apply')
const MANIFEST_PATH = path.join(__dirname, '.demo-seed-manifest.json')
const NOW = new Date()

// ─────────────────────────────────────────────────────────────────────────────
// 可复现的伪随机数（不用 Math.random，保证同一批种子每次跑结果一致）
// ─────────────────────────────────────────────────────────────────────────────
function mulberry32(seed: number) {
  let a = seed
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20260710)
const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)]
const jitter = (base: number, pct: number) => Math.max(0.01, Math.round(base * (1 + (rand() * 2 - 1) * pct) * 100) / 100)
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000)

// ─────────────────────────────────────────────────────────────────────────────
// manifest：记录本次创建的所有 id，供 unseed 脚本精确回滚
// ─────────────────────────────────────────────────────────────────────────────
interface Manifest {
  createdAt: string
  actorUserId: string
  purchaseOrderIds: string[]
  vendorBillIds: string[]
  goodsReceiptIds: string[]
  lotIds: string[]
  stockMoveIds: string[]
  purchaseSuggestionIds: string[]
  stockTakeIds: string[]
  actionLogIds: string[]
  /** 对已有 Product.qtyOnHand 做的增量修改：productId -> 累计 delta，unseed 时精确减去 */
  productQtyDeltas: Record<string, number>
}
const manifest: Manifest = {
  createdAt: NOW.toISOString(),
  actorUserId: '',
  purchaseOrderIds: [],
  vendorBillIds: [],
  goodsReceiptIds: [],
  lotIds: [],
  stockMoveIds: [],
  purchaseSuggestionIds: [],
  stockTakeIds: [],
  actionLogIds: [],
  productQtyDeltas: {},
}
function addQtyDelta(productId: string, delta: number) {
  manifest.productQtyDeltas[productId] = (manifest.productQtyDeltas[productId] ?? 0) + delta
}

// ─────────────────────────────────────────────────────────────────────────────
// 真实供应商（挑选自现有 204 个真实供应商，按品类语义匹配，不新建虚构供应商）
// ─────────────────────────────────────────────────────────────────────────────
const SUPPLIERS = {
  FRESH_FROZEN: ['cf8af6162b85e4c0da3b53cb0' /* Farm Fresh Produce Co-Operative Society Ltd */, 'c7b826ff7deb74ac5ae2c8d9b' /* Badosa Fruits S.L */, 'cd1d1e1c8d94e4f9f834ae2bd' /* Codd Mushroom Ltd */],
  SUPERMARKET: ['cdea06cc6a19547d9bf8f5b64' /* China Cash & Carry */, 'c44a1471ce3464149b1f52187' /* Aldi stores */],
  JAPANESE_KOREAN: ['c7b108c2e3a7646098df74191' /* Asian Food Group */, 'c92f7a8bb093841be9a879f2a' /* Oriental Silk Road Supplier Ltd */],
  DRY_GOODS: ['cd1e931579e8d47b0ac642ac5' /* Indochina Rice Mill Limited */, 'cac2f2d81be964e2ba6f775a0' /* Rongs Wholesale Ltd */],
} as const

const ACTOR_USER_ID = 'cmo2amjyd00006mylvle5i3mq' // 运营主管（已存在的真实系统用户，作为本次演示动作的操作人）

async function writeHistoricalLog(resource: string, resourceId: string, detail: string, createdAt: Date) {
  if (!APPLY) return
  const row = await prisma.actionLog.create({
    data: {
      userId: ACTOR_USER_ID, userEmail: 'operator@veggie.com', userName: '运营主管',
      action: 'UPDATE', resource, resourceId, detail, createdAt,
    },
  })
  manifest.actionLogIds.push(row.id)
}

// ─────────────────────────────────────────────────────────────────────────────
// 阶段 1（永久配置）：品类负责人 + ProductSupplierInfo
// ─────────────────────────────────────────────────────────────────────────────
async function seedOwnersAndSupplierInfo() {
  console.log('\n=== 阶段1：品类负责人 + 商品供应商进价（永久配置，不会被 unseed 删除）===')

  const groups = await prisma.categoryGroup.findMany()
  const REAL_OPERATORS = await prisma.user.findMany({ where: { role: 'OPERATOR' }, orderBy: { id: 'asc' }, take: 4 })
  const ownerByGroupKey: Record<string, string | undefined> = {
    FRESH_FROZEN: REAL_OPERATORS[0]?.id, SUPERMARKET: REAL_OPERATORS[1]?.id,
    JAPANESE_KOREAN: REAL_OPERATORS[2]?.id, DRY_GOODS: REAL_OPERATORS[3]?.id,
  }
  for (const g of groups) {
    if (g.ownerUserId) { console.log(`  ${g.key} 已有负责人，跳过`); continue }
    const ownerId = ownerByGroupKey[g.key]
    if (!ownerId) continue
    console.log(`  ${g.key} 负责人 -> ${ownerId}`)
    if (APPLY) await prisma.categoryGroup.update({ where: { id: g.id }, data: { ownerUserId: ownerId } })
  }

  const groupPools: Record<string, any[]> = {}
  for (const key of Object.keys(SUPPLIERS)) {
    const existingCount = await prisma.productSupplierInfo.count({
      where: { product: { category: { group: { key: key as any } } } },
    })
    const products = await prisma.product.findMany({
      where: { active: true, status: 'ACTIVE', category: { group: { key: key as any } } },
      select: { id: true, name: true, standardPrice: true },
      orderBy: { name: 'asc' },
      take: 40,
    })
    groupPools[key] = products
    if (existingCount > 0) { console.log(`  ${key} 已有 ${existingCount} 条供应商进价，跳过新增`); continue }

    const suppliers = SUPPLIERS[key as keyof typeof SUPPLIERS]
    let created = 0
    for (let i = 0; i < products.length; i++) {
      const prod = products[i]
      const basePrice = Number(prod.standardPrice ?? 0) || jitter(5, 0.3)
      const primarySupplier = suppliers[i % suppliers.length]
      console.log(`    [dry] ${prod.name} <- ${primarySupplier} @ ${jitter(basePrice, 0.08)}`)
      if (APPLY) {
        await prisma.productSupplierInfo.create({
          data: { productId: prod.id, supplierId: primarySupplier, price: jitter(basePrice, 0.08), minQty: 1, sequence: 10, delay: 2 },
        })
      }
      created++
      // ~20% 的商品再挂一个次选供应商（更贵、优先级更低），体现"多供应商比价"
      if (i % 5 === 0 && suppliers.length > 1) {
        const secondary = suppliers[(i + 1) % suppliers.length]
        if (APPLY) {
          await prisma.productSupplierInfo.create({
            data: { productId: prod.id, supplierId: secondary, price: jitter(basePrice, 0.15) * 1.08, minQty: 1, sequence: 20, delay: 4 },
          })
        }
      }
    }
    console.log(`  ${key}: 新增 ${created} 个商品的供应商进价配置`)
  }
  return groupPools
}

// ─────────────────────────────────────────────────────────────────────────────
// 阶段 2：采购单事件链（建单→发送→确认(生成账单)→收货(生成批次)→开票→锁定）
// ─────────────────────────────────────────────────────────────────────────────
type TargetStatus = 'DRAFT' | 'SENT' | 'TO_APPROVE' | 'CONFIRMED' | 'RECEIVED' | 'INVOICED' | 'LOCKED' | 'CANCELLED'

interface POBlueprint {
  groupKey: keyof typeof SUPPLIERS
  supplierId: string
  weeksAgo: number
  target: TargetStatus
  /** 每行 [productIndex-in-pool, qty, 保质期天数(从到货日算起，undefined=不设)] */
  lines: Array<{ productIdx: number; qty: number; bestBeforeDays?: number; costJitter?: number }>
}

async function receiveGoods(po: any, arrivedAt: Date) {
  // 复刻 app/api/goods-receipts/route.ts 的核心逻辑：全量收货 + 建批次 + 记 StockMove + 回写库存/成本
  const grCount = await prisma.goodsReceipt.count()
  const grName = `GR-${String(grCount + 1).padStart(5, '0')}`
  let lotSeq = await prisma.lot.count()

  const gr = await prisma.goodsReceipt.create({
    data: {
      name: grName, purchaseOrderId: po.id, arrivedAt, receivedBy: '运营主管',
      lines: po.lines.map((l: any) => ({ productId: l.productId, productName: l.productName, qty: Number(l.orderedQty), condition: 'ok' })),
      notes: '[DEMO] 演示种子数据生成',
    },
  })
  manifest.goodsReceiptIds.push(gr.id)

  for (const l of po.lines) {
    const qty = Number(l.orderedQty)
    await prisma.purchaseOrderLine.update({ where: { id: l.id }, data: { receivedQty: { increment: qty } } })

    const recvCost = Number(l.unitCost ?? 0)
    const prod = await prisma.product.findUnique({ where: { id: l.productId }, select: { qtyOnHand: true, standardPrice: true } })
    const oldQty = Math.max(Number(prod?.qtyOnHand ?? 0), 0)
    const oldStd = Number(prod?.standardPrice ?? 0)
    const newStd = recvCost > 0 && (oldQty + qty) > 0
      ? Math.round(((oldQty * oldStd + qty * recvCost) / (oldQty + qty)) * 100) / 100 : oldStd
    await prisma.product.update({
      where: { id: l.productId },
      data: { qtyOnHand: { increment: qty }, ...(newStd !== oldStd ? { standardPrice: newStd } : {}) },
    })
    addQtyDelta(l.productId, qty)

    lotSeq++
    const lotNumber = `LOT-${String(lotSeq).padStart(5, '0')}`
    const lot = await prisma.lot.create({
      data: {
        lotNumber, productId: l.productId, initialQty: qty, currentQty: qty,
        sourceType: 'GOODS_RECEIPT', sourceId: gr.id, sourceRef: grName,
        bestBefore: l.bestBefore ?? null, arrivedAt, unitCost: recvCost > 0 ? recvCost : null,
      },
    })
    manifest.lotIds.push(lot.id)

    const move = await prisma.stockMove.create({
      data: {
        productId: l.productId, productName: l.productName, type: 'IN', qty,
        lotId: lot.id, movedAt: arrivedAt,
        note: `[DEMO] 收货 ${grName} / PO ${po.name} / 批次 ${lotNumber}`,
        sourceType: 'GOODS_RECEIPT', sourceId: gr.id, sourceRef: grName,
      },
    })
    manifest.stockMoveIds.push(move.id)
  }

  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'RECEIVED' } })
  return gr
}

async function runPOLifecycle(bp: POBlueprint, pool: any[]) {
  const orderDate = daysAgo(bp.weeksAgo * 7)
  const expectedDate = daysAgo(bp.weeksAgo * 7 - 3)

  const lines = bp.lines.map((l, i) => {
    const prod = pool[l.productIdx % pool.length]
    const baseCost = Number(prod.standardPrice ?? 0) || jitter(5, 0.3)
    const unitCost = jitter(baseCost, l.costJitter ?? 0.05)
    return {
      productId: prod.id, productName: prod.name, orderedQty: l.qty, unitCost,
      sequence: (i + 1) * 10,
      bestBefore: l.bestBeforeDays != null ? new Date(expectedDate.getTime() + l.bestBeforeDays * 86400000) : null,
    }
  })

  console.log(`  [${bp.groupKey}] PO @ ${orderDate.toISOString().slice(0, 10)} -> 目标状态 ${bp.target}，${lines.length} 行`)
  if (!APPLY) return

  const po = await createPurchaseOrder(prisma, {
    supplierId: bp.supplierId, lines, orderDate, expectedDate, notes: '[DEMO] 演示种子数据',
    createdBy: ACTOR_USER_ID,
  })
  manifest.purchaseOrderIds.push(po.id)
  await writeHistoricalLog('purchase_order', po.id, `创建采购单 ${po.name}, 金额 €${Number(po.totalIncTax).toFixed(2)}`, orderDate)
  if (bp.target === 'DRAFT') return

  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT' } })
  await writeHistoricalLog('purchase_order', po.id, `PO ${po.name}: DRAFT → SENT`, new Date(orderDate.getTime() + 3600000))
  if (bp.target === 'SENT') return

  if (bp.target === 'CANCELLED') {
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'CANCELLED', cancelledAt: new Date(orderDate.getTime() + 7200000) } })
    await writeHistoricalLog('purchase_order', po.id, `PO ${po.name}: SENT → CANCELLED`, new Date(orderDate.getTime() + 7200000))
    return
  }

  if (bp.target === 'TO_APPROVE') {
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'TO_APPROVE' } })
    await writeHistoricalLog('purchase_order', po.id, `PO ${po.name}: SENT → TO_APPROVE`, new Date(orderDate.getTime() + 7200000))
    return
  }

  const confirmedAt = new Date(orderDate.getTime() + 86400000)
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'CONFIRMED', confirmedAt } })
  await writeHistoricalLog('purchase_order', po.id, `PO ${po.name}: SENT → CONFIRMED`, confirmedAt)
  const bill = await createDraftVendorBillForPurchaseOrder(prisma, po.id)
  if (bill) manifest.vendorBillIds.push(bill.id)
  if (bp.target === 'CONFIRMED') return

  const poWithLines = await prisma.purchaseOrder.findUnique({ where: { id: po.id }, include: { lines: true } })
  await receiveGoods(poWithLines, expectedDate)
  await writeHistoricalLog('purchase_order', po.id, `PO ${po.name}: CONFIRMED → RECEIVED（${poWithLines.lines.length} 行全部到货）`, expectedDate)
  if (bp.target === 'RECEIVED') return

  const invoicedAt = new Date(expectedDate.getTime() + 86400000)
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'INVOICED' } })
  await writeHistoricalLog('purchase_order', po.id, `PO ${po.name}: RECEIVED → INVOICED`, invoicedAt)
  if (bp.target === 'INVOICED') return

  const lockedAt = new Date(invoicedAt.getTime() + 86400000)
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'LOCKED', lockedAt } })
  await writeHistoricalLog('purchase_order', po.id, `PO ${po.name}: INVOICED → LOCKED`, lockedAt)
}

// ─────────────────────────────────────────────────────────────────────────────
// 阶段 3：报废 + 盘点（损耗与退货仪表盘 / 库存总览 attention）
// ─────────────────────────────────────────────────────────────────────────────
async function seedScrapAndStockTake(freshPool: any[]) {
  console.log('\n=== 阶段3：报废记录 + 待完成盘点单 ===')
  const reasons: Array<keyof typeof SCRAP_REASON_LABEL> = ['WAREHOUSE_EXPIRY', 'WAREHOUSE_DAMAGE', 'OTHER']
  const scrapPlans = [
    { productIdx: 0, qty: 2, weeksAgo: 6, reason: reasons[0] },
    { productIdx: 1, qty: 1, weeksAgo: 5, reason: reasons[1] },
    { productIdx: 2, qty: 3, weeksAgo: 4, reason: reasons[0] },
    { productIdx: 0, qty: 1, weeksAgo: 3, reason: reasons[2] },
    { productIdx: 3, qty: 2, weeksAgo: 2, reason: reasons[1] },
    { productIdx: 1, qty: 1, weeksAgo: 1, reason: reasons[0] },
  ]
  const scrapCount0 = await prisma.stockMove.count({ where: { type: 'SCRAP' } })
  let scrapSeq = scrapCount0
  for (const sp of scrapPlans) {
    const prod = freshPool[sp.productIdx % freshPool.length]
    const movedAt = daysAgo(sp.weeksAgo * 7)
    console.log(`  [dry] 报废 ${prod.name} x${sp.qty} (${SCRAP_REASON_LABEL[sp.reason]}) @ ${movedAt.toISOString().slice(0, 10)}`)
    if (!APPLY) continue

    const current = await prisma.product.findUnique({ where: { id: prod.id }, select: { qtyOnHand: true } })
    if (Number(current?.qtyOnHand ?? 0) < sp.qty) { console.log('    库存不足，跳过'); continue }

    scrapSeq++
    const scrapRef = `SCRAP-${String(scrapSeq).padStart(5, '0')}`
    await prisma.product.update({ where: { id: prod.id }, data: { qtyOnHand: { decrement: sp.qty } } })
    addQtyDelta(prod.id, -sp.qty)

    const move = await prisma.stockMove.create({
      data: {
        productId: prod.id, productName: prod.name, type: 'SCRAP', qty: -sp.qty,
        movedAt, note: `[DEMO] ${SCRAP_REASON_LABEL[sp.reason]} - ${scrapRef}`,
        sourceType: 'SCRAP', sourceRef: scrapRef,
      },
    })
    manifest.stockMoveIds.push(move.id)
    await writeHistoricalLog('scrap', move.id, `报废 ${scrapRef}: ${prod.name} x${sp.qty} (${SCRAP_REASON_LABEL[sp.reason]})`, movedAt)
  }

  // 一张挂起 4 天未完成的盘点单（触发"库存总览"待完成盘点提醒）
  const takenAt = daysAgo(4)
  const stProducts = freshPool.slice(0, 12)
  console.log(`  [dry] 待完成盘点单，覆盖 ${stProducts.length} 个商品，建单日 ${takenAt.toISOString().slice(0, 10)}`)
  if (APPLY) {
    const stCount = await prisma.stockTake.count()
    const stName = `STK-${String(stCount + 1).padStart(5, '0')}`
    const st = await prisma.stockTake.create({
      data: {
        name: stName, takenAt, createdBy: '运营主管', notes: '[DEMO] 演示种子数据',
        lines: { create: stProducts.map((p: any) => ({ productId: p.id, productName: p.name, systemQty: 0 })) },
      },
    })
    manifest.stockTakeIds.push(st.id)
    await writeHistoricalLog('stock_take', st.id, `${stName} 建盘点单，${stProducts.length} 个商品`, takenAt)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== 采购+库存演示种子数据 (${APPLY ? 'APPLY 写库' : 'DRY-RUN 只读'}) ===`)
  manifest.actorUserId = ACTOR_USER_ID

  const pools = await seedOwnersAndSupplierInfo()

  console.log('\n=== 阶段2：采购单事件链（建单→发送→确认→收货→开票→锁定）===')
  const blueprints: POBlueprint[] = []

  // FRESH_FROZEN：8 张，近 6 周历史 + 1 在途 + 1 取消
  const freshSupp = SUPPLIERS.FRESH_FROZEN
  for (let i = 0; i < 6; i++) {
    blueprints.push({
      groupKey: 'FRESH_FROZEN', supplierId: freshSupp[i % freshSupp.length], weeksAgo: 6 - i, target: 'LOCKED',
      lines: [
        { productIdx: i, qty: 20 + i * 3, bestBeforeDays: 30 },
        { productIdx: i + 4, qty: 10 + i, bestBeforeDays: 2 + (i % 3) }, // 部分临期，触发"临期批次"提醒
      ],
    })
  }
  blueprints.push({ groupKey: 'FRESH_FROZEN', supplierId: freshSupp[0], weeksAgo: 0, target: 'CONFIRMED', lines: [{ productIdx: 1, qty: 15 }] })
  blueprints.push({ groupKey: 'FRESH_FROZEN', supplierId: freshSupp[1], weeksAgo: 1, target: 'CANCELLED', lines: [{ productIdx: 8, qty: 12 }] })

  // SUPERMARKET：signature 商品 idx0 走 5 次(近8周)体现进价环比/走势，另加 1 张待发送
  const superSupp = SUPPLIERS.SUPERMARKET
  for (let i = 0; i < 5; i++) {
    blueprints.push({
      groupKey: 'SUPERMARKET', supplierId: superSupp[0], weeksAgo: 8 - i * 2, target: 'LOCKED',
      lines: [
        { productIdx: 0, qty: 30, costJitter: 0.02 }, // 主打商品：价格逐步小幅上涨
        { productIdx: 2 + i, qty: 10 + i * 2 },
      ],
    })
  }
  blueprints.push({ groupKey: 'SUPERMARKET', supplierId: superSupp[1], weeksAgo: 0, target: 'SENT', lines: [{ productIdx: 1, qty: 20 }] })

  // JAPANESE_KOREAN：signature 商品 idx0 走 5 次，价格逐步下降
  const jkSupp = SUPPLIERS.JAPANESE_KOREAN
  for (let i = 0; i < 5; i++) {
    blueprints.push({
      groupKey: 'JAPANESE_KOREAN', supplierId: jkSupp[0], weeksAgo: 8 - i * 2, target: 'LOCKED',
      lines: [
        { productIdx: 0, qty: 24, costJitter: 0.02 },
        { productIdx: 2 + i, qty: 8 + i },
      ],
    })
  }
  blueprints.push({ groupKey: 'JAPANESE_KOREAN', supplierId: jkSupp[1], weeksAgo: 0, target: 'DRAFT', lines: [{ productIdx: 1, qty: 18 }] })

  // DRY_GOODS：铺 12 个月内的采购历史 + 1 张待审批
  const drySupp = SUPPLIERS.DRY_GOODS
  for (let i = 0; i < 5; i++) {
    blueprints.push({
      groupKey: 'DRY_GOODS', supplierId: drySupp[i % drySupp.length], weeksAgo: 10 - i * 2, target: 'LOCKED',
      lines: [
        { productIdx: i, qty: 40 + i * 5 },
        { productIdx: i + 5, qty: 25 },
      ],
    })
  }
  blueprints.push({
    groupKey: 'DRY_GOODS', supplierId: drySupp[0], weeksAgo: 0, target: 'TO_APPROVE',
    lines: [{ productIdx: 2, qty: 60 }, { productIdx: 6, qty: 45 }],
  })

  // 按时间正序执行（先发生的先落库，符合事件链时序）
  blueprints.sort((a, b) => b.weeksAgo - a.weeksAgo)
  for (const bp of blueprints) {
    await runPOLifecycle(bp, pools[bp.groupKey])
  }

  console.log('\n=== 阶段2.5：调用真实生成函数产出采购建议 ===')
  if (APPLY) {
    const scriptStart = new Date()
    const freshRows = await generateFreshDailySuggestions()
    console.log(`  生鲜次日备货：生成 ${freshRows.length} 条`)
    const annualRows = await generateAnnualDryGoodsPlan()
    console.log(`  干货年度计划：生成 ${annualRows.length} 条`)
    const newSuggestions = await prisma.purchaseSuggestion.findMany({
      where: { generatedAt: { gte: scriptStart }, categoryGroupKey: { in: ['FRESH_FROZEN', 'DRY_GOODS'] } },
      select: { id: true },
    })
    manifest.purchaseSuggestionIds.push(...newSuggestions.map((r: any) => r.id))
  } else {
    console.log('  [dry] 会调用 generateFreshDailySuggestions() + generateAnnualDryGoodsPlan()')
  }

  await seedScrapAndStockTake(pools.FRESH_FROZEN ?? [])

  if (APPLY) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
    console.log(`\nmanifest 已写入 ${MANIFEST_PATH}`)
  }

  console.log('\n=== 汇总 ===')
  console.log(`采购单: ${manifest.purchaseOrderIds.length}`)
  console.log(`供应商账单: ${manifest.vendorBillIds.length}`)
  console.log(`收货单: ${manifest.goodsReceiptIds.length}`)
  console.log(`批次: ${manifest.lotIds.length}`)
  console.log(`库存流水: ${manifest.stockMoveIds.length}`)
  console.log(`采购建议: ${manifest.purchaseSuggestionIds.length}`)
  console.log(`盘点单: ${manifest.stockTakeIds.length}`)
  console.log(`操作日志: ${manifest.actionLogIds.length}`)
  console.log(`涉及商品库存增量调整: ${Object.keys(manifest.productQtyDeltas).length} 个`)

  if (!APPLY) console.log('\n这是 dry-run，未写入数据库。加 --apply 才会真正写库。')
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
