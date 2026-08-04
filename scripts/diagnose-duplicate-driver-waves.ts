/**
 * 只读诊断：找出「同司机同时段」存在多条 PickingWave 的历史分组（DEV-PLAN.md 第 6 节）。
 *
 * 背景：2026-07-09 起，批次号(DriverSlot.batchNum)改为波次内部的托盘编号，波次本身按
 * 「司机+时段」聚合(见 lib/wave-assign.ts)——今天起新建的波次不会再重复，但改造前就存在的
 * 历史波次(比如"1 am BAO"和"3 am BAO"各自一条波次)依然是分裂状态，需要人工确认后再决定
 * 是否合并。本脚本纯只读，不写库，只摸底范围，方便你判断合并影响面/挑合适的时间点执行。
 *
 *   npx tsx --env-file=.env.local scripts/diagnose-duplicate-driver-waves.ts
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

async function main() {
  const waves = await prisma.pickingWave.findMany({
    select: {
      id: true, name: true, waveDate: true, driverName: true, timeOfDay: true,
      orderIds: true, dispatchedAt: true, completedAt: true, createdAt: true,
    },
    orderBy: [{ waveDate: 'asc' }, { driverName: 'asc' }, { timeOfDay: 'asc' }, { createdAt: 'asc' }],
  })

  const groups = new Map<string, typeof waves>()
  for (const w of waves) {
    if (!w.driverName || !w.timeOfDay || !w.waveDate) continue
    const key = `${w.waveDate.toISOString().slice(0, 10)}::${w.driverName}::${w.timeOfDay}`
    const list = groups.get(key) ?? []
    list.push(w)
    groups.set(key, list)
  }

  const dupGroups = [...groups.entries()].filter(([, list]) => list.length > 1)

  console.log(`总波次数：${waves.length}`)
  console.log(`「同司机同时段」重复分组数：${dupGroups.length}\n`)

  let openDupGroups = 0
  let openDupWaves = 0
  let openDupOrders = 0
  let dispatchedDupGroups = 0

  for (const [key, list] of dupGroups) {
    const openOnes = list.filter(w => !w.dispatchedAt && !w.completedAt)
    const dispatchedOnes = list.filter(w => w.dispatchedAt || w.completedAt)

    if (openOnes.length > 1) {
      openDupGroups++
      openDupWaves += openOnes.length
      const orderCount = new Set(openOnes.flatMap(w => w.orderIds as string[])).size
      openDupOrders += orderCount
      console.log(`⚠️  [可合并] ${key} — ${openOnes.length} 条未出发波次，共 ${orderCount} 个不重复订单`)
      for (const w of openOnes) {
        console.log(`      ${w.id}  "${w.name}"  ${(w.orderIds as string[]).length} 单  建于 ${w.createdAt.toISOString().slice(0, 10)}`)
      }
    }
    if (dispatchedOnes.length > 1) {
      dispatchedDupGroups++
      console.log(`ℹ️  [历史既成事实，不动] ${key} — ${dispatchedOnes.length} 条已出发/已完成波次(各自的 Trip/提成保留不变)`)
    }
  }

  console.log('\n—— 汇总 ——')
  console.log(`可安全合并的分组(全部未出发)：${openDupGroups} 组，共 ${openDupWaves} 条波次待合并，涉及 ${openDupOrders} 个不重复订单`)
  console.log(`已出发/已完成的历史重复分组：${dispatchedDupGroups} 组（不建议合并，Trip/提成已是既成事实）`)
  console.log('\n本脚本纯诊断，未写入任何数据。合并脚本待你确认执行时机后再单独写 --apply 版本。')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
