import { prisma } from '@/lib/db'
import { toNum, round2 } from '@/lib/decimal-helpers'

/**
 * 库存总览页数据 SSOT —— 聚合库存模块现有真实信号（Product/Lot/StockMove/StockTake）。
 * 不新造字段，不硬编码阈值：低库存判定统一用 Product.safetyStockMin（可空=未设置阈值，跳过）。
 */

// 临期批次分两档：紧急(7天内，KPI 卡片用这个口径，避免一下子把"远期也算"的大数字
// 怼到首屏吓到人)/预警(60天=约2个月，客户对多批次保质期错开的商品明确要求"提前2个月
// 提醒"，20261003 定)。此前只有一档 EXPIRING_DAYS=3，纯按日期判断，不管这批货卖不卖
// 得完——走得慢的商品哪怕还剩1个月保质期也该现在就露头，等进了"临期"窗口再提醒就晚了，
// 这正是 getInventoryAttentionItems 里"预计卖不完就过期"那段要补的缺口。
const EXPIRY_CRITICAL_DAYS = 7
const EXPIRY_WARNING_DAYS = 60
const STOCK_TAKE_STALE_DAYS = 2
// 销量基准回看窗口：4 周，客户 20261003 确认。4 周够平滑单周波动，又不会被几个月前的旧
// 数据带偏——见 getSellThroughRiskItems。
const SALES_VELOCITY_WEEKS = 4
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
  const expiringCutoff = new Date(now.getTime() + EXPIRY_CRITICAL_DAYS * 86400000)

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
  const expiringCutoff = new Date(now.getTime() + EXPIRY_WARNING_DAYS * 86400000)
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

  // 2. 临期批次（含已过期）：紧急(≤7天或已过期)/预警(≤60天，即客户要的"提前2个月")两档
  const expiringLots = await p.lot.findMany({
    where: { status: 'AVAILABLE', bestBefore: { not: null, lte: expiringCutoff } },
    orderBy: { bestBefore: 'asc' },
    take: 20,
    include: { product: { select: { id: true, name: true } } },
  })
  for (const lot of expiringLots as Array<{ lotNumber: string; bestBefore: Date; currentQty: unknown; product: { name: string } | null }>) {
    const isExpired = new Date(lot.bestBefore) < now
    const daysRemaining = Math.ceil((new Date(lot.bestBefore).getTime() - now.getTime()) / 86400000)
    const isCritical = isExpired || daysRemaining <= EXPIRY_CRITICAL_DAYS
    items.push({
      severity: isCritical ? 'crit' : 'warn',
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

  // 3. 预计卖不完就过期（走得慢的商品，哪怕保质期还早）：按最近 SALES_VELOCITY_WEEKS 周的
  // 出库量算周均销量，把该商品尚未进入上面"临期"窗口的批次按保质期先后累加，算出"卖到这一
  // 批的位置"预计要多久；比保质期剩余天数还长，说明照这个卖法这批货铁定在卖完前就过期——
  // 这是客户要的"根据库存+最近几周销量+保质期预判"，不是纯日期判断。
  // weekly_rate=0（近4周完全没卖出去过）直接判定为风险：零动销的商品，只要还有保质期
  // 在倒计时，就一定会过期，不用等"卖不完"这个假设性判断成立。
  const velocityCutoff = new Date(now.getTime() - SALES_VELOCITY_WEEKS * 7 * 86400000)
  const sellThroughRows = (await p.$queryRawUnsafe(
    `WITH velocity AS (
       SELECT "productId", SUM(ABS(qty))::float / $1 AS weekly_rate
       FROM "StockMove"
       WHERE type = 'OUT' AND "movedAt" >= $2
       GROUP BY "productId"
     ),
     lot_cum AS (
       SELECT l.id, l."lotNumber", l."bestBefore", l."currentQty"::float AS current_qty, l."productId",
              SUM(l."currentQty"::float) OVER (
                PARTITION BY l."productId" ORDER BY l."bestBefore" ASC, l."arrivedAt" ASC
              ) AS cum_qty
       FROM "Lot" l
       WHERE l.status = 'AVAILABLE' AND l."currentQty" > 0 AND l."bestBefore" IS NOT NULL
         AND l."bestBefore" > $3
     )
     SELECT lc."lotNumber" AS lot_number, lc."bestBefore" AS best_before, lc.current_qty,
            p.name AS product_name, COALESCE(v.weekly_rate, 0) AS weekly_rate,
            EXTRACT(EPOCH FROM (lc."bestBefore" - now())) / 86400.0 AS days_until_expiry
     FROM lot_cum lc
     JOIN "Product" p ON p.id = lc."productId"
     LEFT JOIN velocity v ON v."productId" = lc."productId"
     WHERE COALESCE(v.weekly_rate, 0) = 0
        OR (lc.cum_qty / v.weekly_rate) * 7 > EXTRACT(EPOCH FROM (lc."bestBefore" - now())) / 86400.0
     ORDER BY lc."bestBefore" ASC
     LIMIT 15`,
    SALES_VELOCITY_WEEKS, velocityCutoff, expiringCutoff,
  )) as Array<{
    lot_number: string; best_before: Date; current_qty: number
    product_name: string; weekly_rate: number; days_until_expiry: number
  }>
  for (const r of sellThroughRows) {
    const weeksRemaining = Math.max(0, r.days_until_expiry / 7)
    items.push({
      severity: 'warn',
      categoryLabel: isEn ? 'Slow-moving' : '滞销预警',
      icon: '🐌',
      title: isEn
        ? `${r.product_name} lot ${r.lot_number} may expire before it sells out`
        : `${r.product_name} 批次 ${r.lot_number} 照目前销量可能卖不完就过期`,
      desc: r.weekly_rate > 0
        ? (isEn
          ? `${r.current_qty} left, ~${r.weekly_rate.toFixed(1)}/week recently, best before in ${weeksRemaining.toFixed(1)} weeks`
          : `剩余 ${r.current_qty}，近期周均销量约 ${r.weekly_rate.toFixed(1)}，还有 ${weeksRemaining.toFixed(1)} 周到期`)
        : (isEn
          ? `${r.current_qty} left, no sales in the past ${SALES_VELOCITY_WEEKS} weeks, best before in ${weeksRemaining.toFixed(1)} weeks`
          : `剩余 ${r.current_qty}，近 ${SALES_VELOCITY_WEEKS} 周无销量，还有 ${weeksRemaining.toFixed(1)} 周到期`),
      actionLabel: isEn ? 'Handle →' : '去处理 →',
      actionHref: '/classic/operator/inventory/lots',
    })
  }

  // 4. FEFO 合规检查：某批次已耗尽(DEPLETED)，但同一商品还有保质期更早、仍有库存的批次
  // 没卖掉——说明实际出货没有按保质期从短到长来，客户要的"是不是按保质期短的先出货，
  // 不是就调整"。只看"现在还存在更早过期的可用批次"这个条件本身就天然限定在当下仍可
  // 纠正的场景，不需要额外按时间窗口过滤历史数据。
  const fefoViolations = (await p.$queryRawUnsafe(
    `SELECT depleted."lotNumber" AS depleted_lot, depleted."bestBefore" AS depleted_best_before,
            earlier."lotNumber" AS earlier_lot, earlier."bestBefore" AS earlier_best_before,
            earlier."currentQty"::float AS earlier_qty, p.name AS product_name
     FROM "Lot" depleted
     JOIN "Lot" earlier ON earlier."productId" = depleted."productId"
       AND earlier.status = 'AVAILABLE' AND earlier."currentQty" > 0
       AND earlier."bestBefore" IS NOT NULL AND depleted."bestBefore" IS NOT NULL
       AND earlier."bestBefore" < depleted."bestBefore"
     JOIN "Product" p ON p.id = depleted."productId"
     WHERE depleted.status = 'DEPLETED'
     ORDER BY earlier."bestBefore" ASC
     LIMIT 15`
  )) as Array<{
    depleted_lot: string; depleted_best_before: Date; earlier_lot: string
    earlier_best_before: Date; earlier_qty: number; product_name: string
  }>
  for (const r of fefoViolations) {
    items.push({
      severity: 'warn',
      categoryLabel: isEn ? 'FEFO check' : '先进先出核查',
      icon: '🔀',
      title: isEn
        ? `${r.product_name}: lot ${r.depleted_lot} sold out before earlier-expiring lot ${r.earlier_lot}`
        : `${r.product_name}：批次 ${r.depleted_lot} 已卖完，但保质期更早的批次 ${r.earlier_lot} 还有库存`,
      desc: isEn
        ? `${r.earlier_lot} best before ${new Date(r.earlier_best_before).toLocaleDateString('en-GB')}, ${r.earlier_qty} left — check whether picking followed shortest-shelf-life-first`
        : `${r.earlier_lot} 保质期至 ${new Date(r.earlier_best_before).toLocaleDateString('en-GB')}，剩余 ${r.earlier_qty}——请核实拣货是否按保质期从短到长出货，不是的话调整`,
      actionLabel: isEn ? 'View lot →' : '查看批次 →',
      actionHref: '/classic/operator/inventory/lots',
    })
  }

  // 5. 挂起超过 2 天未完成的盘点
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
