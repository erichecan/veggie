import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { buildProductTemplatesWhere, buildProductTemplatesOrderBy } from '@/lib/products-query'
import { priceOf, commissionPriceOf, type SaleUomRow } from '@/lib/sale-uom'
import { toNum, toNumOpt, round2 } from '@/lib/decimal-helpers'
import type { SaleUnitRow } from '@/lib/types'

/**
 * /api/products/by-sale-unit — "按可售单位查看商品"页专用（20260912）
 * ============================================================================
 * 商品列表(GET /api/products?page=...)一个商品一行，可售单位摘要塞进弹窗——
 * 客户反馈看不直观。这里反过来：一个可售单位一行，同一商品的多个单位就是连续几行，
 * 售价/成本价/提成价按该单位实际换算显示，不是原始 override/factor 这些内部字段。
 *
 * 分页按**商品**（与 /api/products 一致，筛选/排序复用同一份 lib/products-query.ts），
 * 每页展开出的行数会因为商品各自可售单位数量不同而浮动——这是预期行为，不是 bug。
 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
      const rawSize = searchParams.get('pageSize') ?? '25'
      const limit = Math.min(100, Math.max(1, parseInt(rawSize, 10)))
      const sortDir: 'asc' | 'desc' = searchParams.get('sortDir') === 'desc' ? 'desc' : 'asc'
      const orderBy = buildProductTemplatesOrderBy(searchParams.get('sortKey'), sortDir)
      const where = await buildProductTemplatesWhere(searchParams)

      const [total, products] = await Promise.all([
        prisma.product.count({ where }),
        prisma.product.findMany({
          where,
          select: {
            id: true, internalRef: true, name: true, saleDescription: true,
            listPrice: true, standardPrice: true, commissionPrice: true,
            customerTaxRate: true, vendorTaxRate: true, qtyOnHand: true,
            uom: { select: { name: true, nameZh: true } },
            category: { select: { name: true, nameZh: true } },
            saleUoms: {
              where: { active: true },
              orderBy: [{ isDefault: 'desc' }, { sequence: 'asc' }],
              select: {
                uomId: true, isDefault: true, factor: true,
                priceOverride: true, priceMode: true, priceDiscountPct: true, priceSurcharge: true,
                commissionPriceOverride: true, commissionPriceMode: true, commissionDiscountPct: true, commissionSurcharge: true,
                spec: true, sequence: true, grossWeight: true, updatedAt: true, updatedBy: true,
                uom: { select: { name: true, nameZh: true } },
              },
            },
          },
          orderBy,
          skip: (page - 1) * limit,
          take: limit,
        }),
      ])

      const rows: SaleUnitRow[] = products.flatMap((p): SaleUnitRow[] => {
        const basePrice = toNum(p.listPrice)
        const baseCost = toNumOpt(p.standardPrice) ?? 0
        const baseCommission = toNumOpt(p.commissionPrice) ?? null
        const category = p.category?.nameZh || p.category?.name || null

        if (p.saleUoms.length === 0) {
          // 没配过可售单位的商品（历史遗留/新建未配置）：仍要出现，退化成"只有基础单位"这一行，
          // 不可行内编辑（没有 ProductSaleUom 行可 PATCH）。
          return [{
            rowId: `${p.id}::__base`,
            productId: p.id, uomId: null,
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
            productId: p.id, uomId: u.uomId,
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
      })

      return NextResponse.json({
        data: rows, total, page, pageSize: limit, totalPages: Math.ceil(total / limit),
      })
    } catch (error) {
      console.error('[GET /api/products/by-sale-unit]', error)
      return NextResponse.json({ error: '获取商品可售单位列表失败' }, { status: 500 })
    }
  })
}
