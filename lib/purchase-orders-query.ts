/**
 * 采购单列表筛选口径 —— 列表 API(GET /api/purchase-orders) 与导出
 * (GET /api/export/purchase-orders) 共用这一份。
 */
import { buildFacetWhere } from '@/lib/facet-sql'
import { PURCHASE_ORDER_FACET_DEFS } from '@/lib/facets/purchase-orders'

export async function buildPurchaseOrdersWhere(
  searchParams: URLSearchParams,
): Promise<Record<string, unknown>> {
  const supplierId = searchParams.get('supplierId')
  const status = searchParams.get('status')?.toUpperCase()

  const where: Record<string, unknown> = {}
  if (supplierId) where.supplierId = supplierId
  if (status) where.status = status

  // 分面搜索：同维度 OR、跨维度 AND
  const facetClauses = await buildFacetWhere(searchParams, PURCHASE_ORDER_FACET_DEFS)
  if (facetClauses.length > 0) where.AND = facetClauses

  return where
}
