/**
 * 商品列表筛选口径 —— 列表 API(GET /api/product-templates) 与导出
 * (GET /api/export/product-templates) **共用这一份**。
 * ============================================================================
 * 从 app/api/product-templates/route.ts 内联的 where 构造原样抽出（2026-08-18）。
 * 抽出的唯一目的是让导出吃到与列表完全相同的条件 —— 「导出的比屏幕上多/少几行」
 * 这类问题，靠两处各写一份条件是防不住的。
 *
 * 支持的筛选参数（与列表页 UI 一一对应）：
 *   search        搜索框（名称 / 内部编码 模糊）
 *   status        状态；canBeSold=1  可销售
 *   f_*           Odoo 式分面（同维度 OR、跨维度 AND，见 lib/facet-sql.ts）
 *   cf_<字段>     文本列筛选；cf_<日期字段>_from/_to  日期区间列筛选
 *   cfm_<字段>    多选列筛选（逗号分隔的精确值集合）
 *   stockAlert    negative | low  库存告警筛选
 */
import { prisma } from '@/lib/db'
import { buildFacetWhere } from '@/lib/facet-sql'
import { PRODUCT_TEMPLATE_FACET_DEFS } from '@/lib/facets/product-templates'

export const LOW_STOCK_THRESHOLD = 10

// Decimal/Int 字段做不了 Prisma 原生 contains 子串匹配，用两步查：
// 只拉 id+该字段这两列（比拉整行便宜得多），在内存里做子串匹配后收窄成 id 列表。
const NUMERIC_TEXT_FIELDS = new Set([
  'listPrice', 'standardPrice', 'weight', 'forecastQty', 'commissionPrice', 'sequence',
])

async function idsMatchingNumericSubstring(field: string, needle: string): Promise<string[]> {
  const rows = await prisma.productTemplate.findMany({
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

/** 库存告警角标计数。只有列表页需要，导出不必为此多跑一次全表聚合 */
export async function productStockAlertCounts(): Promise<{ negative: number; low: number }> {
  const [counts] = await prisma.$queryRawUnsafe<{ negative: number; low: number }[]>(
    `SELECT count(*) FILTER (WHERE s < 0)::int AS negative,
            count(*) FILTER (WHERE s >= 0 AND s < $1)::int AS low
     FROM (SELECT "templateId", sum("qtyOnHand") AS s FROM "Product" GROUP BY "templateId") t`,
    LOW_STOCK_THRESHOLD,
  )
  return { negative: counts?.negative ?? 0, low: counts?.low ?? 0 }
}

export async function buildProductTemplatesWhere(
  searchParams: URLSearchParams,
): Promise<Record<string, unknown>> {
  const search = searchParams.get('search') ?? ''
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
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { internalRef: { contains: search, mode: 'insensitive' } },
    ]
  }

  // ── 分面搜索(f_*)：同维度 OR、跨维度 AND，挂进 where.AND 以免与上面的 search OR 打架 ──
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
      if (from) range.gte = new Date(from + 'T00:00:00Z')
      if (to) range.lte = new Date(to + 'T23:59:59Z')
      where[field] = range
    }
  }

  // ── 库存告警(negative/low) ────────────────────────────────────────────
  // 在手库存是 Product 表按 templateId 聚合出来的，不是 ProductTemplate 上的列，
  // 所以只能先查出符合条件的 templateId 再收窄，没法写成 where 条件。
  const stockAlert = searchParams.get('stockAlert')
  if (stockAlert === 'negative' || stockAlert === 'low') {
    const cond = stockAlert === 'negative' ? 's < 0' : `s >= 0 AND s < $1`
    const rows = await prisma.$queryRawUnsafe<{ templateId: string }[]>(
      `SELECT "templateId" FROM (SELECT "templateId", sum("qtyOnHand") AS s FROM "Product" GROUP BY "templateId") t
       WHERE ${cond}`,
      ...(stockAlert === 'low' ? [LOW_STOCK_THRESHOLD] : []),
    )
    restrictToIds = intersect(restrictToIds, rows.map(r => r.templateId))
  }

  if (restrictToIds !== null) where.id = { in: [...restrictToIds] }

  return where
}

/** 列表与导出共用的排序：与列表页表格默认顺序一致 */
export const PRODUCT_TEMPLATE_ORDER_BY = [
  { status: 'asc' as const },
  { sequence: { sort: 'asc' as const, nulls: 'last' as const } },
  { createdAt: 'desc' as const },
]

/**
 * 给一批模板补上实时在手库存（Product 表按 templateId 聚合）。
 * 列表页与导出都要这一列，且都只对**本次要返回的那批** id 聚合，不做全表。
 */
export async function attachQtyOnHand(
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const ids = rows.map(r => r.id as string)
  const qtyRows = ids.length > 0
    ? await prisma.product.groupBy({ by: ['templateId'], where: { templateId: { in: ids } }, _sum: { qtyOnHand: true } })
    : []
  const qtyMap = new Map(qtyRows.map(r => [r.templateId, Number(r._sum.qtyOnHand ?? 0)]))
  for (const r of rows) r.qtyOnHand = qtyMap.get(r.id as string) ?? 0
  return rows
}
