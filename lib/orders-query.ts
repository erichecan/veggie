/**
 * 订单列表页(app/api/orders GET)筛选 where 子句的共用构建逻辑，供列表分页查询和
 * CSV 导出(app/api/orders/export-csv)共用，避免筛选口径写两遍、慢慢分叉。
 * 逐字迁移自 app/api/orders/route.ts 原 GET 内联逻辑，行为不变。
 */
import { prisma } from '@/lib/db'
import { tryAuth } from '@/lib/auth'
import { salesRowScope, withRowScope } from '@/lib/row-scope'
import type { $Enums } from '@/lib/generated/prisma/client'
import { buildFacetWhere, type FacetDef } from '@/lib/facet-sql'

export const ORDER_STATUSES = new Set<$Enums.OrderStatus>([
  'PENDING', 'CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED', 'LOCKED', 'CANCELLED',
])

const like = (v: string) => ({ contains: v, mode: 'insensitive' as const })

/**
 * 订单/报价单列表的分面维度定义 —— 该资源「可搜什么」的唯一真相。
 * key 与 lib/list-filters.ts 的 ORDER_FACET_FIELDS 一一对应；'all' 走 search 参数不在此声明。
 * code 维度：20260802 已用 scripts/backfill-order-code-from-odoo.ts 从 Odoo 原始单号回填，
 * 覆盖率 861/149874 → 149874/149874 (100%)，"看得见搜不到"的问题已消除。
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

/**
 * 「这单归哪个司机」的筛选口径（两条并集，与显示口径一致）：
 *   a) 订单在某个 driverName 匹配的波次里 —— 调度归属的真相（SSOT P0-1）
 *   b) 订单不在任何波次里，且其 Order.driverSlot 的司机名匹配 —— 回退到下单意向
 *
 * 20260802 改写：原实现把**全部**波次的 orderIds 拉进 Node（`findMany` 无 where），
 * 在内存里求并集后塞进 `notIn`。波次表按天线性增长（每司机每时段一条），
 * 那个 notIn 列表会随之膨胀——属于"不改会随时间必然劣化"的形状。
 * 现在整个判定交给数据库：b) 的"不在任何波次"用 NOT EXISTS + 数组包含，
 * 走 idx_pickingwave_orderids_gin（见 20260802160000 迁移）。
 *
 * 等价性已在真实数据上逐一验证（8 个司机名含一个不存在的，命中数完全一致）。
 */
async function driverNameClause(term: string): Promise<Record<string, unknown>> {
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT DISTINCT id FROM (
       SELECT unnest(w."orderIds") AS id FROM "PickingWave" w WHERE w."driverName" ILIKE $1
       UNION
       SELECT o.id FROM "Order" o
         JOIN "DriverSlot" d ON d.id = o."driverSlotId"
        WHERE d."driverName" ILIKE $1
          AND NOT EXISTS (SELECT 1 FROM "PickingWave" w2 WHERE w2."orderIds" @> ARRAY[o.id])
     ) t`,
    `%${term}%`,
  )
  return { id: { in: rows.map((r) => r.id) } }
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

  // ⛔ 行级隔离必须放在**最后**，且走 withRowScope（AND 里加一项），不能写成
  // `where.salesUserId = …`。原实现两个毛病：写在 `if (!salesUserId)` 分支里，
  // 只要请求带 `?salesUserId=别人的id` 隔离就整段跳过；即使进了分支也是直接赋值，
  // 会被同名参数覆盖。放在最后 + AND 包裹，才是谁也删不掉的。
  return withRowScope(where, salesRowScope(await tryAuth(req)))
}
