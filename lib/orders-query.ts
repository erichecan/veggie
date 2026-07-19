/**
 * 订单列表页(app/api/orders GET)筛选 where 子句的共用构建逻辑，供列表分页查询和
 * CSV 导出(app/api/orders/export-csv)共用，避免筛选口径写两遍、慢慢分叉。
 * 逐字迁移自 app/api/orders/route.ts 原 GET 内联逻辑，行为不变。
 */
import { prisma } from '@/lib/db'
import { tryAuth, effectiveRoles } from '@/lib/auth'
import type { $Enums } from '@/lib/generated/prisma/client'

export const ORDER_STATUSES = new Set<$Enums.OrderStatus>([
  'PENDING', 'CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED', 'LOCKED', 'CANCELLED',
])

const like = (v: string) => ({ contains: v, mode: 'insensitive' as const })

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

  const facetOr: Record<string, unknown>[] = []
  const fCode     = searchParams.get('f_code')?.trim()
  const fCustomer = searchParams.get('f_customer')?.trim()
  const fSalesman = searchParams.get('f_salesman')?.trim()
  const fProduct  = searchParams.get('f_product')?.trim()
  const fCategory = searchParams.get('f_category')?.trim()
  const fDriver   = searchParams.get('f_driver')?.trim()
  if (fCode)     facetOr.push({ code: like(fCode) })
  if (fCustomer) facetOr.push({ restaurantName: like(fCustomer) })
  if (fSalesman) facetOr.push({ salesUser: { name: like(fSalesman) } })
  if (fProduct)  facetOr.push({ lines: { some: { productName: like(fProduct) } } })
  if (fCategory) facetOr.push({ lines: { some: { product: { category: { OR: [
    { name: like(fCategory) },
    { nameZh: like(fCategory) },
  ] } } } } })
  if (fDriver)   facetOr.push(await driverNameClause(fDriver))
  if (facetOr.length > 0) facetAnd.push(facetOr.length === 1 ? facetOr[0] : { OR: facetOr })

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
