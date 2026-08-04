/**
 * 只读诊断：找出「已确认出发(dispatchedAt 非空)，但 orderIds 已被清空」的波次。
 *
 * 背景：调度台拖拽(unassign/assign)与 assignOrderToWave 此前均未校验来源波次是否已出发，
 * 关灯期(DRIVER_APP_ENABLED=false)UI 又把已出发波次画成普通空闲车，导致操作员能把已出发
 * 波次的订单拖空——卡片显示空闲待分配、实际仍是已出发状态，再拖新单进去时才被拒绝。
 * 代码侧已补齐校验(lib/wave-dispatch-lock.ts + 4 处调用点)，本脚本用于一次性摸底历史脏数据
 * 范围，纯只读，不写库，也不尝试找回丢失的订单归属(不可靠，操作日志不记录具体订单号)。
 *
 *   npx tsx --env-file=.env.local scripts/diagnose-dispatched-wave-orphans.ts
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

async function main() {
  const waves = await prisma.pickingWave.findMany({
    where: { dispatchedAt: { not: null } },
    select: {
      id: true, name: true, waveDate: true, driverName: true,
      orderIds: true, dispatchedAt: true, completedAt: true,
    },
    orderBy: { dispatchedAt: 'asc' },
  })

  const orphans = waves.filter(w => (w.orderIds as string[]).length === 0)

  console.log(`\n=== 已出发波次总数：${waves.length}，其中 orderIds 为空的：${orphans.length} ===\n`)
  for (const w of orphans) {
    const date = w.waveDate ? w.waveDate.toISOString().slice(0, 10) : '(无排程日期)'
    console.log(`  ${date}  ${w.name ?? w.id}  司机=${w.driverName ?? '(无)'}  出发=${w.dispatchedAt?.toISOString()}  完成=${w.completedAt ? w.completedAt.toISOString() : '(未完成)'}`)
  }
  if (orphans.length === 0) console.log('  (无)')

  console.log(`\n只读诊断，未写库。这些波次的订单归属已不可追溯，不做自动修复。\n`)
  await prisma.$disconnect()
}
main()
