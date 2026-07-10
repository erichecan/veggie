import { prisma } from '@/lib/db'
import { getLastPurchaseOrderDateByGroup } from '@/lib/analytics/last-po-by-group'

/**
 * 采购总览页数据 SSOT —— 聚合四个品类页面（生鲜每日建议/超市日韩目录/干货年度计划）
 * 已经产出的真实数据（PurchaseSuggestion、PurchaseOrder、GoodsReceipt），不重新发明算法。
 */

const PO_COUNTED = `'CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED'`
const REMIND_AFTER_DAYS = 7
const PERIODIC_GROUPS = ['SUPERMARKET', 'JAPANESE_KOREAN']

export interface OverviewKPIs {
  monthSpend: number
  monthSpendDeltaPct: number | null
  criticalCount: number
  overdueCount: number
  toApproveCount: number
}

export interface GroupOverviewRow {
  key: string
  name: string
  nameZh: string
  cadence: string
  ownerName: string | null
  monthSpend: number
  pendingCount: number
  lastOrderDate: Date | null
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

const GROUP_META: Record<string, { icon: string; label: string }> = {
  FRESH_FROZEN: { icon: '🥬', label: '生鲜' },
  SUPERMARKET: { icon: '🛒', label: '超市' },
  JAPANESE_KOREAN: { icon: '🍱', label: '日韩' },
  DRY_GOODS: { icon: '🌾', label: '干货' },
}

async function monthSpendBetween(start: Date, end: Date): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  const rows = (await p.$queryRawUnsafe(
    `SELECT COALESCE(SUM("subtotalExTax"), 0)::float AS amt
     FROM "PurchaseOrder"
     WHERE status::text IN (${PO_COUNTED}) AND "orderDate" >= $1 AND "orderDate" < $2`,
    start, end,
  )) as Array<{ amt: number }>
  return rows[0]?.amt ?? 0
}

export async function getOverviewKPIs(): Promise<OverviewKPIs> {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)

  const [monthSpend, lastMonthSpend, criticalCount, toApproveCount, lastByGroup] = await Promise.all([
    monthSpendBetween(monthStart, now),
    monthSpendBetween(lastMonthStart, monthStart),
    prisma.purchaseSuggestion.count({ where: { status: 'pending', priority: 'critical' } }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).purchaseOrder.count({ where: { status: 'TO_APPROVE' } }),
    getLastPurchaseOrderDateByGroup(),
  ])

  const overdueCount = PERIODIC_GROUPS.filter(k => {
    const d = lastByGroup[k]
    if (!d) return true
    return Math.floor((now.getTime() - new Date(d).getTime()) / 86400000) > REMIND_AFTER_DAYS
  }).length

  const monthSpendDeltaPct = lastMonthSpend > 0
    ? Number((((monthSpend - lastMonthSpend) / lastMonthSpend) * 100).toFixed(1))
    : null

  return { monthSpend, monthSpendDeltaPct, criticalCount, overdueCount, toApproveCount }
}

export async function getGroupOverview(): Promise<GroupOverviewRow[]> {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  const [groups, spendRows, pendingRows, lastByGroup] = await Promise.all([
    p.categoryGroup.findMany({ include: { owner: { select: { name: true } } } }),
    p.$queryRawUnsafe(
      `SELECT cg.key AS group_key, SUM(pol."subtotalExTax")::float AS amt
       FROM "PurchaseOrderLine" pol
       JOIN "PurchaseOrder" po ON po.id = pol."purchaseOrderId"
       JOIN "Product" pr ON pr.id = pol."productId"
       JOIN "ProductCategory" pc ON pc.id = pr."categoryId"
       JOIN "CategoryGroup" cg ON cg.id = pc."groupId"
       WHERE po.status::text IN (${PO_COUNTED}) AND po."orderDate" >= $1 AND po."orderDate" < $2
       GROUP BY cg.key`,
      monthStart, now,
    ) as Promise<Array<{ group_key: string; amt: number }>>,
    prisma.purchaseSuggestion.groupBy({ by: ['categoryGroupKey'], where: { status: 'pending' }, _count: true }),
    getLastPurchaseOrderDateByGroup(),
  ])

  const spendMap = new Map(spendRows.map(r => [r.group_key, r.amt]))
  const pendingMap = new Map(pendingRows.map((r: { categoryGroupKey: string | null; _count: number }) => [r.categoryGroupKey, r._count]))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return groups.map((g: any) => ({
    key: g.key,
    name: g.name,
    nameZh: g.nameZh,
    cadence: g.cadence,
    ownerName: g.owner?.name ?? null,
    monthSpend: spendMap.get(g.key) ?? 0,
    pendingCount: pendingMap.get(g.key) ?? 0,
    lastOrderDate: lastByGroup[g.key] ? new Date(lastByGroup[g.key]!) : null,
  }))
}

