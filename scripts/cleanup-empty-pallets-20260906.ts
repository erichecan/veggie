/**
 * 清理配送中心里"空托盘"：Pallet.items 为空数组、且所属波次未出发/未完成的记录。
 *
 * 背景（2026-09-06 客户反馈）：调度台里有很多 0 orders 的空托盘格子点 X 删不掉，
 * 报错"该批次拣货中已锁定，请找打印员解锁"。根因是 deletePalletForDriverSlot
 * （lib/wave-assign.ts）删除前无条件检查该司机+时段下所有未出发波次(跨全部日期)
 * 是否被拣货锁锁住，与眼前这个空托盘毫不相干的锁也会挡住删除——代码已修：只有
 * 托盘里真的有订单要退回待分配时才检查锁。
 *
 * 本脚本只处理已经存在的历史空托盘（Pallet 本身），不动 DriverSlot（司机工位配置，
 * 保留以后还能用），不动已出发/已完成波次下的托盘（历史装车记录不回溯改写）。
 * 空托盘本身没有订单，删除不需要改 wave.orderIds / order.status。
 *
 *   npx tsx --env-file=.env.local scripts/cleanup-empty-pallets-20260906.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/cleanup-empty-pallets-20260906.ts --apply  # 实际删除
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')

type PalletItem = { orderId: string }

async function main() {
  console.log(`\n=== 清理空托盘 (${APPLY ? 'APPLY 实际删除' : 'DRY-RUN 只读'}) ===\n`)

  const pallets = await prisma.pallet.findMany({
    where: { wave: { dispatchedAt: null, completedAt: null } },
    include: { wave: { select: { id: true, driverName: true, timeOfDay: true, waveDate: true, pickLockedAt: true } } },
  })

  const emptyPallets = pallets.filter((p) => {
    const items = (p.items as PalletItem[] | null) ?? []
    return !Array.isArray(items) || items.length === 0
  })

  console.log(`扫描到未出发/未完成波次下的托盘共 ${pallets.length} 个，其中空托盘 ${emptyPallets.length} 个：\n`)
  for (const p of emptyPallets) {
    const w = p.wave
    console.log(
      `  ${w.driverName ?? '?'}/${w.timeOfDay ?? '?'}#${p.seq}  waveId=${w.id}  waveDate=${w.waveDate?.toISOString().slice(0, 10) ?? '?'}  locked=${!!w.pickLockedAt}`,
    )
  }

  if (emptyPallets.length === 0) {
    console.log('\n没有需要清理的空托盘。\n')
    await prisma.$disconnect()
    return
  }

  if (APPLY) {
    const { count } = await prisma.pallet.deleteMany({ where: { id: { in: emptyPallets.map((p) => p.id) } } })
    console.log(`\n✅ 已删除 ${count} 个空托盘。\n`)
  } else {
    console.log('\nDRY-RUN 结束，未写库。确认无误后加 --apply 执行。\n')
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
