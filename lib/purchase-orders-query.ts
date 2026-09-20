/**
 * 采购单列表筛选口径 —— 列表 API(GET /api/purchase-orders) 与导出
 * (GET /api/export/purchase-orders) 共用这一份。
 */
import { buildFacetWhere } from '@/lib/facet-sql'
import { PURCHASE_ORDER_FACET_DEFS, supplierClause } from '@/lib/facets/purchase-orders'
import { businessDayStart, addBusinessDays } from '@/lib/analytics/metrics'

/**
 * 把日期筛选框里的 "YYYY-MM-DD" 转成**都柏林日历日**的起点（真实 UTC 时刻）。
 * 口径与 lib/orders-query.ts / lib/customers-query.ts 的同名函数一致，不能用 UTC 零点
 * ——夏令时期间差 1 小时，边界那天的单会筛不到。
 */
function dublinDayStart(dateStr: string): Date {
  return businessDayStart(new Date(`${dateStr}T12:00:00Z`))
}

export async function buildPurchaseOrdersWhere(
  searchParams: URLSearchParams,
): Promise<Record<string, unknown>> {
  const supplierId = searchParams.get('supplierId')
  const status = searchParams.get('status')?.toUpperCase()

  const where: Record<string, unknown> = {}
  if (supplierId) where.supplierId = supplierId
  if (status) where.status = status

  // 分面搜索：同维度 OR、跨维度 AND
  const and = [...await buildFacetWhere(searchParams, PURCHASE_ORDER_FACET_DEFS)]

  // 列头筛选框（与分面 chip 独立，彼此 AND）：供应商名模糊 + 订购日期区间
  const colSupplier = searchParams.get('colSupplier')?.trim()
  if (colSupplier) and.push(await supplierClause(colSupplier))

  const orderDateFrom = searchParams.get('orderDateFrom')
  const orderDateTo = searchParams.get('orderDateTo')
  if (orderDateFrom || orderDateTo) {
    const range: Record<string, Date> = {}
    if (orderDateFrom) range.gte = dublinDayStart(orderDateFrom)
    if (orderDateTo) range.lt = addBusinessDays(dublinDayStart(orderDateTo), 1)
    and.push({ orderDate: range })
  }

  if (and.length > 0) where.AND = and

  return where
}
