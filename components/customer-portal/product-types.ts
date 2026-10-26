export interface Product {
  id: string
  name: string
  spec: string | null
  uomId?: string | null
  uomName: string | null
  customerPrice: number | null
  customerTaxRate?: number | null
  priceSource: string | null
  categoryId: string | null
  internalRef: string | null
  images: string[]
  status?: string
  outOfStock?: boolean
  isNew?: boolean
  promoLabel?: string | null
  originalPrice?: number | null
  /** 商品配了多个可售单位（如 CASE + PACK）才有值，驱动卡片上的单位切换器；只有 1 个单位为 null */
  saleUoms?: Array<{ uomId: string; uomName: string | null; isDefault: boolean; price: number }> | null
}

export interface FrequentCard extends Product {
  orderCount: number
  lastQuantity: number
}
