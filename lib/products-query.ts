/**
 * 商品列表筛选口径 —— 列表 API(GET /api/product-templates) 与导出
 * (GET /api/export/product-templates) **共用这一份**。
 * ============================================================================
 * 从 app/api/product-templates/route.ts 内联的 where 构造原样抽出（2026-08-18）。
 * 抽出的唯一目的是让导出吃到与列表完全相同的条件 —— 「导出的比屏幕上多/少几行」
 * 这类问题，靠两处各写一份条件是防不住的。
 *
 * 支持的筛选参数（与列表页 UI 一一对应）：
 *   search        搜索框的「全部」维度（名称 / 内部编码 模糊），可重复传，多值之间 OR
 *   status        状态；canBeSold=1  可销售
 *   f_*           Odoo 式分面（同维度 OR、跨维度 AND，见 lib/facet-sql.ts）
 *   cf_<字段>     文本列筛选；cf_<日期字段>_from/_to  日期区间列筛选
 *   cfm_<字段>    多选列筛选（逗号分隔的精确值集合）
 *   stockAlert    negative | low  库存告警筛选
 */
import { prisma } from '@/lib/db'
import { buildFacetWhere } from '@/lib/facet-sql'
import { PRODUCT_TEMPLATE_FACET_DEFS } from '@/lib/facets/product-templates'
import { TTL_STATIC_MS } from '@/lib/http-cache'
import { businessDayStart, addBusinessDays } from '@/lib/analytics/metrics'

export const LOW_STOCK_THRESHOLD = 10

/**
 * 把日期筛选框里的 "YYYY-MM-DD" 转成**都柏林日历日**的起点（真实 UTC 时刻）。
 * ⛔ 不能直接 `new Date(dateStr + 'T00:00:00Z')`——那是 UTC 零点，跟"都柏林的那一天"
 * 差最多 1 小时（夏令时期间），会导致边界附近的记录筛选不到。同 lib/customers-query.ts
 * 的 dublinDayStart，两处筛选口径必须一致。
 */
function dublinDayStart(dateStr: string): Date {
  return businessDayStart(new Date(`${dateStr}T12:00:00Z`))
}

// Decimal/Int 字段做不了 Prisma 原生 contains 子串匹配，用两步查：
// 只拉 id+该字段这两列（比拉整行便宜得多），在内存里做子串匹配后收窄成 id 列表。
const NUMERIC_TEXT_FIELDS = new Set([
  'listPrice', 'standardPrice', 'weight', 'forecastQty', 'commissionPrice', 'sequence',
])

async function idsMatchingNumericSubstring(field: string, needle: string): Promise<string[]> {
  const rows = await prisma.product.findMany({
    select: { id: true, [field]: true },
  }) as unknown as Array<{ id: string; [key: string]: unknown }>
  const q = needle.toLowerCase()
  return rows
    .filter(r => String(r[field] ?? '').toLowerCase().includes(q))
    .map(r => r.id)
}

function intersect(a: Set<string> | null, b: string[]): Set<string> {
  const bs = new Set(b)
  if (a === null) return bs
  return new Set([...a].filter(x => bs.has(x)))
}

// 全表聚合，不带任何请求维度 —— 进程内缓存一份就够，不用 lib/http-cache 的按 URL 分 key。
let stockAlertCountsCache: { value: { negative: number; low: number }; expiresAt: number } | null = null

/** 库存告警角标计数。只有列表页需要，导出不必为此多跑一次全表聚合 */
export async function productStockAlertCounts(): Promise<{ negative: number; low: number }> {
  const now = Date.now()
  if (stockAlertCountsCache && stockAlertCountsCache.expiresAt > now) {
    return stockAlertCountsCache.value
  }
  const [counts] = await prisma.$queryRawUnsafe<{ negative: number; low: number }[]>(
    `SELECT count(*) FILTER (WHERE "qtyOnHand" < 0)::int AS negative,
            count(*) FILTER (WHERE "qtyOnHand" >= 0 AND "qtyOnHand" < $1)::int AS low
     FROM "Product"`,
    LOW_STOCK_THRESHOLD,
  )
  const value = { negative: counts?.negative ?? 0, low: counts?.low ?? 0 }
  stockAlertCountsCache = { value, expiresAt: now + TTL_STATIC_MS }
  return value
}

