import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import {
  loadCustomerFromRestaurantId,
  queryLastSoldPrices,
} from '@/lib/server-pricing'
import { resolveCustomerPrice } from '@/lib/pricing-engine'
import { toNum, toNumOpt } from '@/lib/decimal-helpers'
import type { OdooPricelist as OdooPricelistType, Product as ProductType } from '@/lib/types'

/**
 * P1-2: 客户小程序 — 商品目录（含客户专属价格）
 *
 * GET /api/customer-portal/products
 *   - 需要 RESTAURANT 角色（客户登录后自动获得）
 *   - 根据 JWT 中 userId 解析出 Customer，计算每个商品的客户专属价格
 *   - 返回商品列表 + customerPrice + 价格来源
 */
export async function GET(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const customer = await loadCustomerFromRestaurantId(prisma, user.userId)
      if (!customer) {
        return NextResponse.json(
          { error: '未找到关联客户信息，请联系管理员' },
          { status: 403 },
        )
      }

      // 拉所有上架商品
      const products = await prisma.product.findMany({
        where: { status: 'ACTIVE' },
        orderBy: [{ sequence: 'asc' }, { createdAt: 'desc' }],
        include: {
          template: {
            select: {
              images: true,
              uomId: true,
              uom: { select: { id: true, name: true } },
              customerTaxRate: true,
              listPrice: true,
              standardPrice: true,
              type: true,
              categoryId: true,
              commissionPrice: true,
            },
          },
        },
      })

      // 拉所有 pricelist
      const pricelistsDb = await prisma.odooPricelist.findMany()
      const allPricelists: OdooPricelistType[] = pricelistsDb.map((p) => ({
        id: p.id,
        externalId: p.externalId ?? undefined,
        name: p.name,
        currency: p.currency,
        items: (p.items as unknown as OdooPricelistType['items']) ?? [],
        sequence: p.sequence,
        selectable: p.selectable,
        active: p.active,
        updatedAt: p.updatedAt.toISOString(),
      }))

      // 批量查询客户历史成交价
      const productIds = products.map((p) => p.id)
      const lastPrices = await queryLastSoldPrices(prisma, customer.id, productIds)

      // 逐商品计算客户专属价
      const result = products.map(({ template, ...p }) => {
        const productForEngine: ProductType = {
          id: p.id,
          templateId: p.templateId,
          name: p.name,
          variantAttributes: (p.variantAttributes as unknown as ProductType['variantAttributes']) ?? [],
          internalRef: p.internalRef ?? undefined,
          listPrice: toNum(p.listPrice ?? template?.listPrice ?? p.price ?? 0),
          standardPrice: toNum(p.standardPrice ?? template?.standardPrice ?? 0),
          qtyOnHand: toNum(p.qtyOnHand),
          active: p.active,
          categoryId: p.categoryId ?? template?.categoryId ?? undefined,
          customerTaxRate: toNumOpt(p.customerTaxRate ?? template?.customerTaxRate),
          commissionPrice: toNumOpt(p.commissionPrice ?? template?.commissionPrice),
          images: p.images,
          spec: p.spec ?? undefined,
          price: toNumOpt(p.price),
          stock: toNumOpt(p.qtyOnHand),
          status: (p.status?.toLowerCase() as ProductType['status']) ?? 'active',
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
          externalId: p.externalId ?? undefined,
          sequence: p.sequence ?? undefined,
        }

        const lastPrice = lastPrices[p.id]
        const resolution = resolveCustomerPrice(
          productForEngine,
          customer,
          allPricelists,
          1,
          lastPrice,
        )

        return {
          id: p.id,
          name: p.name,
          spec: p.spec,
          images: (p.images as string[]).length > 0
            ? p.images
            : (template?.images ?? []),
          uomId: template?.uom?.id ?? template?.uomId ?? null,
          uomName: template?.uom?.name ?? null,
          customerTaxRate: toNumOpt(p.customerTaxRate ?? template?.customerTaxRate) ?? 0,
          customerPrice: resolution.price,
          priceSource: resolution.itemDesc,
          pricelistName: resolution.pricelistName,
          isSpecialPrice: resolution.isSpecialPrice ?? false,
          lastPrice: lastPrice ?? null,
          internalRef: p.internalRef,
          categoryId: p.categoryId ?? template?.categoryId ?? null,
        }
      })

      return NextResponse.json(serializeApi({
        customerId: customer.id,
        customerName: customer.name,
        priceType: customer.priceType ?? 'multi',
        paymentTerm: customer.paymentTerm ?? 'cash',
        products: result,
      }))
    } catch (error) {
      console.error('[GET /api/customer-portal/products]', error)
      return NextResponse.json({ error: '获取商品目录失败' }, { status: 500 })
    }
  }, { require: 'portal.self.access' })
}
