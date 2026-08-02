/**
 * 订单列表页(app/api/orders GET)筛选 where 子句的共用构建逻辑，供列表分页查询和
 * CSV 导出(app/api/orders/export-csv)共用，避免筛选口径写两遍、慢慢分叉。
 * 逐字迁移自 app/api/orders/route.ts 原 GET 内联逻辑，行为不变。
 */
import { prisma } from '@/lib/db'
import { tryAuth, effectiveRoles } from '@/lib/auth'
import type { $Enums } from '@/lib/generated/prisma/client'
import { buildFacetWhere, type FacetDef } from '@/lib/facet-sql'

export const ORDER_STATUSES = new Set<$Enums.OrderStatus>([
  'PENDING', 'CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED', 'LOCKED', 'CANCELLED',
])

const like = (v: string) => ({ contains: v, mode: 'insensitive' as const })

/**
 * 订单/报价单列表的分面维度定义 —— 该资源「可搜什么」的唯一真相。
 * key 与 lib/list-filters.ts 的 ORDER_FACET_FIELDS 一一对应；'all' 走 search 参数不在此声明。
 * ⚠️ code 维度存在已知缺陷：Order.code 仅 861/149874 有值，界面用 id.slice 兜底显示，
 *    用户看得见却搜不到（见 docs/20260802-facet-dimension-data-readiness.md §5.1）。
 */
export const ORDER_FACET_DEFS: FacetDef[] = [
  { key: 'code',     label: '单号',     toClause: v => ({ code: like(v) }) },
  { key: 'customer', label: '客户',     toClause: v => ({ restaurantName: like(v) }) },
  { key: 'salesman', label: '销售',     toClause: v => ({ salesUser: { name: like(v) } }) },
  { key: 'product',  label: '产品',     toClause: v => ({ lines: { some: { productName: like(v) } } }) },
  { key: 'category', label: '产品类目', toClause: v => ({ lines: { some: { product: { category: { OR: [
    { name: like(v) }, { nameZh: like(v) },
  ] } } } } }) },
  { key: 'driver',   label: '司机',     toClause: v => driverNameClause(v) },
]

async function driverNameClause(term: string): Promise<Record<string, unknown>> {
  const [matchingWaves, allWaves] = await Promise.all([
    prisma.pickingWave.findMany({ where: { driverName: like(term) }, select: { orderIds: true } }),
    prisma.pickingWave.findMany({ select: { orderIds: true } }),
  ])
  const waveOrderIds = [...new Set(matchingWaves.flatMap((w) => w.orderIds as string[]))]
  const inAnyWave = [...new Set(allWaves.flatMap((w) => w.orderIds as string[]))]
  return {
    OR: [
      { id: { in: waveOrderIds } },
      { AND: [{ id: { notIn: inAnyWave } }, { driverSlot: { driverName: like(term) } }] },
    ],
  }
}

export async function buildOrdersWhere(req: Request, searchParams: URLSearchParams): Promise<Record<string, unknown>> {
  const restaurantId = searchParams.get('restaurantId')
  const restaurantIdsParam = searchParams.get('restaurantIds')
  const restaurantIds = restaurantIdsParam ? restaurantIdsParam.split(',').filter(Boolean) : null
  const idsParam = searchParams.get('ids')
  const ids = idsParam ? idsParam.split(',').filter(Boolean) : null

  const statusParam = searchParams.get('status')
  const statusFilter = statusParam
    ? statusParam.split(',').map(s => s.trim().toUpperCase()).filter(s => ORDER_STATUSES.has(s as $Enums.OrderStatus)) as $Enums.OrderStatus[]
    : null

  const search = searchParams.get('search')?.trim() ?? ''

  const fromDate = searchParams.get('fromDate')
  const toDate = searchParams.get('toDate')
  const dateField = searchParams.get('dateField') ?? 'createdAt'
  const allowedDateFields = new Set(['createdAt', 'deliveryDate', 'quotationDate'])

  const where: Record<string, unknown> = {}
  if (restaurantId) where.restaurantId = restaurantId
  if (restaurantIds && restaurantIds.length > 0) where.restaurantId = { in: restaurantIds }
  if (ids && ids.length > 0) where.id = { in: ids }
  if (statusFilter && statusFilter.length > 0) where.status = { in: statusFilter }
  if (search) {
    where.OR = [
      { restaurantName: { contains: search, mode: 'insensitive' } },
      { code: { contains: search, mode: 'insensitive' } },
    ]
  }
  if (fromDate || toDate) {
    const field = allowedDateFields.has(dateField) ? dateField : 'createdAt'
    const range: Record<string, Date> = {}
    if (fromDate) range.gte = new Date(fromDate + 'T00:00:00Z')
    if (toDate) range.lte = new Date(toDate + 'T23:59:59Z')
    where[field] = range
  }

  const driverSlotId = searchParams.get('driverSlotId')
  if (driverSlotId) where.driverSlotId = driverSlotId

  const salesUserId = searchParams.get('salesUserId')
  if (salesUserId) where.salesUserId = salesUserId

  if (!salesUserId) {
    const caller = await tryAuth(req)
    if (caller) {
      const roles = effectiveRoles(caller)
      if (roles.includes('SALES') && !roles.includes('BOSS') && !roles.includes('OPERATOR')) {
        where.salesUserId = caller.userId
      }
    }
  }

  const categoryIdsParam = searchParams.get('categoryIds') ?? searchParams.get('categoryId')
  const categoryIds = categoryIdsParam ? categoryIdsParam.split(',').filter(Boolean) : null
  if (categoryIds && categoryIds.length > 0) {
    where.lines = { some: { product: { categoryId: { in: categoryIds } } } }
  }

  const facetAnd: Record<string, unknown>[] = []

  const colCode     = searchParams.get('colCode')?.trim()
  const colCustomer = searchParams.get('colCustomer')?.trim()
  const colSalesman = searchParams.get('colSalesman')?.trim()
  const colDriver   = searchParams.get('colDriver')?.trim()
  if (colCode)     where.code = { contains: colCode, mode: 'insensitive' }
  if (colCustomer) where.restaurantName = { contains: colCustomer, mode: 'insensitive' }
  if (colSalesman) where.salesUser = { name: { contains: colSalesman, mode: 'insensitive' } }
  if (colDriver)   facetAnd.push(await driverNameClause(colDriver))

  // 分面搜索：同一维度多值 OR、不同维度之间 AND（20260802 语义修正，此前是分面间 OR，
  // 导致"加一个筛选条件结果反而变多"）。规则集中在 lib/facet-sql.ts，各资源只声明维度。
  facetAnd.push(...await buildFacetWhere(searchParams, ORDER_FACET_DEFS))

  const deliveryFrom = searchParams.get('deliveryFrom')
  const deliveryTo = searchParams.get('deliveryTo')
  if (deliveryFrom || deliveryTo) {
    const range: Record<string, Date> = {}
    if (deliveryFrom) range.gte = new Date(deliveryFrom + 'T00:00:00Z')
    if (deliveryTo) range.lte = new Date(deliveryTo + 'T23:59:59Z')
    facetAnd.push({ deliveryDate: range })
  }
  if (facetAnd.length > 0) where.AND = facetAnd

  return where
}