export async function buildProductTemplatesWhere(
  searchParams: URLSearchParams,
): Promise<Record<string, unknown>> {
  const status = searchParams.get('status') ?? ''

  const where: Record<string, unknown> = {}
  // 归档商品**默认不出现在商品管理里**（20260819 客户要求）。
  //
  // 起因：客户在一个已归档的商品上配了半天多规格，回到报价页却怎么都搜不到它 ——
  // 下单/报价的选品只取 `status=ACTIVE`（1736 个），而商品管理页当时不筛状态，
  // 把 5477 个全列出来，归档的看起来和在售的一模一样。人在商品管理里能看到、
  // 能编辑、能保存，到了报价页却不存在，这个落差没有任何提示。
  //
  // 显式传 `status=all` 才会连归档一起返回（列表页的「显示已归档」开关走这条）。
  if (status && status !== 'all') where.status = status.toUpperCase()
  else if (!status) where.status = { not: 'ARCHIVED' }
  if (searchParams.get('canBeSold') === '1') where.canBeSold = true
  // ── 分面搜索：同维度 OR、跨维度 AND。搜索框的「全部」维度也在其中（参数名 search），
  // 与 f_* 走同一条路 —— 此前它是路由手写的 get('search')，同维度第二个词会被静默丢掉。──
  const facetClauses = await buildFacetWhere(searchParams, PRODUCT_TEMPLATE_FACET_DEFS)
  if (facetClauses.length > 0) where.AND = facetClauses

  // ── 文本列筛选(cf_*) ──────────────────────────────────────────────────────
  const textFields = ['internalRef', 'name', 'saleDescription', 'externalId']
  for (const field of textFields) {
    const v = searchParams.get(`cf_${field}`)?.trim()
    if (v) where[field] = { contains: v, mode: 'insensitive' }
  }
  // 分类：列筛输入的是分类名(人看得懂的)，不是 categoryId，走 relation 匹配
  const cfCategory = searchParams.get('cf_categoryId')?.trim()
  if (cfCategory) {
    where.category = { OR: [
      { name: { contains: cfCategory, mode: 'insensitive' } },
      { nameZh: { contains: cfCategory, mode: 'insensitive' } },
    ] }
  }

  // 数值字段的"子串"筛选：两步查(见 idsMatchingNumericSubstring)，与其它筛选取交集
  let restrictToIds: Set<string> | null = null
  for (const field of NUMERIC_TEXT_FIELDS) {
    const v = searchParams.get(`cf_${field}`)?.trim()
    if (v) restrictToIds = intersect(restrictToIds, await idsMatchingNumericSubstring(field, v))
  }

  // ── 多选列筛选(cfm_*，逗号分隔的精确值集合) ─────────────────────────────
  const cfmType = searchParams.get('cfm_type')
  if (cfmType) where.type = { in: cfmType.split(',').filter(Boolean).map(s => s.toUpperCase()) }
  const cfmCreatedBy = searchParams.get('cfm_createdBy')
  if (cfmCreatedBy) where.createdBy = { in: cfmCreatedBy.split(',').filter(Boolean) }
  const cfmUpdatedBy = searchParams.get('cfm_updatedBy')
  if (cfmUpdatedBy) where.updatedBy = { in: cfmUpdatedBy.split(',').filter(Boolean) }
  const cfmCustomerTax = searchParams.get('cfm_customerTaxRate')
  if (cfmCustomerTax) {
    const nums = cfmCustomerTax.split(',').map(s => parseFloat(s)).filter(Number.isFinite)
    if (nums.length > 0) where.customerTaxRate = { in: nums }
  }
  const cfmVendorTax = searchParams.get('cfm_vendorTaxRate')
  if (cfmVendorTax) {
    const nums = cfmVendorTax.split(',').map(s => parseFloat(s)).filter(Number.isFinite)
    if (nums.length > 0) where.vendorTaxRate = { in: nums }
  }
  const cfmUom = searchParams.get('cfm_uomName')
  if (cfmUom) {
    const vals = cfmUom.split(',').filter(Boolean)
    if (vals.length > 0) where.uom = { OR: [{ name: { in: vals } }, { nameZh: { in: vals } }] }
  }

  // ── 日期区间列筛选 ─────────────────────────────────────────────────────
  for (const field of ['createdAt', 'updatedAt']) {
    const from = searchParams.get(`cf_${field}_from`)
    const to = searchParams.get(`cf_${field}_to`)
    if (from || to) {
      const range: Record<string, Date> = {}
      if (from) range.gte = dublinDayStart(from)
      if (to) range.lt = addBusinessDays(dublinDayStart(to), 1)
      where[field] = range
    }
  }

  // ── 库存告警(negative/low) ────────────────────────────────────────────
  const stockAlert = searchParams.get('stockAlert')
  if (stockAlert === 'negative') where.qtyOnHand = { lt: 0 }
  else if (stockAlert === 'low') where.qtyOnHand = { gte: 0, lt: LOW_STOCK_THRESHOLD }

  if (restrictToIds !== null) where.id = { in: [...restrictToIds] }

  return where
}

