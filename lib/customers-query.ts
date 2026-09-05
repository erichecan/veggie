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
import { businessDayStart, addBusinessDays } from '@/lib/analytics/metrics'

/**
 * 把日期筛选框里的 "YYYY-MM-DD" 转成**都柏林日历日**的起点（真实 UTC 时刻）。
 * ⛔ 不能直接 `new Date(dateStr + 'T00:00:00Z')`——那是 UTC 零点，跟"都柏林的那一天"
 * 差最多 1 小时（夏令时期间）。这正是 lib/analytics/metrics.ts 里 resolveDateRange 已经
 * 踩过、锁死的同一类坑：容器时区是 UTC，业务时区是 Europe/Dublin，边界必须按后者算，
 * 不能按进程/请求方所在时区，否则同一条记录在筛选边界附近算不算"选中的这一天"会跟
 * 列表页展示的日期（也按都柏林时区渲染）对不上。用中午 12:00 UTC 当锚点，
 * 避免时区偏移把日期本身也带偏。
 */
function dublinDayStart(dateStr: string): Date {
  return businessDayStart(new Date(`${dateStr}T12:00:00Z`))
}

export async function buildCustomersWhere(
  searchParams: URLSearchParams,
  caller: JwtPayload | null,
): Promise<Record<string, unknown>> {
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

  // 分面搜索：同维度 OR、跨维度 AND（搜索框的「全部」维度也在其中，参数名 search）
  andConditions.push(...await buildFacetWhere(searchParams, CUSTOMER_FACET_DEFS))

  // 行级隔离：销售只看自己名下的客户。规则在 lib/row-scope.ts（唯一真相）。
  // ⚠️ 必须在构造 where 之前 push —— 见文件头说明。
  const rowScope = salesRowScope(caller)
  if (rowScope) andConditions.push(rowScope)

  const where: Record<string, unknown> = andConditions.length > 0 ? { AND: andConditions } : {}
  if (createdFrom || createdTo) {
    where.createdAt = {
      ...(createdFrom ? { gte: dublinDayStart(createdFrom) } : {}),
      ...(createdTo ? { lt: addBusinessDays(dublinDayStart(createdTo), 1) } : {}),
    }
  }
  if (paymentTermFilter) where.paymentTerm = paymentTermFilter
  if (pricelistFilter) where.pricelists = { some: { pricelistId: pricelistFilter } }

  // 列头多选筛选(cfm_*，逗号分隔的精确值集合)，与商品列表页 lib/products-query.ts 同一套惯例
  const cfmPriceType = searchParams.get('cfm_priceType')
  if (cfmPriceType) {
    const vals = cfmPriceType.split(',').filter(Boolean)
    if (vals.length > 0) where.priceType = { in: vals }
  }
  const cfmPricelistId = searchParams.get('cfm_pricelistId')
  if (cfmPricelistId) {
    const vals = cfmPricelistId.split(',').filter(Boolean)
    if (vals.length > 0) where.pricelists = { some: { pricelistId: { in: vals } } }
  }
  const cfmUpdatedBy = searchParams.get('cfm_updatedBy')
  if (cfmUpdatedBy) {
    const vals = cfmUpdatedBy.split(',').filter(Boolean)
    if (vals.length > 0) where.updatedBy = { in: vals }
  }

  // 列头日期区间筛选(cf_<field>_from/_to)，同 lib/products-query.ts 惯例
  const updatedFrom = searchParams.get('cf_updatedAt_from')
  const updatedTo = searchParams.get('cf_updatedAt_to')
  if (updatedFrom || updatedTo) {
    where.updatedAt = {
      ...(updatedFrom ? { gte: dublinDayStart(updatedFrom) } : {}),
      ...(updatedTo ? { lt: addBusinessDays(dublinDayStart(updatedTo), 1) } : {}),
    }
  }

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
