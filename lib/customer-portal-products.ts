/**
 * 客户门户商品卡片构建 —— 从 GET /api/customer-portal/products 抽出来的共用逻辑
 * ================================================================================
 * 三处消费方共用同一套「商品 + 客户 => 客户专属价卡片」计算，避免各自维护一份
 * resolveCustomerPrice 拼装逻辑（历史上只有 /products 一处，价格公式改了容易漏改别处）：
 *   - GET /products（分页浏览）
 *   - GET /frequently-ordered（常购清单，需要卡片全量字段而不是只有 productId）
 *   - GET /products?ids=（"再来一单"用来核对历史订单里的商品现在还在不在、价格变没变）
 */
import type { PrismaClient, Prisma } from './generated/prisma/client'
import type { OdooPricelist as OdooPricelistType, Product as ProductType, Customer as CustomerType } from './types'
import { resolveCustomerPrice } from './pricing-engine'
import { queryLastSoldPrices } from './server-pricing'
import { toNum, toNumOpt } from './decimal-helpers'
import { lineDescription } from './order-line-description'
import { priceOf, type SaleUomRow, type SaleUomPriceMode } from './sale-uom'

/** 带其它可售单位（箱/包等）才需要查的那部分 include，单独抽出来给三处消费方共用 */
export const CUSTOMER_PRODUCT_SALE_UOM_INCLUDE = {
  where: { active: true },
  orderBy: { factor: 'desc' as const },
  select: {
    uomId: true,
    factor: true,
    isDefault: true,
    priceOverride: true,
    priceMode: true,
    priceDiscountPct: true,
    priceSurcharge: true,
    uom: { select: { name: true, nameZh: true } },
  },
} as const

export type ProductRowWithUom = Prisma.ProductGetPayload<{
  include: {
    uom: { select: { id: true; name: true } }
    saleUoms: typeof CUSTOMER_PRODUCT_SALE_UOM_INCLUDE
  }
}>

/** 20260926：客户门户"新品"角标阈值——超过这个天数不再算新品，可按需调整 */
const NEW_PRODUCT_DAYS = 30

export interface CustomerProductCard {
  id: string
  name: string
  spec: string | null
  images: string[]
  uomId: string | null
  uomName: string | null
  customerTaxRate: number
  customerPrice: number | null
  priceSource: string | null
  pricelistName: string | null
  isSpecialPrice: boolean
  lastPrice: number | null
  internalRef: string | null
  categoryId: string | null
  /** ACTIVE / INACTIVE 等，商品状态快照 —— "再来一单"要靠它判断商品是否还能买 */
  status: string
  /** qtyOnHand <= 0，门户只做提示不锁购物车（见 DEV-PLAN 风险点：开发库缺货占比 46.5%，锁死会挡掉近一半商品） */
  outOfStock: boolean
  /** createdAt 在 NEW_PRODUCT_DAYS 天内 */
  isNew: boolean
  /** 命中带 badgeLabel 的价格表规则时的角标文案，未命中为 null */
  promoLabel: string | null
  /** 命中促销规则时的折前基准价，配合 promoLabel 画划线原价；未命中为 null */
  originalPrice: number | null
  /** 20261026：商品配了多个可售单位（如 CASE + PACK）时才有值，门户用来渲染单位切换器；
   *  只有 1 个单位（含没配 ProductSaleUom、只按基准单位卖）时为 null，UI 不显示切换器，行为与改造前一致 */
  saleUoms: Array<{ uomId: string; uomName: string | null; isDefault: boolean; price: number }> | null
}

/**
 * 批量把 Product 行算成客户专属价卡片。products 需带 uom 关联（见 ProductRowWithUom）。
 */
export async function buildCustomerProductCards(
  prisma: PrismaClient,
  customer: CustomerType,
  products: ProductRowWithUom[],
): Promise<CustomerProductCard[]> {
  if (products.length === 0) return []

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

  const productIds = products.map((p) => p.id)
  const lastPrices = await queryLastSoldPrices(prisma, customer.id, productIds)

  return products.map((p) => {
    const productForEngine: ProductType = {
      id: p.id,
      name: p.name,
      variantAttributes: (p.variantAttributes as unknown as ProductType['variantAttributes']) ?? [],
      internalRef: p.internalRef ?? undefined,
      listPrice: toNum(p.listPrice ?? p.price ?? 0),
      standardPrice: toNum(p.standardPrice ?? 0),
      qtyOnHand: toNum(p.qtyOnHand),
      active: p.active,
      categoryId: p.categoryId ?? undefined,
      customerTaxRate: toNumOpt(p.customerTaxRate),
      commissionPrice: toNumOpt(p.commissionPrice),
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
    const resolution = resolveCustomerPrice(productForEngine, customer, allPricelists, 1, lastPrice)
    const isNew = Date.now() - p.createdAt.getTime() <= NEW_PRODUCT_DAYS * 24 * 60 * 60 * 1000
    const baseUomId = p.uom?.id ?? p.uomId ?? null

    // 商品配了 >1 个可售单位（如 CHICKEN FEET 的 CASE/PACK）才算一遍每个单位各自的客户价，
    // 镶边口径跟内部下单页 computeLinePrice 一致：命中单位限定价格表规则直接用那个价，
    // 否则按 ProductSaleUom.factor/priceMode 从基准单价换算（见 lib/sale-uom.ts priceOf）
    let saleUomCards: CustomerProductCard['saleUoms'] = null
    if (p.saleUoms.length > 1) {
      const rows: SaleUomRow[] = p.saleUoms.map((s) => ({
        uomId: s.uomId,
        isDefault: s.isDefault,
        factor: toNum(s.factor),
        priceOverride: toNumOpt(s.priceOverride) ?? null,
        priceMode: s.priceMode as SaleUomPriceMode,
        priceDiscountPct: toNumOpt(s.priceDiscountPct),
        priceSurcharge: toNumOpt(s.priceSurcharge),
      }))
      saleUomCards = p.saleUoms.map((s) => {
        if (s.uomId === baseUomId) {
          return { uomId: s.uomId, uomName: s.uom.name ?? s.uom.nameZh, isDefault: s.isDefault, price: resolution.price }
        }
        const unitResolution = resolveCustomerPrice(productForEngine, customer, allPricelists, 1, undefined, s.uomId)
        const price = unitResolution.matchedUomId ? unitResolution.price : priceOf(rows, s.uomId, unitResolution.price)
        return { uomId: s.uomId, uomName: s.uom.name ?? s.uom.nameZh, isDefault: s.isDefault, price }
      })
    }

    return {
      id: p.id,
      name: p.name,
      spec: lineDescription({ name: p.name, saleDescription: p.saleDescription, spec: p.spec }),
      images: p.images,
      uomId: baseUomId,
      uomName: p.uom?.name ?? null,
      customerTaxRate: toNumOpt(p.customerTaxRate) ?? 0,
      customerPrice: resolution.price,
      priceSource: resolution.itemDesc,
      pricelistName: resolution.pricelistName,
      isSpecialPrice: resolution.isSpecialPrice ?? false,
      lastPrice: lastPrice ?? null,
      internalRef: p.internalRef,
      categoryId: p.categoryId ?? null,
      status: p.status ?? 'ACTIVE',
      outOfStock: toNum(p.qtyOnHand) <= 0,
      isNew,
      promoLabel: resolution.promoLabel ?? null,
      originalPrice: resolution.originalPrice ?? null,
      saleUoms: saleUomCards,
    }
  })
}
