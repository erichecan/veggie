import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { buildProductTemplatesWhere, buildProductTemplatesOrderBy } from '@/lib/products-query'
import { priceOf, commissionPriceOf, type SaleUomRow, type SaleUomPriceMode } from '@/lib/sale-uom'
import { toNum, toNumOpt, round2 } from '@/lib/decimal-helpers'
import type { SaleUnitRow } from '@/lib/types'

/**
 * /api/products/by-sale-unit — "按可售单位查看商品"页专用（20260912）
 * ============================================================================
 * 商品列表(GET /api/products?page=...)一个商品一行，可售单位摘要塞进弹窗——
 * 客户反馈看不直观。这里反过来：一个可售单位一行，同一商品的多个单位就是连续几行，
 * 售价/成本价/提成价按该单位实际换算显示，不是原始 override/factor 这些内部字段。
 *
 * 分页按**商品**（与 /api/products 一致，筛选复用同一份 lib/products-query.ts），
 * 每页展开出的行数会因为商品各自可售单位数量不同而浮动——这是预期行为，不是 bug。
 *
 * 排序（20260912 新增）按"商品这个组"排，不是按展开后的每一行排——否则同一商品的
 * 几个单位会在排序后散开，前端就没法把它们连续画在一起、缩进表示从属关系了。
 * 组的排序键取该商品**默认/基础单位**那一行的值（没配过可售单位的商品就是它自己）。
 * Product 自身标量字段(internalRef/name/分类/税率/库存)能直接让数据库排序；
 * 售价/成本价/提成价是公式算出来的展示值，没法在 SQL 里排——这几个键退化成
 * "拉全量算出每个商品的排序值→内存排序→切页"，商品规模在小几千条量级，可接受。
 */

const DIRECT_SORT: Record<string, (dir: 'asc' | 'desc') => object> = {
  internalRef: (dir) => ({ internalRef: dir }),
  name: (dir) => ({ name: dir }),
  saleDescription: (dir) => ({ saleDescription: dir }),
  customerTaxRate: (dir) => ({ customerTaxRate: dir }),
  vendorTaxRate: (dir) => ({ vendorTaxRate: dir }),
  qtyOnHand: (dir) => ({ qtyOnHand: dir }),
  category: (dir) => ({ category: { name: dir } }),
}

/** 需要按"默认单位那一行的值"内存排序的键 —— 没有对应的 Product 标量字段，
 *  或者(如售价/成本价/提成价)是公式算出来的，没法交给数据库排序。 */
const DERIVED_SORT_KEYS = new Set([
  'spec', 'uomName', 'salePrice', 'costPrice', 'grossWeight', 'packSequence', 'commissionPrice', 'suUpdatedAt', 'updatedBy',
])

interface DefaultRowLite {
  uomId: string
  isDefault: boolean
  factor: unknown
  priceOverride: unknown
  priceMode: SaleUomPriceMode
  priceDiscountPct: unknown
  priceSurcharge: unknown
  commissionPriceOverride: unknown
  commissionPriceMode: SaleUomPriceMode
  commissionDiscountPct: unknown
  commissionSurcharge: unknown
  spec: string | null
  sequence: number | null
  grossWeight: unknown
  updatedAt: Date
  updatedBy: string | null
  uom: { name: string; nameZh: string | null }
}

function derivedSortValue(
  sortKey: string,
  p: { listPrice: unknown; standardPrice: unknown; commissionPrice: unknown; saleUoms: DefaultRowLite[] },
): string | number {
  const basePrice = toNum(p.listPrice)
  const baseCost = toNumOpt(p.standardPrice) ?? 0
  const baseCommission = toNumOpt(p.commissionPrice) ?? null
  const def = p.saleUoms[0]
  if (!def) {
    switch (sortKey) {
      case 'salePrice': return basePrice
      case 'costPrice': return baseCost
      case 'commissionPrice': return baseCommission ?? -Infinity
      case 'grossWeight': return -Infinity
      case 'packSequence': return Infinity
      case 'suUpdatedAt': return -Infinity
      default: return '' // spec/uomName/updatedBy
    }
  }
  const calc: SaleUomRow[] = [{
    uomId: def.uomId, isDefault: true, factor: toNum(def.factor),
    priceOverride: toNumOpt(def.priceOverride) ?? null, priceMode: def.priceMode,
    priceDiscountPct: toNumOpt(def.priceDiscountPct) ?? 0, priceSurcharge: toNumOpt(def.priceSurcharge) ?? 0,
    commissionPriceOverride: toNumOpt(def.commissionPriceOverride) ?? null, commissionPriceMode: def.commissionPriceMode,
    commissionDiscountPct: toNumOpt(def.commissionDiscountPct) ?? 0, commissionSurcharge: toNumOpt(def.commissionSurcharge) ?? 0,
  }]
  switch (sortKey) {
    case 'spec': return def.spec ?? ''
    case 'uomName': return def.uom.nameZh || def.uom.name || ''
    case 'salePrice': return priceOf(calc, def.uomId, basePrice)
    case 'costPrice': return round2(baseCost * (toNum(def.factor) || 1))
    case 'grossWeight': return toNumOpt(def.grossWeight) ?? -Infinity
    case 'packSequence': return def.sequence ?? Infinity
    case 'commissionPrice': return commissionPriceOf(calc, def.uomId, baseCommission) ?? -Infinity
    case 'suUpdatedAt': return def.updatedAt.getTime()
    case 'updatedBy': return def.updatedBy ?? ''
    default: return ''
  }
}

