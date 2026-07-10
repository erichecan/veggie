/**
 * 仓库地图·温区库存 — 数据聚合
 * ============================================================================
 * Zone = 仓库温区（冷冻/冷藏/常温干货/常温超市），已用真实数据回填 ~1669/1718 个商品。
 *   - Product.currentZoneId  = 商品实际放在哪个温区（物理现实，可编辑）
 *   - ProductCategory.requiredZoneId = 该类目商品业务上"应该"放哪个温区（业务规则）
 * 两者不一致 = 放错温区，是本页"温区不符"表的数据基础。
 */
import { prisma } from '@/lib/db'
import { toNum } from '@/lib/decimal-helpers'

export interface ZoneSummary {
  zoneId: string
  key: string
  nameZh: string
  tempRangeLabel: string | null
  skuCount: number
  totalValue: number
  warningCount: number
}

export interface ZoneMismatch {
  productId: string
  productName: string
  qtyOnHand: number
  currentZoneId: string
  currentZoneNameZh: string
  requiredZoneId: string
  requiredZoneNameZh: string
}

/** 每个温区的 SKU 数 / 库存总值 / 低于安全库存的预警数 */
export async function getZoneSummaries(): Promise<ZoneSummary[]> {
  const zones = await prisma.zone.findMany({ orderBy: { key: 'asc' } })

  const summaries = await Promise.all(
    zones.map(async (zone): Promise<ZoneSummary> => {
      const products = await prisma.product.findMany({
        where: { currentZoneId: zone.id, status: 'ACTIVE' },
        select: { qtyOnHand: true, standardPrice: true, safetyStockMin: true },
      })

      let totalValue = 0
      let warningCount = 0
      for (const p of products) {
        const qty = toNum(p.qtyOnHand)
        const price = toNum(p.standardPrice)
        totalValue += qty * price
        const safetyMin = p.safetyStockMin === null || p.safetyStockMin === undefined ? null : toNum(p.safetyStockMin)
        if (safetyMin !== null && qty <= safetyMin) warningCount += 1
      }

      return {
        zoneId: zone.id,
        key: zone.key,
        nameZh: zone.nameZh,
        tempRangeLabel: zone.tempRangeLabel,
        skuCount: products.length,
        totalValue,
        warningCount,
      }
    })
  )

  return summaries
}

/** 温区不符：实际放置温区 与 类目应放温区 不一致的商品，按库存价值降序，最先曝光高价值放错 */
export async function getZoneMismatches(limit: number): Promise<ZoneMismatch[]> {
  const products = await prisma.product.findMany({
    where: {
      status: 'ACTIVE',
      currentZoneId: { not: null },
      category: { requiredZoneId: { not: null } },
    },
    select: {
      id: true,
      name: true,
      qtyOnHand: true,
      standardPrice: true,
      currentZoneId: true,
      currentZone: { select: { id: true, nameZh: true } },
      category: {
        select: {
          requiredZoneId: true,
          requiredZone: { select: { id: true, nameZh: true } },
        },
      },
    },
  })

  const mismatches: (ZoneMismatch & { value: number })[] = []
  for (const p of products) {
    const requiredZoneId = p.category?.requiredZoneId ?? null
    if (!p.currentZoneId || !requiredZoneId) continue
    if (p.currentZoneId === requiredZoneId) continue
    if (!p.currentZone || !p.category?.requiredZone) continue

    const qty = toNum(p.qtyOnHand)
    const price = toNum(p.standardPrice)
    mismatches.push({
      productId: p.id,
      productName: p.name,
      qtyOnHand: qty,
      currentZoneId: p.currentZone.id,
      currentZoneNameZh: p.currentZone.nameZh,
      requiredZoneId: p.category.requiredZone.id,
      requiredZoneNameZh: p.category.requiredZone.nameZh,
      value: qty * price,
    })
  }

  mismatches.sort((a, b) => b.value - a.value)
  return mismatches.slice(0, limit).map(({ value: _value, ...rest }) => rest)
}

/** 未定位商品数：ACTIVE 且 currentZoneId 为空 */
export async function getUnplacedCount(): Promise<number> {
  return prisma.product.count({
    where: { status: 'ACTIVE', currentZoneId: null },
  })
}
