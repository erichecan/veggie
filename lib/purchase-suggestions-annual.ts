import { prisma } from '@/lib/db'
import { toNum } from '@/lib/decimal-helpers'

/**
 * 干货品类·年度采购计划
 * ================================================================================
 * 干货采购周期以年计，不需要天级备货算法：用近 12 个月的移动汇总量作为基线，
 * 和再前 12 个月对比得出增长率，外推到下一年：
 *
 *   建议年度采购量 = 近12月采购量 × (1 + 近12月同比前12月增长率)
 *
 * 没有前 12 个月数据（新品/首次纳入年度计划）时不外推，直接沿用近 12 个月的量。
 * 近 12 个月一条采购记录都没有的商品不出现在计划里（没有历史依据不该臆造数字）。
 */

export interface AnnualPlanRow {
  productId: string
  productName: string
  recentYearQty: number
  priorYearQty: number
  growthPct: number | null
  suggestedQty: number
  uomName: string | null
  supplierId: string | null
  supplierName: string | null
  estimatedUnitCost: number
  estimatedCost: number
  reason: string
}

export async function generateAnnualDryGoodsPlan(): Promise<AnnualPlanRow[]> {
  const group = await prisma.categoryGroup.findUnique({ where: { key: 'DRY_GOODS' } })
  if (!group) return []

  const products = await prisma.product.findMany({
    where: { active: true, status: 'ACTIVE', category: { groupId: group.id } },
    select: {
      id: true,
      name: true,
      uom: { select: { name: true } },
      supplierInfos: {
        orderBy: { sequence: 'asc' },
        take: 1,
        include: { supplier: { select: { id: true, name: true } } },
      },
    },
  })
  if (products.length === 0) return []
  const productIds = products.map(p => p.id)

  const now = new Date()
  const oneYearAgo = new Date(now); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
  const twoYearsAgo = new Date(now); twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2)

  const COUNTED = ['CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED']
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any

  const recentLines = await p.purchaseOrderLine.findMany({
    where: { productId: { in: productIds }, purchaseOrder: { status: { in: COUNTED }, orderDate: { gte: oneYearAgo } } },
    select: { productId: true, orderedQty: true, unitCost: true },
  })
  const priorLines = await p.purchaseOrderLine.findMany({
    where: { productId: { in: productIds }, purchaseOrder: { status: { in: COUNTED }, orderDate: { gte: twoYearsAgo, lt: oneYearAgo } } },
    select: { productId: true, orderedQty: true },
  })

  const recentQtyMap = new Map<string, number>()
  const recentCostSumMap = new Map<string, number>() // qty * unitCost，用来算加权均价
  for (const l of recentLines) {
    if (!l.productId) continue
    const qty = toNum(l.orderedQty)
    recentQtyMap.set(l.productId, (recentQtyMap.get(l.productId) ?? 0) + qty)
    recentCostSumMap.set(l.productId, (recentCostSumMap.get(l.productId) ?? 0) + qty * toNum(l.unitCost))
  }
  const priorQtyMap = new Map<string, number>()
  for (const l of priorLines) {
    if (!l.productId) continue
    priorQtyMap.set(l.productId, (priorQtyMap.get(l.productId) ?? 0) + toNum(l.orderedQty))
  }

  const rows: AnnualPlanRow[] = []
  for (const p of products) {
    const recentQty = recentQtyMap.get(p.id) ?? 0
    if (recentQty <= 0) continue // 近12个月没买过，没有依据外推

    const priorQty = priorQtyMap.get(p.id) ?? 0
    const growthPct = priorQty > 0 ? Number((((recentQty - priorQty) / priorQty) * 100).toFixed(1)) : null
    const suggestedQty = Number((growthPct != null ? recentQty * (1 + growthPct / 100) : recentQty).toFixed(2))

    const weightedAvgCost = recentQty > 0 ? (recentCostSumMap.get(p.id) ?? 0) / recentQty : 0
    const bestSupplier = p.supplierInfos[0]
    const estimatedUnitCost = Number((bestSupplier ? toNum(bestSupplier.price) : weightedAvgCost).toFixed(4))
    const estimatedCost = Number((suggestedQty * estimatedUnitCost).toFixed(2))

    rows.push({
      productId: p.id,
      productName: p.name,
      recentYearQty: Number(recentQty.toFixed(2)),
      priorYearQty: Number(priorQty.toFixed(2)),
      growthPct,
      suggestedQty,
      uomName: p.uom?.name ?? null,
      supplierId: bestSupplier?.supplier.id ?? null,
      supplierName: bestSupplier?.supplier.name ?? null,
      estimatedUnitCost,
      estimatedCost,
      reason: growthPct != null
        ? `近12个月采购量 ${recentQty.toFixed(1)}，较前12个月 ${growthPct > 0 ? '+' : ''}${growthPct}%`
        : `近12个月采购量 ${recentQty.toFixed(1)}，无更早历史可比，按持平估计`,
    })
  }

  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
  await prisma.purchaseSuggestion.deleteMany({
    where: { status: 'pending', categoryGroupKey: 'DRY_GOODS', generatedAt: { gte: todayStart } },
  })
  if (rows.length > 0) {
    await prisma.purchaseSuggestion.createMany({
      data: rows.map(r => ({
        productId: r.productId,
        productName: r.productName,
        currentStock: 0,
        demandQty: r.recentYearQty,
        suggestedQty: r.suggestedQty,
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        estimatedCost: r.estimatedCost,
        priority: 'normal',
        status: 'pending',
        categoryGroupKey: 'DRY_GOODS',
        reason: r.reason,
      })),
    })
  }

  return rows.sort((a, b) => b.estimatedCost - a.estimatedCost)
}