function compareValues(a: string | number, b: string | number, dir: 'asc' | 'desc'): number {
  const sign = dir === 'asc' ? 1 : -1
  if (typeof a === 'string' || typeof b === 'string') return String(a).localeCompare(String(b)) * sign
  return (a - b) * sign
}

/** 派生字段排序：拉全量（respect where）算出每个商品的排序值，返回排好序的 productId 列表。 */
async function sortedProductIdsByDerivedKey(
  where: Record<string, unknown>, sortKey: string, sortDir: 'asc' | 'desc',
): Promise<string[]> {
  const products = await prisma.product.findMany({
    where,
    select: {
      id: true, listPrice: true, standardPrice: true, commissionPrice: true,
      saleUoms: {
        where: { active: true },
        orderBy: [{ isDefault: 'desc' }, { sequence: 'asc' }],
        select: {
          uomId: true, isDefault: true, factor: true, priceOverride: true, priceMode: true, priceDiscountPct: true, priceSurcharge: true,
          commissionPriceOverride: true, commissionPriceMode: true, commissionDiscountPct: true, commissionSurcharge: true,
          spec: true, sequence: true, grossWeight: true, updatedAt: true, updatedBy: true,
          uom: { select: { name: true, nameZh: true } },
        },
      },
    },
  })
  return products
    .map(p => ({ id: p.id, v: derivedSortValue(sortKey, p) }))
    .sort((a, b) => compareValues(a.v, b.v, sortDir))
    .map(r => r.id)
}

const DETAIL_SELECT = {
  id: true, internalRef: true, name: true, saleDescription: true,
  listPrice: true, standardPrice: true, commissionPrice: true,
  customerTaxRate: true, vendorTaxRate: true, qtyOnHand: true,
  uom: { select: { name: true, nameZh: true } },
  category: { select: { name: true, nameZh: true } },
  saleUoms: {
    where: { active: true },
    orderBy: [{ isDefault: 'desc' as const }, { sequence: 'asc' as const }],
    select: {
      uomId: true, isDefault: true, factor: true,
      priceOverride: true, priceMode: true, priceDiscountPct: true, priceSurcharge: true,
      commissionPriceOverride: true, commissionPriceMode: true, commissionDiscountPct: true, commissionSurcharge: true,
      spec: true, sequence: true, grossWeight: true, updatedAt: true, updatedBy: true,
      uom: { select: { name: true, nameZh: true } },
    },
  },
}

