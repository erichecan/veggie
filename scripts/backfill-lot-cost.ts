/**
 * scripts/backfill-lot-cost.ts
 *
 * 历史批次成本回填：Lot.unitCost ← PurchaseOrderLine.unitCost。
 * 匹配链：Lot.sourceType='GOODS_RECEIPT' → GoodsReceipt → PurchaseOrder → PO 行（同 productId）；
 *         Lot.sourceType='PURCHASE_ORDER' → PurchaseOrder → PO 行（同 productId）。
 * 只回填 unitCost 为 null 的批次（不覆盖已有值）；匹配不到保持 null（毛利 fallback standardPrice）。
 * 结束输出覆盖率报告（批次数与 initialQty 加权两个口径）。
 *
 * 运行：
 *   npx tsx --env-file=.env.local scripts/backfill-lot-cost.ts            # dry-run
 *   npx tsx --env-file=.env.local scripts/backfill-lot-cost.ts --apply    # 实际写入
 */
import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')

async function main() {
  const lots = await prisma.lot.findMany({
    where: { unitCost: null },
    select: {
      id: true, lotNumber: true, productId: true, initialQty: true,
      sourceType: true, sourceId: true, sourceRef: true,
    },
  })
  console.log(`unitCost 为空的批次: ${lots.length}`)

  // 预载 GR → PO 映射与 PO 行
  const grIds = [...new Set(lots.filter(l => l.sourceType === 'GOODS_RECEIPT' && l.sourceId).map(l => l.sourceId!))]
  const grs = await prisma.goodsReceipt.findMany({
    where: { id: { in: grIds } },
    select: { id: true, purchaseOrderId: true },
  })
  const grToPo = new Map(grs.map(g => [g.id, g.purchaseOrderId]))

  const poIds = new Set<string>(grs.map(g => g.purchaseOrderId))
  for (const l of lots) {
    if (l.sourceType === 'PURCHASE_ORDER' && l.sourceId) poIds.add(l.sourceId)
  }
  const poLines = await prisma.purchaseOrderLine.findMany({
    where: { purchaseOrderId: { in: [...poIds] } },
    select: { purchaseOrderId: true, productId: true, unitCost: true },
  })
  const poLineCost = new Map<string, number>()
  for (const pl of poLines) {
    poLineCost.set(`${pl.purchaseOrderId}:${pl.productId}`, Number(pl.unitCost))
  }

  let matched = 0
  let unmatched = 0
  const updates: { id: string; cost: number }[] = []
  for (const l of lots) {
    let poId: string | undefined
    if (l.sourceType === 'GOODS_RECEIPT' && l.sourceId) poId = grToPo.get(l.sourceId)
    else if (l.sourceType === 'PURCHASE_ORDER' && l.sourceId) poId = l.sourceId
    const cost = poId ? poLineCost.get(`${poId}:${l.productId}`) : undefined
    if (cost !== undefined && cost > 0) {
      matched++
      updates.push({ id: l.id, cost })
    } else {
      unmatched++
    }
  }

  if (APPLY && updates.length > 0) {
    const BATCH = 200
    for (let i = 0; i < updates.length; i += BATCH) {
      await prisma.$transaction(
        updates.slice(i, i + BATCH).map(u =>
          prisma.lot.update({ where: { id: u.id }, data: { unitCost: u.cost } }),
        ),
      )
      console.log(`  已写入 ${Math.min(i + BATCH, updates.length)}/${updates.length}`)
    }
  }

  // 覆盖率报告（全量口径）
  const [totalLots, costedLots] = await Promise.all([
    prisma.lot.count(),
    prisma.lot.count({ where: { unitCost: { not: null } } }),
  ])
  const agg = await prisma.$queryRaw<{ total: number; costed: number }[]>`
    SELECT COALESCE(SUM("initialQty"), 0)::float AS total,
           COALESCE(SUM(CASE WHEN "unitCost" IS NOT NULL THEN "initialQty" ELSE 0 END), 0)::float AS costed
    FROM "Lot"`
  const q = agg[0] ?? { total: 0, costed: 0 }

  console.log(`\n==== 回填报告 (${APPLY ? 'APPLIED' : 'DRY-RUN'}) ====`)
  console.log(`本次匹配到成本: ${matched}，未匹配: ${unmatched}`)
  console.log(`批次覆盖率: ${costedLots}/${totalLots} = ${totalLots ? ((costedLots / totalLots) * 100).toFixed(1) : 0}%${APPLY ? '' : '（dry-run 未写入，applied 后重跑查看）'}`)
  console.log(`数量加权覆盖率: ${q.total ? ((q.costed / q.total) * 100).toFixed(1) : 0}%`)
}

main().finally(() => prisma.$disconnect())
