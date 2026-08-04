/**
 * 测试阶段重置：把配送中心里全部「已出发/已完成」的分配退回「待分配」。
 *
 * 背景：系统仍在测试阶段，摸底确认当前只有 7 条波次带 dispatchedAt/completedAt(2026-06-28~
 * 2026-07-07)，对应 7 个订单(1 波次 1 单)，关联 7 条 Trip 全部 PENDING/未结算、提成合计 €0，
 * 没有 Invoice——不涉及任何已成立的账，可以安全重置。用户已确认执行(含删除这 7 条 Trip)。
 *
 * 对每条 dispatchedAt/completedAt 非空的波次：
 *   1. 删除该波次关联的 Trip(未结算，删除不影响任何账)
 *   2. 波次里的每个订单：从该波次(及其 Pallet)里摘除，status 一律重置为 CONFIRMED
 *      (不管当前是 WAVE_ASSIGNED 还是 IN_DELIVERY)
 *   3. 波次本身清空 orderIds/zones、dispatchedAt、completedAt，变回未出发的空波次(不删波次行，
 *      与系统里大量 generate-daily 预建的空波次形态一致)
 *
 *   npx tsx --env-file=.env.local scripts/reset-dispatched-waves-to-unassigned.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/reset-dispatched-waves-to-unassigned.ts --apply  # 实际重置
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')

async function main() {
  const waves = await prisma.pickingWave.findMany({
    where: { OR: [{ dispatchedAt: { not: null } }, { completedAt: { not: null } }] },
    select: { id: true, name: true, waveDate: true, driverName: true, timeOfDay: true, orderIds: true, dispatchedAt: true, completedAt: true },
    orderBy: { waveDate: 'asc' },
  })

  console.log(`\n=== 重置已出发/已完成波次为待分配 (${APPLY ? 'APPLY 实际执行' : 'DRY-RUN 只读'}) ===\n`)
  console.log(`命中 ${waves.length} 条波次：\n`)

  const waveIds = waves.map((w) => w.id)
  const allOrderIds = [...new Set(waves.flatMap((w) => w.orderIds as string[]))]
  const trips = waveIds.length ? await prisma.trip.findMany({ where: { waveId: { in: waveIds } }, select: { id: true, waveId: true, driverName: true, status: true, settlementStatus: true } }) : []

  for (const w of waves) {
    const date = w.waveDate ? w.waveDate.toISOString().slice(0, 10) : '(无排程日期)'
    const trip = trips.find((t) => t.waveId === w.id)
    console.log(`  ${date}  ${w.name ?? w.id}  ${w.driverName}/${w.timeOfDay}  ${(w.orderIds as string[]).length} 单  出发=${w.dispatchedAt?.toISOString() ?? '-'}  完成=${w.completedAt?.toISOString() ?? '-'}  Trip=${trip ? `${trip.id}(${trip.status}/${trip.settlementStatus})` : '(无)'}`)
  }
  console.log(`\n影响：${waves.length} 条波次、${allOrderIds.length} 个不重复订单、${trips.length} 条 Trip 将被删除。\n`)

  const unsettled = trips.filter((t) => t.settlementStatus !== 'pending' || t.status === 'COMPLETED')
  if (unsettled.length > 0) {
    console.log(`⛔ 检测到 ${unsettled.length} 条 Trip 已结算或已完成，脚本拒绝继续（防止误删已成立的账）：`)
    for (const t of unsettled) console.log(`   ${t.id}  driver=${t.driverName}  status=${t.status}  settlement=${t.settlementStatus}`)
    await prisma.$disconnect()
    process.exit(1)
  }

  if (!APPLY) {
    console.log('DRY-RUN 结束，未写库。确认无误后加 --apply 执行。\n')
    await prisma.$disconnect()
    return
  }

  if (waves.length === 0) {
    console.log('无需重置。\n')
    await prisma.$disconnect()
    return
  }

  await prisma.$transaction(async (tx) => {
    await tx.trip.deleteMany({ where: { waveId: { in: waveIds } } })

    for (const w of waves) {
      const orderIds = w.orderIds as string[]
      if (orderIds.length > 0) {
        const pallets = await tx.pallet.findMany({ where: { waveId: w.id } })
        for (const p of pallets) {
          const items = (p.items as Array<{ orderId: string }>) ?? []
          const remaining = items.filter((it) => !orderIds.includes(it.orderId))
          if (remaining.length === 0) await tx.pallet.delete({ where: { id: p.id } })
          else if (remaining.length !== items.length) await tx.pallet.update({ where: { id: p.id }, data: { items: remaining } })
        }
        await tx.order.updateMany({ where: { id: { in: orderIds } }, data: { status: 'CONFIRMED' } })
      }
      await tx.pickingWave.update({
        where: { id: w.id },
        data: { orderIds: [], zones: [], dispatchedAt: null, completedAt: null, assignmentDoneAt: null },
      })
    }
  })

  console.log(`✅ 已重置 ${waves.length} 条波次、${allOrderIds.length} 个订单退回待分配，删除 ${trips.length} 条 Trip。\n`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