function flattenProduct(p: {
  id: string; internalRef: string | null; name: string; saleDescription: string | null
  listPrice: unknown; standardPrice: unknown; commissionPrice: unknown
  customerTaxRate: unknown; vendorTaxRate: unknown; qtyOnHand: unknown
  uom: { name: string; nameZh: string | null } | null
  category: { name: string; nameZh: string | null } | null
  saleUoms: DefaultRowLite[]
}): SaleUnitRow[] {
  const basePrice = toNum(p.listPrice)
  const baseCost = toNumOpt(p.standardPrice) ?? 0
  const baseCommission = toNumOpt(p.commissionPrice) ?? null
  const category = p.category?.nameZh || p.category?.name || null

  if (p.saleUoms.length === 0) {
    // 没配过可售单位的商品（历史遗留/新建未配置）：仍要出现，退化成"只有基础单位"这一行，
    // 不可行内编辑（没有 ProductSaleUom 行可 PATCH）。
    return [{
      rowId: `${p.id}::__base`,
      productId: p.id, uomId: null, isDefault: true,
      internalRef: p.internalRef, name: p.name, saleDescription: p.saleDescription,
      spec: null,
      uomName: p.uom?.nameZh || p.uom?.name || null,
      salePrice: basePrice, customerTaxRate: toNumOpt(p.customerTaxRate) ?? null,
      costPrice: baseCost, vendorTaxRate: toNumOpt(p.vendorTaxRate) ?? null,
      grossWeight: null,
      qtyOnHand: toNum(p.qtyOnHand), qtyForecast: null,
      category, packSequence: null,
      commissionPrice: baseCommission,
      updatedAt: null, updatedBy: null,
    }]
  }

  const calcRows: SaleUomRow[] = p.saleUoms.map(u => ({
    uomId: u.uomId, isDefault: u.isDefault, factor: toNum(u.factor),
    priceOverride: toNumOpt(u.priceOverride) ?? null,
    priceMode: u.priceMode, priceDiscountPct: toNumOpt(u.priceDiscountPct) ?? 0, priceSurcharge: toNumOpt(u.priceSurcharge) ?? 0,
    commissionPriceOverride: toNumOpt(u.commissionPriceOverride) ?? null,
    commissionPriceMode: u.commissionPriceMode, commissionDiscountPct: toNumOpt(u.commissionDiscountPct) ?? 0, commissionSurcharge: toNumOpt(u.commissionSurcharge) ?? 0,
  }))

  return p.saleUoms.map(u => {
    const factor = toNum(u.factor) || 1
    return {
      rowId: `${p.id}::${u.uomId}`,
      productId: p.id, uomId: u.uomId, isDefault: u.isDefault,
      internalRef: u.isDefault ? p.internalRef : null,
      name: p.name, saleDescription: p.saleDescription,
      spec: u.spec,
      uomName: u.uom.nameZh || u.uom.name,
      salePrice: priceOf(calcRows, u.uomId, basePrice),
      customerTaxRate: toNumOpt(p.customerTaxRate) ?? null,
      costPrice: round2(baseCost * factor),
      vendorTaxRate: toNumOpt(p.vendorTaxRate) ?? null,
      grossWeight: toNumOpt(u.grossWeight) ?? null,
      // 库存不按单位拆分，只在默认/基础单位那一行显示一次，其余单位行留空——
      // 避免同一份库存数量按各单位 factor 各换算一遍显得像"每个单位库存都不一样"
      qtyOnHand: u.isDefault ? toNum(p.qtyOnHand) : null,
      qtyForecast: null, // 前端调 /api/products/forecast 补实时值，与商品列表页同一套口径
      category,
      packSequence: u.sequence,
      commissionPrice: commissionPriceOf(calcRows, u.uomId, baseCommission),
      updatedAt: u.updatedAt.toISOString(),
      updatedBy: u.updatedBy,
    }
  })
}

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
      const rawSize = searchParams.get('pageSize') ?? '25'
      const limit = Math.min(100, Math.max(1, parseInt(rawSize, 10)))
      const sortDir: 'asc' | 'desc' = searchParams.get('sortDir') === 'desc' ? 'desc' : 'asc'
      const sortKey = searchParams.get('sortKey')
      const where = await buildProductTemplatesWhere(searchParams)

      let products: Awaited<ReturnType<typeof prisma.product.findMany<{ select: typeof DETAIL_SELECT }>>>
      let total: number

      if (sortKey && DERIVED_SORT_KEYS.has(sortKey)) {
        const allIds = await sortedProductIdsByDerivedKey(where, sortKey, sortDir)
        total = allIds.length
        const pageIds = allIds.slice((page - 1) * limit, (page - 1) * limit + limit)
        const found = await prisma.product.findMany({ where: { id: { in: pageIds } }, select: DETAIL_SELECT })
        const byId = new Map(found.map(p => [p.id, p]))
        products = pageIds.map(id => byId.get(id)).filter((p): p is NonNullable<typeof p> => p != null)
      } else {
        const orderBy = sortKey && DIRECT_SORT[sortKey]
          ? [DIRECT_SORT[sortKey](sortDir)]
          : buildProductTemplatesOrderBy(sortKey, sortDir)
        const [cnt, found] = await Promise.all([
          prisma.product.count({ where }),
          prisma.product.findMany({ where, select: DETAIL_SELECT, orderBy, skip: (page - 1) * limit, take: limit }),
        ])
        total = cnt
        products = found
      }

      const rows: SaleUnitRow[] = products.flatMap(flattenProduct)

      return NextResponse.json({
        data: rows, total, page, pageSize: limit, totalPages: Math.ceil(total / limit),
      })
    } catch (error) {
      console.error('[GET /api/products/by-sale-unit]', error)
      return NextResponse.json({ error: '获取商品可售单位列表失败' }, { status: 500 })
    }
  })
}