export async function getAttentionItems(limit = 8): Promise<AttentionItem[]> {
  const items: AttentionItem[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any

  // 1. 严重缺货建议（跨品类）
  const criticalSuggestions = await prisma.purchaseSuggestion.findMany({
    where: { status: 'pending', priority: 'critical' },
    orderBy: { generatedAt: 'desc' },
    take: 4,
  })
  for (const s of criticalSuggestions) {
    const meta = GROUP_META[s.categoryGroupKey ?? ''] ?? { icon: '📦', label: '其他' }
    const href = s.categoryGroupKey === 'FRESH_FROZEN' ? '/classic/operator/purchases/fresh'
      : s.categoryGroupKey === 'DRY_GOODS' ? '/classic/operator/purchases/annual-plan'
      : '/classic/operator/purchases/catalog'
    items.push({
      severity: 'crit',
      categoryLabel: meta.label,
      icon: meta.icon,
      title: `${s.productName} 建议采购 ${Number(s.suggestedQty)}`,
      desc: s.reason ?? '库存已见底，请尽快处理',
      actionLabel: '去处理 →',
      actionHref: href,
    })
  }

  // 2. 周期品类逾期提醒
  const lastByGroup = await getLastPurchaseOrderDateByGroup()
  const now = new Date()
  for (const key of PERIODIC_GROUPS) {
    const d = lastByGroup[key]
    const overdue = !d || Math.floor((now.getTime() - new Date(d).getTime()) / 86400000) > REMIND_AFTER_DAYS
    if (!overdue) continue
    const meta = GROUP_META[key]
    items.push({
      severity: 'warn',
      categoryLabel: meta.label,
      icon: meta.icon,
      title: `${meta.label}本周该盘货了`,
      desc: d ? `上次下单 ${new Date(d).toLocaleDateString('en-GB')}，已超过每周节奏` : '还没有历史采购记录',
      actionLabel: '去挑选 →',
      actionHref: '/classic/operator/purchases/catalog',
    })
  }

  // 3. 到货满足率低的供应商
  const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const bySupplier = (await p.$queryRawUnsafe(
    `SELECT po."supplierId" AS supplier_id, COALESCE(MAX(s.name), po."supplierId") AS supplier_name,
            SUM(pol."orderedQty")::float AS ordered_qty, SUM(pol."receivedQty")::float AS received_qty
     FROM "PurchaseOrderLine" pol
     JOIN "PurchaseOrder" po ON po.id = pol."purchaseOrderId"
     LEFT JOIN "Customer" s ON s.id = po."supplierId"
     WHERE po.status::text IN (${PO_COUNTED}) AND po."orderDate" >= $1
     GROUP BY po."supplierId"
     HAVING SUM(pol."orderedQty") > 0`,
    monthStart,
  )) as Array<{ supplier_id: string; supplier_name: string; ordered_qty: number; received_qty: number }>
  for (const s of bySupplier) {
    const rate = s.ordered_qty > 0 ? s.received_qty / s.ordered_qty : 1
    if (rate >= 0.9) continue
    items.push({
      severity: rate < 0.7 ? 'crit' : 'warn',
      categoryLabel: '供应商',
      icon: '📦',
      title: `${s.supplier_name} 近30天到货满足率 ${(rate * 100).toFixed(0)}%`,
      desc: '低于 90% 预警线',
      actionLabel: '查看供应商 →',
      actionHref: '/classic/boss/analytics/procurement',
    })
  }

  // 4. 待审批
  const toApprove = await p.purchaseOrder.findMany({ where: { status: 'TO_APPROVE' }, take: 3, orderBy: { updatedAt: 'desc' } })
  for (const po of toApprove) {
    items.push({
      severity: 'info',
      categoryLabel: '审批',
      icon: '🌾',
      title: `${po.name} 待审批`,
      desc: `预估金额 €${Number(po.totalIncTax).toFixed(2)}`,
      actionLabel: '去审批 →',
      actionHref: `/classic/operator/purchases/${po.id}`,
    })
  }

  const order = { crit: 0, warn: 1, info: 2 }
  return items.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, limit)
}
