export interface Product {
  id: string
  name: string
  spec: string | null
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
}

export interface FrequentCard extends Product {
  orderCount: number
  lastQuantity: number
}
