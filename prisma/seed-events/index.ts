/**
 * 事件驱动种子 · 入口
 * ============================================================================
 * 运行：npm run db:seed:events   （需先 npm run db:seed 准备主数据）
 * 环境变量：SEED_SCALE = small | medium | large（默认 small）
 *
 * 流程：清理标记数据 → 重置库存基线 → 派生画像 → 进货 → 销售(确认扣库存) →
 *       开票收款记账 → 异常场景 → 守恒断言。
 * 幂等：只清理带标记的数据 + 重置库存（StockMove/Lot 由本种子全权拥有）。
 */
import 'dotenv/config'
import { neonConfig } from '@neondatabase/serverless'
import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaClient } from '../../lib/generated/prisma/client'
import ws from 'ws'
import { Rng } from './rng'
import { Counter, MARK, SCALE_CONFIG, type Ctx, type Scale } from './context'
import { buildPersonas } from './personas'
import { runPurchasing } from './events/purchase'
import { runSales } from './events/sales'
import { runBilling } from './events/billing'
import { runScenarios } from './events/scenarios'
import { recomputeOnHand } from './inventory'
import { runAssertions } from './assert'

neonConfig.webSocketConstructor = ws
const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

const SEED = 20260613

async function cleanup(): Promise<void> {
  console.log('🧹 清理上一轮带标记的事件数据...')
  await prisma.journalEntry.deleteMany({ where: { narration: { contains: MARK.jeMarker } } })
  await prisma.invoice.deleteMany({ where: { name: { startsWith: MARK.invPrefix } } })
  await prisma.creditNote.deleteMany({ where: { name: { startsWith: MARK.cnPrefix } } })
  await prisma.vendorBill.deleteMany({ where: { name: { startsWith: MARK.vbPrefix } } })
  await prisma.order.deleteMany({ where: { externalRef: MARK.orderRef } })
  await prisma.pickingWave.deleteMany({ where: { name: { startsWith: MARK.wavePrefix } } })
  await prisma.trip.deleteMany({ where: { name: { startsWith: MARK.tripPrefix } } })
  await prisma.purchaseSuggestion.deleteMany({ where: { tenantId: MARK.tenant } })
  await prisma.notification.deleteMany({ where: { tenantId: MARK.tenant } })
  await prisma.statement.deleteMany({ where: { tenantId: MARK.tenant } })
  await prisma.purchaseOrder.deleteMany({ where: { name: { startsWith: MARK.poPrefix } } })
  await prisma.customer.deleteMany({ where: { externalId: MARK.vendorExternalId } })
}

async function resetSeedArtifacts(): Promise<void> {
  // 本种子是库存 + 配送编排的唯一权威：清空流水/批次/波次/行程并归零库存，
  // 再由事件重建，避免与旧种子(seed-waves/seed-transactions)的 (waveDate,driverSlot) 撞约束。
  console.log('♻️  重置库存与配送编排（StockMove/Lot/PickingWave/Trip 清空，qtyOnHand=0）...')
  await prisma.stockMove.deleteMany({})
  await prisma.lot.deleteMany({})
  await prisma.pickingWave.deleteMany({})
  await prisma.trip.deleteMany({})
  await prisma.product.updateMany({ data: { qtyOnHand: 0 } })
}

async function main(): Promise<void> {
  const t0 = Date.now()
  const scaleName = (process.env.SEED_SCALE as Scale) || 'small'
  const scale = SCALE_CONFIG[scaleName] ?? SCALE_CONFIG.small
  console.log(`🌱 事件驱动种子启动（scale=${scaleName}）`)

  await cleanup()
  await resetSeedArtifacts()

  // 关键用户
  const operator = await prisma.user.findFirst({ where: { role: 'OPERATOR' }, select: { id: true, name: true } })
  const finance = await prisma.user.findFirst({ where: { role: 'FINANCE' }, select: { id: true } })
  const driver = await prisma.user.findFirst({ where: { role: 'DRIVER' }, select: { id: true } })
  if (!operator) throw new Error('缺少 OPERATOR 用户，请先 npm run db:seed')

  const { products, personas, supplierIds, driverSlots } = await buildPersonas(prisma, scale.customers)
  console.log(`👥 画像：${personas.length} 客户 · ${products.length} 商品 · ${supplierIds.length} 供应商 · ${driverSlots.length} 司机`)

  const ctx: Ctx = {
    prisma,
    rng: new Rng(SEED),
    now: new Date(),
    scale,
    operatorId: operator.id,
    operatorName: operator.name,
    financeId: finance?.id ?? operator.id,
    driverUserId: driver?.id ?? null,
    lot: new Counter(),
    po: new Counter(),
    gr: new Counter(),
    vb: new Counter(),
    inv: new Counter(),
    cn: new Counter(),
    disc: new Counter(),
    products,
    personas,
    salesmen: [],
    driverSlots,
    supplierIds,
    _orderSeq: 0,
  }

  console.log('📦 进货入库...')
  await runPurchasing(ctx)
  console.log('🧾 销售下单/确认/送达...')
  const allOrders = await runSales(ctx)
  const completed = allOrders.filter((o) => o.stage === 'COMPLETED')
  console.log(`   全订单 ${allOrders.length} · 完成 ${completed.length}`)
  console.log('💶 开票/收款/对账...')
  await runBilling(ctx, completed)
  console.log('⚠️  异常场景...')
  await runScenarios(ctx, allOrders, completed)

  console.log('🧮 重算库存 qtyOnHand（从流水汇总）...')
  await recomputeOnHand(prisma)

  await runAssertions(prisma)

  // 计数汇总
  const [orders, invoices, payments, lots, moves, pos] = await Promise.all([
    prisma.order.count({ where: { externalRef: MARK.orderRef } }),
    prisma.invoice.count({ where: { name: { startsWith: MARK.invPrefix } } }),
    prisma.payment.count(),
    prisma.lot.count(),
    prisma.stockMove.count(),
    prisma.purchaseOrder.count({ where: { name: { startsWith: MARK.poPrefix } } }),
  ])
  console.log('\n──── 产出汇总 ────')
  console.log(`  订单 ${orders} · 发票 ${invoices} · 收款 ${payments} · 采购单 ${pos}`)
  console.log(`  批次 ${lots} · 库存流水 ${moves}`)
  console.log(`\n⏱  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (e) => {
    console.error('💥 种子失败：', e)
    await prisma.$disconnect()
    process.exit(1)
  })
