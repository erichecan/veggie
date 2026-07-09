/**
 * 清理：已确认出发(dispatchedAt 非空)但 orderIds 已被掏空(=[])的历史脏波次。
 *
 * 背景见 scripts/diagnose-dispatched-wave-orphans.ts —— 这些波次的订单归属已不可追溯，
 * 留着只会在调度台历史里造成困惑(显示为已出发/已完成但无订单的空卡片)。数据本身对业务
 * 已无用(orderIds 为空 = 没有任何订单指向它)，删除不影响任何仍在跑的订单/发票/库存。
 *
 * 关联检查：
 *   - Pallet.waveId 是真实外键 + onDelete: Cascade —— 若这些波次挂了托盘记录会一并删除，
 *     脚本会先统计数量再执行，避免误删还有价值的托盘数据。
 *   - Trip.waveId 只是普通字符串字段(非外键)——Trip 已在出发时把司机/佣金/餐馆数据快照进
 *     自己表内(SSOT)，删波次不影响 Trip 内容，只会让 Trip.waveId 变成一个不再存在的悬空引用
 *     (不报错，纯信息性质，脚本会统计受影响的 Trip 数量供确认)。
 *
 *   npx tsx --env-file=.env.local scripts/cleanup-dispatched-wave-orphans.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/cleanup-dispatched-wave-orphans.ts --apply  # 实际删除
 */
import 'dotenv/config'
import { neonConfig } from '@neondatabase/serverless'
import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaClient } from '../lib/generated/prisma/client'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')

async function main() {
  const waves = await prisma.pickingWave.findMany({
    where: { dispatchedAt: { not: null } },
    select: { id: true, name: true, waveDate: true, driverName: true, orderIds: true, dispatchedAt: true, completedAt: true },
    orderBy: { dispatchedAt: 'asc' },
  })
  const orphans = waves.filter(w => (w.orderIds as string[]).length === 0)

  console.log(`\n=== 清理已出发但 orderIds 为空的历史波次 (${APPLY ? 'APPLY 实际删除' : 'DRY-RUN 只读'}) ===\n`)
  console.log(`命中 ${orphans.length} 个波次：\n`)

  const ids = orphans.map(w => w.id)
  const palletCount = ids.length ? await prisma.pallet.count({ where: { waveId: { in: ids } } }) : 0
  const tripCount = ids.length ? await prisma.trip.count({ where: { waveId: { in: ids } } }) : 0

  for (const w of orphans) {
    const date = w.waveDate ? w.waveDate.toISOString().slice(0, 10) : '(无排程日期)'
    console.log(`  ${date}  ${w.name ?? w.id}  司机=${w.driverName ?? '(无)'}  出发=${w.dispatchedAt?.toISOString()}  完成=${w.completedAt ? w.completedAt.toISOString() : '(未完成)'}`)
  }
  console.log(`\n关联影响：Pallet 将级联删除 ${palletCount} 条；Trip 有 ${tripCount} 条会变成 waveId 悬空引用(Trip 自身数据不受影响，仅失去与波次的关联)。\n`)

  if (!APPLY) {
    console.log('DRY-RUN 结束，未删库。确认无误后加 --apply 执行。\n')
    await prisma.$disconnect()
    return
  }

  if (orphans.length === 0) {
    console.log('无需清理。\n')
    await prisma.$disconnect()
    return
  }

  const result = await prisma.pickingWave.deleteMany({ where: { id: { in: ids } } })
  console.log(`✅ 已删除 ${result.count} 个波次（含级联 Pallet）。\n`)
  await prisma.$disconnect()
}
main()
