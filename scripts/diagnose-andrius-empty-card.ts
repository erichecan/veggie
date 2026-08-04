/**
 * 只读诊断：为什么某司机角标>0 但批次卡片空。
 * 逐个 wave 打印 orderIds，并核对每个 orderId 是否能在 Order 表查到、其 status/deliveryDate。
 *   npx tsx --env-file=.env.local scripts/diagnose-andrius-empty-card.ts 2026-07-03 ANDRIUS
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

const ymd = (d: Date | null | undefined): string => (d ? new Date(d).toISOString().slice(0, 10) : 'NULL')

async function main(): Promise<void> {
  const date = process.argv[2] ?? '2026-07-03'
  const driverFilter = (process.argv[3] ?? '').toUpperCase()
  const dayStart = new Date(date + 'T00:00:00Z')

  const waves = await prisma.pickingWave.findMany({
    where: { waveDate: dayStart },
    select: { id: true, name: true, orderIds: true, driverSlotId: true, driverName: true, waveDate: true, dispatchedAt: true, completedAt: true },
  })

  const slots = await prisma.driverSlot.findMany({ select: { id: true, driverName: true, timeOfDay: true, batchNum: true } })
  const slotMap = new Map(slots.map(s => [s.id, s]))

  console.log(`\n🔎 ${date} 波次 → orderIds 落地核对${driverFilter ? `（仅司机 ${driverFilter}）` : ''}\n`)

  for (const w of waves) {
    const slot = w.driverSlotId ? slotMap.get(w.driverSlotId) : null
    const driverName = (slot?.driverName ?? w.driverName ?? '?').toUpperCase()
    if (driverFilter && driverName !== driverFilter) continue

    const oids = (w.orderIds as string[]) ?? []
    const orders = await prisma.order.findMany({
      where: { id: { in: oids } },
      select: { id: true, code: true, status: true, deliveryDate: true, restaurantName: true },
    })
    const found = new Map(orders.map(o => [o.id, o]))

    console.log(`━ 波次 ${w.name ?? w.id}  司机=${driverName}  slot=${slot ? `${slot.timeOfDay}#${slot.batchNum}` : 'NULL'}  orderIds=${oids.length}  dispatched=${!!w.dispatchedAt} completed=${!!w.completedAt}`)
    for (const oid of oids) {
      const o = found.get(oid)
      if (!o) {
        console.log(`    ❌ ${oid}  → 数据库查不到该订单（陈旧/悬空指针）`)
      } else {
        console.log(`    ✅ ${oid.slice(0, 8)}  ${o.code ?? '-'}  status=${o.status}  deliveryDate=${ymd(o.deliveryDate)}  ${o.restaurantName}`)
      }
    }
    if (oids.length === 0) console.log('    （空）')
    console.log()
  }

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
