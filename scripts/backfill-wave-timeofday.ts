/**
 * 一次性回填：PickingWave.timeOfDay（新字段，波次按司机+时段聚合改造的一部分）。
 *
 * 存量波次从各自的 driverSlotId 关联的 DriverSlot.timeOfDay 取值；driverSlotId 缺失/找不到对应
 * DriverSlot 的极少数脏数据，退回从 name 里解析 " am " / " pm "（波次名格式："{date} #{n} {driverName}"
 * 不含时段，所以这条兜底大概率也拿不到，最终打日志跳过，不强行猜测写错数据）。
 * 纯写这一个新字段，不动 orderIds/driverSlotId/其他任何列，可重复执行、幂等。
 *
 *   npx tsx --env-file=.env.local scripts/backfill-wave-timeofday.ts
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

async function main() {
  const waves = await prisma.pickingWave.findMany({
    where: { timeOfDay: null },
    select: { id: true, driverSlotId: true, driverName: true, waveDate: true },
  })
  console.log(`待回填波次：${waves.length}`)

  const slotIds = [...new Set(waves.map((w) => w.driverSlotId).filter((x): x is string => !!x))]
  const slots = slotIds.length
    ? await prisma.driverSlot.findMany({ where: { id: { in: slotIds } }, select: { id: true, timeOfDay: true } })
    : []
  const slotMap = new Map(slots.map((s) => [s.id, s.timeOfDay]))

  let filled = 0
  let skipped = 0
  for (const w of waves) {
    const timeOfDay = w.driverSlotId ? slotMap.get(w.driverSlotId) : undefined
    if (!timeOfDay) {
      skipped++
      console.log(`  跳过(无法确定时段) wave=${w.id} driverName=${w.driverName} waveDate=${w.waveDate?.toISOString().slice(0, 10)}`)
      continue
    }
    await prisma.pickingWave.update({ where: { id: w.id }, data: { timeOfDay } })
    filled++
  }
  console.log(`回填完成：${filled} 条已写入，${skipped} 条跳过（可能是历史脏数据，建议手动核对）`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
