import { prisma } from '@/lib/db'
import { toNum, round2 } from '@/lib/decimal-helpers'

/**
 * 库存总览页数据 SSOT —— 聚合库存模块现有真实信号（Product/Lot/StockMove/StockTake）。
 * 不新造字段，不硬编码阈值：低库存判定统一用 Product.safetyStockMin（可空=未设置阈值，跳过）。
 */

const EXPIRING_DAYS = 3
const STOCK_TAKE_STALE_DAYS = 2
const LOSS_SQL_TYPES = `sm.type = 'SCRAP' OR (sm.type = 'ADJUSTMENT' AND sm."sourceType" = 'STOCK_TAKE' AND sm.qty < 0)`

export interface InventoryOverviewKPIs {
  totalStockValue: number
  expiringLotCount: number
  monthLossRate: number
  pendingStockTakeCount: number
}

export interface AttentionItem {
  severity: 'crit' | 'warn' | 'info'
  categoryLabel: string
  icon: string
  title: string
  desc: string
  actionLabel: string
  actionHref: string
}

export interface GroupInventoryRow {
  groupKey: string
  groupName: string
  groupNameZh: string
  skuCount: number
  totalValue: number
  lowStockCount: number
}

export async function getInventoryOverviewKPIs(): Promise<InventoryOverviewKPIs> {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const expiringCutoff = new Date(now.getTime() + EXPIRING_DAYS * 86400000)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any

  const [products, expiringLotCount, lossRows, pendingStockTakeCount] = await Promise.all([
    prisma.product.findMany({
      where: { status: 'ACTIVE' },
      select: { qtyOnHand: true, standardPrice: true },
    }),
    p.lot.count({
      where: { status: 'AVAILABLE', bestBefore: { not: null, lte: expiringCutoff } },
    }),
    p.$queryRawUnsafe(
      `SELECT
         COALESCE(SUM(CASE WHEN ${LOSS_SQL_TYPES} THEN ABS(sm.qty) ELSE 0 END), 0)::float AS scrap_qty,
         COALESCE(SUM(CASE WHEN sm.type = 'OUT' THEN ABS(sm.qty) ELSE 0 END), 0)::float AS out_qty
       FROM "StockMove" sm
       WHERE sm."movedAt" >= $1 AND sm."movedAt" < $2`,
      monthStart, now,
    ) as Promise<Array<{ scrap_qty: number; out_qty: number }>>,
    p.stockTake.count({ where: { status: 'DRAFT' } }),
  ])

  const totalStockValue = round2(
    products.reduce((sum: number, pr: { qtyOnHand: unknown; standardPrice: unknown }) => (
      sum + toNum(pr.qtyOnHand) * toNum(pr.standardPrice ?? 0)
    ), 0)
  )

  const loss = lossRows[0] ?? { scrap_qty: 0, out_qty: 0 }
  const monthLossRate = loss.out_qty > 0
    ? Math.round((loss.scrap_qty / loss.out_qty) * 1000) / 10
    : 0

  return { totalStockValue, expiringLotCount, monthLossRate, pendingStockTakeCount }
}