/** 列表与导出共用的排序：与列表页表格默认顺序一致 */
export const PRODUCT_TEMPLATE_ORDER_BY = [
  { status: 'asc' as const },
  { sequence: { sort: 'asc' as const, nulls: 'last' as const } },
  { createdAt: 'desc' as const },
]

type SortDir = 'asc' | 'desc'

/**
 * 列表页点表头排序 → 服务端 orderBy（20260907）。此前 sortKey/sortDir 只在前端对
 * 已分页的这 50 条 `sortRows`，翻页/换排序方向时看到的顺序跟其余 5000+ 条商品脱节——
 * 客户反馈："设定 Last Updated 日期时显示 11 个产品，取消日期后光靠排序，
 * 9/6 修改的商品不是集中在一起，分散在好几页"。与 lib/customers-query.ts 的
 * SIMPLE_SORT 同一套修法：按整个筛选结果集在数据库里排序，而不是对当前页重排。
 */
const PRODUCT_TEMPLATE_SORT_MAP: Record<string, (dir: SortDir) => object> = {
  internalRef: (dir) => ({ internalRef: dir }),
  externalId: (dir) => ({ externalId: dir }),
  sequence: (dir) => ({ sequence: { sort: dir, nulls: 'last' } }),
  name: (dir) => ({ name: dir }),
  listPrice: (dir) => ({ listPrice: dir }),
  standardPrice: (dir) => ({ standardPrice: dir }),
  weight: (dir) => ({ weight: dir }),
  updatedAt: (dir) => ({ updatedAt: dir }),
  // 分类列排序按显示名称(categoryLabel)传参，其实按 relation 的 name 字段排序
  categoryLabel: (dir) => ({ category: { name: dir } }),
  // Sale Units 列没有标量字段可排，按挂了几个可售单位（relation count）排序
  saleUnitsCount: (dir) => ({ saleUoms: { _count: dir } }),
}

export function buildProductTemplatesOrderBy(sortKey: string | null, sortDir: SortDir) {
  const build = sortKey ? PRODUCT_TEMPLATE_SORT_MAP[sortKey] : undefined
  return build ? [build(sortDir)] : PRODUCT_TEMPLATE_ORDER_BY
}

