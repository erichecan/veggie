import { apiGet } from '@/lib/api'
import { resolveCustomerPrice } from '@/lib/pricing-engine'
import { priceOf, type SaleUomOption, type SaleUomRow } from '@/lib/sale-uom'
import type { Customer, CustomerPriceType, OdooPricelist } from '@/lib/types'

/**
 * 订单/报价单编辑页换客户（20260918）。
 *
 * 客户是订单的定价起点：价格表链、客户专属价、最近成交价、定价模式全挂在客户身上。
 * 所以换客户不能只换抬头 —— 已录入的行必须按新客户重新询价，否则新客户会拿到上一个
 * 客户的专属价/历史成交价，而界面上没有任何地方能看出来（这正是"只改名字"的危险之处）。
 *
 * 重算口径与两个编辑页的「切单位」「选品入行」逐字一致：
 *   客户专属价 → 价格表（含单位限定规则）→ 最近成交价 → 牌价
 * 最近成交价按「客户 + 商品 + 单位」三元组查，不跨单位借价（20260827/20260904 两次
 * 客户反馈的根因，见 lib/server-pricing.ts resolveOrderLines 同一套口径）。
 *
 * 前端算出来的价只是让操作员当场看见，保存时后端 resolveOrderLines 会按**新客户**
 * 再权威定价一遍（见 app/api/orders/[id]/route.ts），两边同源不会分叉。
 */

/** 重算只用到商品的这几个字段，两个编辑页各自的 AllProduct 都满足 */
export interface RepriceProduct {
  id: string
  listPrice?: number
}

export interface RepriceLine {
  id: string
  productId: string
  uomId?: string | null
  orderedQty: number | string
  isGift?: boolean | null
}

export interface RepricePatch {
  unitPrice: number
  subtotal: number
  priceSourceType: string
  priceSourceDetail: string | null
  priceSourceDate: string | null
  /** 换客户后赠品勾选前的价格快照同样过期，见 lib/order-line-gift.ts */
  preGiftPrice: null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 本单覆盖后的客户对象：编辑页可以临时换 pricelist/priceType 而不写回客户档案，
 * 询价必须用叠加后的这一份（两个编辑页的 effectiveCustomer 与 place-order 同一套）。
 */
export function overrideCustomerPricing(
  customer: Customer,
  priceType: string,
  pricelistId: string,
): Customer {
  return {
    ...customer,
    priceType: priceType as CustomerPriceType,
    pricelists: pricelistId ? [{ pricelistId, sequence: 1 }] : customer.pricelists,
  }
}

function toSaleUomRows(opts: SaleUomOption[]): SaleUomRow[] {
  return opts.map(o => ({
    uomId: o.uomId,
    isDefault: !!o.isDefault,
    factor: o.factor,
    priceOverride: o.priceOverride,
    priceMode: o.priceMode,
    priceDiscountPct: o.priceDiscountPct,
    priceSurcharge: o.priceSurcharge,
  }))
}

/**
 * 按新客户重算所有行的单价，返回 `行 id → 补丁`（没算出结果的行不出现在返回值里）。
 *
 * 赠品行不参与：它的单价按业务约定恒为 0（后端落库时也强制归零），重新询价会把它
 * 变回正价。手动改过价的行**照样重算** —— 那个价是跟上一个客户谈的，换了客户就不再成立。
 */
export async function repriceLinesForCustomer(params: {
  lines: RepriceLine[]
  /** 新客户 id，用于查最近成交价 */
  customerId: string
  /** 已经过 overrideCustomerPricing 叠加、且含 specialPrices 的完整客户对象 */
  effectiveCustomer: Customer
  priceType: string
  pricelists: OdooPricelist[]
  products: RepriceProduct[]
  saleUomOptions: Record<string, SaleUomOption[]>
}): Promise<Record<string, RepricePatch>> {
  const { lines, customerId, effectiveCustomer, priceType, pricelists, products, saleUomOptions } = params
  const targets = lines.filter(l => l.productId && !l.isGift)
  if (targets.length === 0) return {}

  // priceType='default' 从不查最近成交价（与定价引擎同一约定）
  const hits = await Promise.all(targets.map(async l => {
    if (priceType === 'default') return undefined
    const uomQs = l.uomId ? `&uomId=${encodeURIComponent(l.uomId)}` : ''
    try {
      const res = await apiGet<{ price: number | null; createdAt?: string }>(
        `/api/orders/last-price?customerId=${encodeURIComponent(customerId)}&productId=${encodeURIComponent(l.productId)}${uomQs}`,
      )
      return res.price != null && res.price > 0 ? { price: res.price, date: res.createdAt ?? '' } : undefined
    } catch {
      // 查不到不阻塞换客户：这一行退回价格表/牌价，不会拿别人的历史价顶替
      return undefined
    }
  }))

  const out: Record<string, RepricePatch> = {}
  targets.forEach((l, i) => {
    const p = products.find(pp => pp.id === l.productId)
    if (!p) return
    const hit = hits[i]
    const uomId = l.uomId ?? undefined
    const qty = Number(l.orderedQty) || 0
    const resolution = resolveCustomerPrice(
      p as never, effectiveCustomer, pricelists, qty || 1, hit?.price, uomId, hit !== undefined,
    )
    // 命中的是单位限定的价格表规则 → 这个价已经是本行单位的最终价，不能再乘 factor
    const matched = uomId && resolution.matchedUomId === uomId ? resolution : null
    const unitPrice = matched
      ? matched.price
      : priceOf(toSaleUomRows(saleUomOptions[l.productId] ?? []), uomId, resolution.price)
    out[l.id] = {
      unitPrice,
      subtotal: round2(qty * unitPrice),
      priceSourceType: resolution.sourceType.toUpperCase(),
      priceSourceDetail: resolution.sourceType === 'pricelist' ? resolution.pricelistName : null,
      priceSourceDate: resolution.sourceType === 'last' ? (hit?.date ?? null) : null,
      preGiftPrice: null,
    }
  })
  return out
}
