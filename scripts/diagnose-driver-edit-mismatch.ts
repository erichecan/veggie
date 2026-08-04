/**
 * 只读诊断：对比订单「显示态司机(来自所属 wave)」与「编辑态预选司机(来自 order.driverSlotId 列)」是否一致。
 *   npx tsx --env-file=.env.local scripts/diagnose-driver-edit-mismatch.ts <orderId> [<orderId> ...]
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

const fmtSlot = (s: { batchNum: number; timeOfDay: string; driverName: string } | null | undefined) =>
  s ? `${s.batchNum} ${s.timeOfDay} ${s.driverName}` : '—'

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  for (const id of ids) {
    const order = await prisma.order.findUnique({
      where: { id },
      select: {
        id: true, code: true, driverSlotId: true, deliveryBatch: true, status: true,
        driverSlot: { select: { id: true, batchNum: true, timeOfDay: true, driverName: true } },
      },
    })
    if (!order) { console.log(`❌ ${id} 不存在\n`); continue }

    const waves = await prisma.pickingWave.findMany({
      where: { orderIds: { has: id } },
      select: { id: true, name: true, driverSlotId: true, driverName: true, dispatchedAt: true },
    })
    const waveSlotIds = [...new Set(waves.map((w) => w.driverSlotId).filter((x): x is string => !!x))]
    const waveSlots = waveSlotIds.length
      ? await prisma.driverSlot.findMany({ where: { id: { in: waveSlotIds } },
          select: { id: true, batchNum: true, timeOfDay: true, driverName: true } })
      : []
    const slotMap = new Map(waveSlots.map((s) => [s.id, s]))

    console.log(`━━ 订单 ${order.code ?? id} (${id})  status=${order.status}`)
    console.log(`  显示态(所属 wave 派生):`)
    if (waves.length === 0) console.log(`    (不属于任何 wave) → 回退 deliveryBatch = "${order.deliveryBatch ?? ''}"`)
    for (const w of waves) {
      const label = w.driverSlotId ? fmtSlot(slotMap.get(w.driverSlotId)) : (w.driverName ?? '')
      console.log(`    wave ${w.name} → driverSlotId=${w.driverSlotId} → "${label}"  ${w.dispatchedAt ? '(已出发)' : ''}`)
    }
    console.log(`  编辑态(order.driverSlotId 列预选):`)
    console.log(`    driverSlotId=${order.driverSlotId} → "${fmtSlot(order.driverSlot)}"`)
    console.log('')
  }
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
