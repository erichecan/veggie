import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { validateSaleUomItems, type SaleUomItemInput } from '@/lib/sale-uom'
import { buildFacetWhere } from '@/lib/facet-sql'
import { PRODUCT_TEMPLATE_FACET_DEFS } from '@/lib/facets/product-templates'

const LOW_STOCK_THRESHOLD = 10

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

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
    // Accept both ?pageSize=N (new) and ?limit=N (legacy); default 20
    const rawSize = searchParams.get('pageSize') ?? searchParams.get('limit') ?? '20'
    const limit = Math.min(200, Math.max(1, parseInt(rawSize, 10)))
    const search = searchParams.get('search') ?? ''
    const status = searchParams.get('status') ?? ''

    const where: Record<string, unknown> = {}
    if (status && status !== 'all') where.status = status.toUpperCase()
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
    // 角标计数在数据库里聚合成 2 个数字返回，不再把 5,479 行 groupBy 结果搬进 Node 再遍历
    // （20260802 实测：旧写法返回 5479 行是该页最慢的一条查询）。
    // 只有真正按告警筛选时，才额外查一次符合条件的 templateId 列表。
    const stockAlert = searchParams.get('stockAlert') // 'negative' | 'low'
    const [counts] = await prisma.$queryRawUnsafe<{ negative: number; low: number }[]>(
      `SELECT count(*) FILTER (WHERE s < 0)::int AS negative,
              count(*) FILTER (WHERE s >= 0 AND s < $1)::int AS low
       FROM (SELECT "templateId", sum("qtyOnHand") AS s FROM "Product" GROUP BY "templateId") t`,
      LOW_STOCK_THRESHOLD,
    )
    const alertCounts = { negative: counts?.negative ?? 0, low: counts?.low ?? 0 }

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

    const [total, templates] = await Promise.all([
      prisma.productTemplate.count({ where }),
      prisma.productTemplate.findMany({
        where,
        include: { uom: true },
        orderBy: [{ status: 'asc' }, { sequence: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ])

    // 当前页每个模板的实时在手库存(只查这一页涉及的 templateId，不用全表 variantMap)
    const pageIds = templates.map(t => t.id)
    const qtyRows = pageIds.length > 0
      ? await prisma.product.groupBy({ by: ['templateId'], where: { templateId: { in: pageIds } }, _sum: { qtyOnHand: true } })
      : []
    const qtyMap = new Map(qtyRows.map(r => [r.templateId, Number(r._sum.qtyOnHand ?? 0)]))

    const serialized = serializeApi(templates) as Array<Record<string, unknown>>
    for (const t of serialized) t.qtyOnHand = qtyMap.get(t.id as string) ?? 0

    return NextResponse.json({
      data: serialized, items: serialized, total, page, pageSize: limit, totalPages: Math.ceil(total / limit),
      alertCounts,
    })
  } catch (error) {
    console.error('[GET /api/product-templates]', error)
    return NextResponse.json({ error: '获取商品模板失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const { saleUoms: rawSaleUoms, ...data } = await req.json()

      const saleUoms: SaleUomItemInput[] = Array.isArray(rawSaleUoms) ? rawSaleUoms : []
      const saleUomsError = saleUoms.length > 0 ? validateSaleUomItems(saleUoms) : null
      if (saleUomsError) return NextResponse.json({ error: saleUomsError }, { status: 400 })

      // 系统约定商品必须挂模板（同 /api/products/bulk、/api/products/quick-create）：
      // 同一事务里把 ProductTemplate + 主变体 Product 一起建好，否则编辑页找不到
      // primaryProductId，"可售单位(大小单位)"区块永远不出现（20260728 排查确认）。
      // 新建时顺手带上的 saleUoms 也在这同一个事务里落库，不用等保存后跳到编辑页再配一次。
      const template = await prisma.$transaction(async tx => {
        const tpl = await tx.productTemplate.create({
          data: {
            ...data,
            type: data.type?.toUpperCase() ?? 'PRODUCT',
            status: data.status?.toUpperCase() ?? 'DRAFT',
            attributeLines: data.attributeLines ?? [],
            images: data.images ?? [],
          },
        })
        const product = await tx.product.create({
          data: {
            templateId: tpl.id,
            name: tpl.name,
            internalRef: data.internalRef,
            categoryId: data.categoryId,
            listPrice: data.listPrice,
            standardPrice: data.standardPrice,
            customerTaxRate: data.customerTaxRate,
            commissionPrice: data.commissionPrice,
            images: data.images ?? [],
            status: data.status?.toUpperCase() ?? 'DRAFT',
          },
        })
        if (saleUoms.length > 0) {
          await tx.productSaleUom.createMany({
            data: saleUoms.map(it => ({
              productId: product.id,
              uomId: String(it.uomId),
              isDefault: !!it.isDefault,
              priceOverride: it.priceOverride != null && it.priceOverride !== '' ? Number(it.priceOverride) : null,
              active: it.active !== false,
            })),
          })
        }
        return tpl
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'product-template', resourceId: template.id,
        detail: `创建商品模板: ${data.name || '未命名'}` })
      return NextResponse.json(serializeApi(template), { status: 201 })
    } catch (error) {
      console.error('[POST /api/product-templates]', error)
      return NextResponse.json({ error: '创建商品模板失败' }, { status: 500 })
    }
  }, { require: 'master.product_template.create' })
}
