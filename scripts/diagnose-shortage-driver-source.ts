/**
 * 只读诊断：缺货处理司机 chip 少一个的根因。
 * 对比某配送日「按 wave 派生司机」(配送调度中心口径) vs「按 Order.driverSlot 派生司机」(缺货处理现口径)。
 *   npx tsx --env-file=.env.local scripts/diagnose-shortage-driver-source.ts 2026-07-04
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'
import { PrismaClient, type $Enums } from '../lib/generated/prisma/client'

const prisma = createPrismaClient()

async function main(): Promise<void> {
  const date = process.argv[2] ?? '2026-07-04'
  const dayStart = new Date(date + 'T00:00:00.000Z')
  const dayEnd = new Date(date + 'T23:59:59.999Z')
  const statusFilter: $Enums.OrderStatus[] = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY']

  // 缺货处理拉的订单口径
  const orders = await prisma.order.findMany({
    where: { status: { in: statusFilter }, deliveryDate: { gte: dayStart, lte: dayEnd } },
    select: { id: true, code: true, driverSlotId: true },
  })
  const slots = await prisma.driverSlot.findMany({ select: { id: true, driverName: true } })
  const slotMap = new Map(slots.map(s => [s.id, s.driverName]))

  // A：按 Order.driverSlot 派生（现口径）
  const byOrderSlot = new Set<string>()
  let noSlot = 0
  for (const o of orders) {
    const n = o.driverSlotId ? slotMap.get(o.driverSlotId) : null
    if (n) byOrderSlot.add(n)
    else noSlot++
  }

  // B：按 wave 派生（配送调度中心口径）
  const waves = await prisma.pickingWave.findMany({
    where: { waveDate: dayStart },
    select: { driverSlotId: true, driverName: true, orderIds: true },
  })
  const orderIdSet = new Set(orders.map(o => o.id))
  const byWave = new Set<string>()
  for (const w of waves) {
    const hitsThisDay = (w.orderIds as string[]).some(id => orderIdSet.has(id))
    if (!hitsThisDay) continue
    const n = (w.driverSlotId ? slotMap.get(w.driverSlotId) : null) ?? w.driverName
    if (n) byWave.add(n)
  }

  console.log(`\n🔎 ${date} 缺货可改订单 ${orders.length} 单，其中 ${noSlot} 单 Order.driverSlotId 为空(拖拽波次未回填)\n`)
  console.log('A. 按 Order.driverSlot 派生司机(缺货处理现口径):', [...byOrderSlot].sort())
  console.log('B. 按 wave 派生司机(配送调度中心口径):      ', [...byWave].sort())
  const missing = [...byWave].filter(d => !byOrderSlot.has(d))
  console.log('\n❗ 配送中心有、缺货处理漏掉的司机:', missing.length ? missing : '(无)')

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
