/**
 * 找出/修复「order.driverSlotId ≠ 所属 wave 派生 driverSlotId」的订单(司机显示/编辑分叉)。
 *   npx tsx --env-file=.env.local scripts/scan-driver-slot-wave-divergence.ts         # 只读扫描
 *   npx tsx --env-file=.env.local scripts/scan-driver-slot-wave-divergence.ts --fix   # 回写 driverSlotId=wave 真值
 * wave 是调度唯一真相,只回写 order.driverSlotId 这一列,不动 wave/状态。
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()

async function main(): Promise<void> {
  // 所有进过 wave 的订单 → wave.driverSlotId
  const waves = await prisma.pickingWave.findMany({ select: { orderIds: true, driverSlotId: true, dispatchedAt: true } })
  const orderToWaveSlot = new Map<string, { slotId: string | null; dispatched: boolean }>()
  for (const w of waves) for (const oid of w.orderIds as string[]) orderToWaveSlot.set(oid, { slotId: w.driverSlotId, dispatched: !!w.dispatchedAt })

  const orders = await prisma.order.findMany({
    where: { id: { in: [...orderToWaveSlot.keys()] } },
    select: { id: true, code: true, status: true, driverSlotId: true },
  })
  const slots = await prisma.driverSlot.findMany({ select: { id: true, batchNum: true, timeOfDay: true, driverName: true } })
  const slotMap = new Map(slots.map(s => [s.id, `${s.batchNum} ${s.timeOfDay} ${s.driverName}`]))
  const nm = (id: string | null) => (id ? (slotMap.get(id) ?? `(slot ${id.slice(0,8)} 已删)`) : '(空)')

  const DO_FIX = process.argv.includes('--fix')
  const byStatus = new Map<string, number>()
  const rows: string[] = []
  const fixes: { id: string; slotId: string }[] = []
  for (const o of orders) {
    const w = orderToWaveSlot.get(o.id)!
    if (w.slotId && o.driverSlotId !== w.slotId) {
      byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1)
      rows.push(`  ${o.code}  [${o.status}${w.dispatched ? ' 已出发' : ''}]  ${nm(o.driverSlotId)}  →  ${nm(w.slotId)}`)
      fixes.push({ id: o.id, slotId: w.slotId })
    }
  }
  console.log(`\n🔎 order.driverSlotId ≠ wave 派生 的订单:共 ${rows.length} 单（${DO_FIX ? '修复模式' : '只读'}）\n`)
  console.log('按状态:', Object.fromEntries(byStatus))
  console.log('')
  console.log(rows.slice(0, 60).join('\n'))
  if (rows.length > 60) console.log(`  ... 其余 ${rows.length - 60} 单省略`)
  if (DO_FIX && fixes.length > 0) {
    // 逐单交互式事务(与 diagnose-wave-deliverydate.ts 同款);批量数组事务会超 Neon 5s 限制回滚
    let total = 0
    for (const f of fixes) {
      await prisma.$transaction(async (tx) => {
        await tx.order.update({ where: { id: f.id }, data: { driverSlotId: f.slotId } })
      })
      total += 1
    }
    console.log(`\n✅ 已回写 ${total} 单 order.driverSlotId = wave 真值`)
  } else if (!DO_FIX) {
    console.log(`\n（只读。加 --fix 回写 order.driverSlotId=wave 真值）`)
  }
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
