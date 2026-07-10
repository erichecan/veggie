/**
 * 测试阶段重置：把 deliveryDate 在 2026-06-10~2026-07-10 范围内的全部销售订单
 * （不分状态，含 WAVE_ASSIGNED/CONFIRMED/CANCELLED/PENDING）统一改回 CONFIRMED（待分配）。
 *
 * 背景：这段时间历史脏数据(孤儿订单、波次归属不一致等)持续造成销售单列表与配送调度中心
 * 数量对不上，用户决定一次性清空重置。已摸底确认：该范围内没有 LOCKED(已开票)、没有
 * COMPLETED(已完成配送)订单，波次一个都没真正出发过(0 条 Trip)，不涉及已成立的账。
 * 用户已明确要求 4 种状态(含 CANCELLED 废单、PENDING 报价单)全部强制改成 CONFIRMED。
 *
 * 对每个命中订单：
 *   1. status 统一改为 CONFIRMED
 *   2. 从它所在的任何波次 orderIds 里摘除(有的话)，波次 zones 同步重算
 *   3. 从它所在的任何 Pallet.items 里摘除(有的话)
 *
 *   npx tsx --env-file=.env.local scripts/reset-orders-0610-to-today.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/reset-orders-0610-to-today.ts --apply  # 实际重置
 */
import 'dotenv/config'
import { neonConfig } from '@neondatabase/serverless'
import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaClient, Prisma } from '../lib/generated/prisma/client'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')
const RANGE = { gte: new Date('2026-06-10T00:00:00.000Z'), lte: new Date('2026-07-10T23:59:59.999Z') }

async function buildZonesByRestaurant(orderIds: string[]): Promise<Prisma.InputJsonValue> {
  if (orderIds.length === 0) return [] as Prisma.InputJsonValue
  const orders = await prisma.order.findMany({ where: { id: { in: orderIds } } })
  const zones: Array<{ name: string; items: Array<{ productId: string; productName: string; spec: string; image: string; requiredQty: number; pickedQty: number; restaurants: string[]; done: boolean; uomName?: string }> }> = []
  for (const order of orders) {
    const items = (order.items as Array<{ productId: string; productName: string; spec?: string; quantity: number; uomName?: string }>) ?? []
    let zone = zones.find((z) => z.name === order.restaurantName)
    if (!zone) { zone = { name: order.restaurantName, items: [] }; zones.push(zone) }
    for (const item of items) {
      const existing = zone.items.find((i) => i.productId === item.productId)
      if (existing) existing.requiredQty += item.quantity
      else zone.items.push({ productId: item.productId, productName: item.productName, spec: item.spec ?? '', image: '', requiredQty: item.quantity, pickedQty: 0, restaurants: [order.restaurantName], done: false, uomName: item.uomName })
    }
  }
  return zones as unknown as Prisma.InputJsonValue
}

async function main() {
  const orders = await prisma.order.findMany({
    where: { deliveryDate: RANGE },
    select: { id: true, code: true, status: true, deliveryDate: true },
  })
  const byStatus: Record<string, number> = {}
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1

  console.log(`\n=== 重置 2026-06-10~2026-07-10 订单为待分配 (${APPLY ? 'APPLY 实际执行' : 'DRY-RUN 只读'}) ===\n`)
  console.log(`命中订单数：${orders.length}，按状态：`, byStatus)

  const orderIds = orders.map((o) => o.id)
  const waves = await prisma.pickingWave.findMany({ where: { orderIds: { hasSome: orderIds } } })
  console.log(`涉及波次数：${waves.length}`)

  if (!APPLY) {
    console.log('\nDRY-RUN 结束，未写库。确认无误后加 --apply 执行。\n')
    await prisma.$disconnect()
    return
  }

  const orderIdSet = new Set(orderIds)
  await prisma.$transaction(async (tx) => {
    for (const wave of waves) {
      const remaining = (wave.orderIds as string[]).filter((id) => !orderIdSet.has(id))
      if (remaining.length === (wave.orderIds as string[]).length) continue
      const zones = await buildZonesByRestaurant(remaining)
      await tx.pickingWave.update({ where: { id: wave.id }, data: { orderIds: remaining, zones } })

      const pallets = await tx.pallet.findMany({ where: { waveId: wave.id } })
      for (const p of pallets) {
        const items = (p.items as Array<{ orderId: string }>) ?? []
        const kept = items.filter((it) => !orderIdSet.has(it.orderId))
        if (kept.length === items.length) continue
        if (kept.length === 0) await tx.pallet.delete({ where: { id: p.id } })
        else await tx.pallet.update({ where: { id: p.id }, data: { items: kept } })
      }
    }

    await tx.order.updateMany({ where: { id: { in: orderIds } }, data: { status: 'CONFIRMED' } })
  }, { timeout: 60000 })

  console.log(`\n✅ 已重置 ${orders.length} 个订单为 CONFIRMED、退回待分配（涉及 ${waves.length} 条波次同步清理）。\n`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
