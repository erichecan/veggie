/**
 * 修复：DELETE /api/driver-slots/[id] 顺序 bug 留下的孤儿数据（先归档、后清理，清理撞拣货锁
 * 抛错时归档已生效但订单没退回待分配）。见 app/api/driver-slots/[id]/route.ts 本次的顺序修复。
 *
 * 全库扫描确认只有 2 个已归档托盘受影响：ALI/am#2、Moazzam/am#1，共 4 处 Pallet 残留、3 条波次
 * 仍处于 2026-07-09 23:07 那批"运营主管"锁定(用户已在同一会话里确认过是死锁并解锁过同批次的
 * 另外 3 组)。本脚本：1) 解锁这 3 条波次 2) 对这 2 个已归档托盘补跑一遍清理(把订单从 wave.orderIds
 * 摘除、WAVE_ASSIGNED 订单退回 CONFIRMED、删除 Pallet)。
 *
 *   npx tsx --env-file=.env.local scripts/repair-orphaned-archived-pallets.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/repair-orphaned-archived-pallets.ts --apply  # 实际修复
 */
import 'dotenv/config'
import { neonConfig } from '@neondatabase/serverless'
import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaClient, Prisma } from '../lib/generated/prisma/client'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')
const LOCKED_WAVE_IDS = ['cmr46dgra003201s6gy0lf0md', 'cmr46dgnu002v01s62va5jeby', 'cmr5kdzo8001001s62a75w5r6']
const AFFECTED_SLOT_IDS = ['cmqp8q8pr000001s6azkm7lmd', 'cb31639b-d17c-45b1-ba7f-6104232d087d']

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
  console.log(`\n=== 修复孤儿托盘数据 (${APPLY ? 'APPLY 实际修复' : 'DRY-RUN 只读'}) ===\n`)

  const waves = await prisma.pickingWave.findMany({ where: { id: { in: LOCKED_WAVE_IDS } }, select: { id: true, pickLockedAt: true } })
  console.log('步骤1：解锁波次')
  for (const w of waves) console.log(`  ${w.id}  当前锁定=${!!w.pickLockedAt}`)
  if (APPLY) {
    await prisma.pickingWave.updateMany({
      where: { id: { in: LOCKED_WAVE_IDS }, pickLockedAt: { not: null } },
      data: { pickLockedAt: null, pickLockedBy: null, pickUnlockedAt: new Date() },
    })
  }

  console.log('\n步骤2：补完清理')
  let totalUnassigned = 0
  for (const slotId of AFFECTED_SLOT_IDS) {
    const slot = await prisma.driverSlot.findUnique({ where: { id: slotId } })
    if (!slot) { console.log(`  ⛔ 托盘 ${slotId} 不存在，跳过`); continue }
    const slotWaves = await prisma.pickingWave.findMany({ where: { driverName: slot.driverName, timeOfDay: slot.timeOfDay, dispatchedAt: null } })
    for (const wave of slotWaves) {
      const pallet = await prisma.pallet.findUnique({ where: { waveId_seq: { waveId: wave.id, seq: slot.batchNum } } })
      if (!pallet) continue
      const orderIdsInPallet = [...new Set(((pallet.items as Array<{ orderId: string }>) ?? []).map((it) => it.orderId))]
      console.log(`  ${slot.driverName}/${slot.timeOfDay}#${slot.batchNum}  波次 ${wave.id}  ${orderIdsInPallet.length} 单退回待分配`)
      totalUnassigned += orderIdsInPallet.length
      if (!APPLY) continue
      const remaining = (wave.orderIds as string[]).filter((oid) => !orderIdsInPallet.includes(oid))
      const zones = await buildZonesByRestaurant(remaining)
      await prisma.$transaction([
        prisma.pickingWave.update({ where: { id: wave.id }, data: { orderIds: remaining, zones } }),
        prisma.order.updateMany({ where: { id: { in: orderIdsInPallet }, status: 'WAVE_ASSIGNED' }, data: { status: 'CONFIRMED' } }),
        prisma.pallet.delete({ where: { id: pallet.id } }),
      ])
    }
  }

  console.log(`\n—— 汇总 ——`)
  console.log(`${APPLY ? '已' : '计划'}退回待分配订单数：${totalUnassigned}`)
  if (!APPLY) console.log('\nDRY-RUN 结束，未写库。确认无误后加 --apply 执行。\n')
  else console.log('\n✅ 完成。\n')

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
