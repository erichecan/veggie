/**
 * 重算 2026-08-24 ~ 2026-08-28 的每日经营快照(DailyBusinessSnapshot)。
 *
 * 起因：lib/analytics/snapshot.ts 的 gross_profit 计算此前没有按订单行的 uomId 用
 * ProductSaleUom.factor 换算成本，非默认单位的行会拿"整箱成本"去减"公斤单价"，
 * 毛利算错（客户 20260827 反馈价格与成本对不上，见排查记录）。代码已修（本次改动），
 * 这里补算受影响的历史快照——已确认全库最早一笔非默认单位的已确认订单行在
 * 2026-08-25，影响范围只有 2026-08-25 / 2026-08-26 两天，前后各留一天缓冲。
 *
 *   npx tsx --env-file=.env.local scripts/recompute-snapshots-20260827.ts        # 本地/dev 库
 *   （生产：挂进 migrator 容器跑，见 docs/20260818-shdemo-cleanup-plan.md 里的执行方式）
 */
import 'dotenv/config'
import { prisma } from '@/lib/db'
import { recomputeSnapshots } from '@/lib/analytics/snapshot'

const FROM = new Date('2026-08-24T00:00:00.000Z')
const TO = new Date('2026-08-28T00:00:00.000Z')

async function main(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any

  const before = await p.dailyBusinessSnapshot.findMany({
    where: { snapshotDate: { gte: FROM, lte: TO } },
    orderBy: { snapshotDate: 'asc' },
    select: { snapshotDate: true, grossProfit: true, salesExTax: true, costCoverageRate: true },
  })
  console.log('=== 重算前 ===')
  for (const r of before) {
    console.log(`${r.snapshotDate.toISOString().slice(0, 10)}  sales=${r.salesExTax}  grossProfit=${r.grossProfit}  costCoverageRate=${r.costCoverageRate}`)
  }

  const count = await recomputeSnapshots(FROM, TO)
  console.log(`\n重算了 ${count} 天\n`)

  const after = await p.dailyBusinessSnapshot.findMany({
    where: { snapshotDate: { gte: FROM, lte: TO } },
    orderBy: { snapshotDate: 'asc' },
    select: { snapshotDate: true, grossProfit: true, salesExTax: true, costCoverageRate: true },
  })
  console.log('=== 重算后 ===')
  for (const r of after) {
    console.log(`${r.snapshotDate.toISOString().slice(0, 10)}  sales=${r.salesExTax}  grossProfit=${r.grossProfit}  costCoverageRate=${r.costCoverageRate}`)
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err)
    return prisma.$disconnect().finally(() => process.exit(1))
  })
