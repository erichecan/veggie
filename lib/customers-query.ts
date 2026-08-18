/**
 * 客户列表筛选口径 —— 列表 API(GET /api/customers) 与导出
 * (GET /api/export/customers) **共用这一份**。
 * ============================================================================
 * 从 app/api/customers/route.ts 内联的 where 构造抽出（2026-08-18）。
 *
 * ⛔ 行级隔离（salesRowScope）必须在这里、且必须 push 进 andConditions 之前完成：
 *    where 为空数组时会退化成 {}，之后再往数组里 push 就完全不生效。
 *    20260802 审计正是在这里发现隔离静默失效的（同一路由，那次是 includeArchived=1
 *    且无其他筛选的组合）。导出是批量拿数据，这里漏一次比列表页漏一次严重得多。
 */
import { prisma } from '@/lib/db'
import { buildFacetWhere } from '@/lib/facet-sql'
import { CUSTOMER_FACET_DEFS } from '@/lib/facets/customers'
import { salesRowScope } from '@/lib/row-scope'
import type { JwtPayload } from '@/lib/auth'

export async function buildCustomersWhere(
  searchParams: URLSearchParams,
  caller: JwtPayload | null,
): Promise<Record<string, unknown>> {
  const search = searchParams.get('search') ?? ''
  const createdFrom = searchParams.get('createdFrom') ?? ''
  const createdTo = searchParams.get('createdTo') ?? ''
  const paymentTermFilter = searchParams.get('paymentTerm') ?? ''
  const pricelistFilter = searchParams.get('pricelistId') ?? ''
  const minOrderCount = parseInt(searchParams.get('minOrderCount') ?? '0', 10)
  const includeArchived = searchParams.get('includeArchived') === '1'

  const andConditions: Record<string, unknown>[] = []
  if (!includeArchived) andConditions.push({ isActive: true })

  const isVendorParam = searchParams.get('isVendor')
  if (isVendorParam === 'true' || isVendorParam === '1') andConditions.push({ isVendor: true })

  if (search) {
    andConditions.push({
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { vatNumber: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ],
    })
  }
  // 分面搜索：同维度 OR、跨维度 AND
  andConditions.push(...await buildFacetWhere(searchParams, CUSTOMER_FACET_DEFS))

  // 行级隔离：销售只看自己名下的客户。规则在 lib/row-scope.ts（唯一真相）。
  // ⚠️ 必须在构造 where 之前 push —— 见文件头说明。
  const rowScope = salesRowScope(caller)
  if (rowScope) andConditions.push(rowScope)

  const where: Record<string, unknown> = andConditions.length > 0 ? { AND: andConditions } : {}
  if (createdFrom || createdTo) {
    where.createdAt = {
      ...(createdFrom ? { gte: new Date(createdFrom) } : {}),
      ...(createdTo ? { lte: new Date(createdTo + 'T23:59:59.999Z') } : {}),
    }
  }
  if (paymentTermFilter) where.paymentTerm = paymentTermFilter
  if (pricelistFilter) where.pricelists = { some: { pricelistId: pricelistFilter } }

  // 购买频次：近30天订单数 >= N
  // Order.restaurantId → User.id (RESTAURANT role) → User.customerId → Customer.id
  if (minOrderCount > 0) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const orderGroups = await prisma.order.groupBy({
      by: ['restaurantId'],
      where: { createdAt: { gte: thirtyDaysAgo } },
      _count: { id: true },
      having: { id: { _count: { gte: minOrderCount } } },
    })
    const users = await prisma.user.findMany({
      where: { id: { in: orderGroups.map(r => r.restaurantId) }, customerId: { not: null } },
      select: { customerId: true },
    })
    const eligibleIds = users.map(u => u.customerId).filter(Boolean) as string[]
    // 一个都不符合时也要落成"查不到任何客户"，不能不加条件（那等于不筛）
    where.id = { in: eligibleIds }
  }

  return where
}