export async function getInventoryAttentionItems(limit = 8, isEn = false): Promise<AttentionItem[]> {
  const now = new Date()
  const expiringCutoff = new Date(now.getTime() + EXPIRING_DAYS * 86400000)
  const staleCutoff = new Date(now.getTime() - STOCK_TAKE_STALE_DAYS * 86400000)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  const items: AttentionItem[] = []

  // 1. 低于安全库存的商品（未设置阈值的商品跳过）
  const lowStockRows = (await p.$queryRawUnsafe(
    `SELECT p.id, p.name, p."qtyOnHand"::float AS qty_on_hand, p."safetyStockMin"::float AS safety_stock_min,
            COALESCE(${isEn ? 'pc.name, cg.name' : 'pc."nameZh", cg."nameZh"'}, '—') AS category_label
     FROM "Product" p
     LEFT JOIN "ProductCategory" pc ON pc.id = p."categoryId"
     LEFT JOIN "CategoryGroup" cg ON cg.id = pc."groupId"
     WHERE p.status = 'ACTIVE' AND p."safetyStockMin" IS NOT NULL AND p."qtyOnHand" <= p."safetyStockMin"
     ORDER BY p."qtyOnHand" ASC
     LIMIT 20`
  )) as Array<{ id: string; name: string; qty_on_hand: number; safety_stock_min: number; category_label: string }>
  for (const r of lowStockRows) {
    items.push({
      severity: r.qty_on_hand <= 0 ? 'crit' : 'warn',
      categoryLabel: r.category_label,
      icon: '⚠️',
      title: isEn
        ? `${r.name} low on stock (current ${r.qty_on_hand}, safety stock ${r.safety_stock_min})`
        : `${r.name} 库存告急（现有 ${r.qty_on_hand}，安全库存 ${r.safety_stock_min}）`,
      desc: r.qty_on_hand <= 0
        ? (isEn ? 'Out of stock, restock urgently' : '已缺货，需尽快补货')
        : (isEn ? 'Below the safety stock threshold' : '已低于安全库存下限'),
      actionLabel: isEn ? 'Handle →' : '去处理 →',
      actionHref: '/classic/operator/inventory',
    })
  }

  // 2. 临期批次（含已过期）
  const expiringLots = await p.lot.findMany({
    where: { status: 'AVAILABLE', bestBefore: { not: null, lte: expiringCutoff } },
    orderBy: { bestBefore: 'asc' },
    take: 10,
    include: { product: { select: { id: true, name: true } } },
  })
  for (const lot of expiringLots as Array<{ lotNumber: string; bestBefore: Date; currentQty: unknown; product: { name: string } | null }>) {
    const isExpired = new Date(lot.bestBefore) < now
    const daysRemaining = Math.ceil((new Date(lot.bestBefore).getTime() - now.getTime()) / 86400000)
    items.push({
      severity: isExpired ? 'warn' : 'info',
      categoryLabel: isEn ? 'Lot' : '批次',
      icon: '⏰',
      title: isEn
        ? `${lot.product?.name ?? 'Unknown product'} lot ${lot.lotNumber} ${isExpired ? 'expired' : `expires in ${daysRemaining} days`}`
        : `${lot.product?.name ?? '未知商品'} 批次 ${lot.lotNumber} ${isExpired ? '已过期' : `${daysRemaining} 天后过期`}`,
      desc: isEn
        ? `${toNum(lot.currentQty)} remaining, best before ${new Date(lot.bestBefore).toLocaleDateString('en-GB')}`
        : `剩余 ${toNum(lot.currentQty)}，保质期至 ${new Date(lot.bestBefore).toLocaleDateString('en-GB')}`,
      actionLabel: isEn ? 'Handle →' : '去处理 →',
      actionHref: '/classic/operator/inventory/lots',
    })
  }

  // 3. 挂起超过 2 天未完成的盘点
  const staleStockTakes = await p.stockTake.findMany({
    where: { status: 'DRAFT', createdAt: { lte: staleCutoff } },
    orderBy: { createdAt: 'asc' },
    take: 10,
  })
  for (const st of staleStockTakes as Array<{ id: string; name: string; createdAt: Date }>) {
    const daysStale = Math.floor((now.getTime() - new Date(st.createdAt).getTime()) / 86400000)
    items.push({
      severity: 'info',
      categoryLabel: isEn ? 'Stock Take' : '盘点',
      icon: '📋',
      title: isEn
        ? `${st.name} stock take pending (stale ${daysStale} days)`
        : `${st.name} 待完成盘点（已挂起 ${daysStale} 天）`,
      desc: isEn
        ? 'This stock take has been open for a long time, please verify and submit soon'
        : '盘点单创建后长期未完成，请尽快核实并提交',
      actionLabel: isEn ? 'Go finish →' : '去完成 →',
      actionHref: '/classic/warehouse/stock-take',
    })
  }

  const order = { crit: 0, warn: 1, info: 2 }
  return items.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, limit)
}

export async function getInventoryByCategoryGroup(): Promise<GroupInventoryRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any

  const [groups, aggRows] = await Promise.all([
    p.categoryGroup.findMany({ orderBy: { key: 'asc' } }),
    p.$queryRawUnsafe(
      `SELECT cg.id AS group_id,
              COUNT(p.id)::int AS sku_count,
              COALESCE(SUM(p."qtyOnHand" * COALESCE(p."standardPrice", 0)), 0)::float AS total_value,
              COUNT(*) FILTER (WHERE p."safetyStockMin" IS NOT NULL AND p."qtyOnHand" <= p."safetyStockMin")::int AS low_stock_count
       FROM "Product" p
       LEFT JOIN "ProductCategory" pc ON pc.id = p."categoryId"
       LEFT JOIN "CategoryGroup" cg ON cg.id = pc."groupId"
       WHERE p.status = 'ACTIVE'
       GROUP BY cg.id`
    ) as Promise<Array<{ group_id: string | null; sku_count: number; total_value: number; low_stock_count: number }>>,
  ])

  const aggMap = new Map(aggRows.map(r => [r.group_id, r]))
  const zero = { sku_count: 0, total_value: 0, low_stock_count: 0 }

  const rows: GroupInventoryRow[] = groups.map((g: { id: string; key: string; name: string; nameZh: string }) => {
    const agg = aggMap.get(g.id) ?? zero
    return {
      groupKey: g.key,
      groupName: g.name,
      groupNameZh: g.nameZh,
      skuCount: agg.sku_count,
      totalValue: round2(agg.total_value),
      lowStockCount: agg.low_stock_count,
    }
  })

  const ungrouped = aggMap.get(null) ?? zero
  rows.push({
    groupKey: 'UNGROUPED',
    groupName: 'Ungrouped',
    groupNameZh: '未分组',
    skuCount: ungrouped.sku_count,
    totalValue: round2(ungrouped.total_value),
    lowStockCount: ungrouped.low_stock_count,
  })

  return rows
}
