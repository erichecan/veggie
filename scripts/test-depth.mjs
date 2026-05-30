import { resolvePrice } from './lib/pricing-engine.ts'

const a = {
  id: 'a',
  name: 'A',
  currency: 'EUR',
  items: [{
    id: 'f',
    applyOn: 'global',
    minQty: 0,
    computeType: 'formula',
    formulaBase: 'pricelist',
    basedOnPricelistId: 'b',
    priceDiscount: 0,
    priceSurcharge: 0,
    sequence: 1,
  }],
  sequence: 1,
  selectable: true,
  active: true,
  updatedAt: '2026-01-01T00:00:00Z',
}

const b = {
  id: 'b',
  name: 'B',
  currency: 'EUR',
  items: [{
    id: 'f',
    applyOn: 'global',
    minQty: 0,
    computeType: 'formula',
    formulaBase: 'pricelist',
    basedOnPricelistId: 'a',
    priceDiscount: 0,
    priceSurcharge: 0,
    sequence: 1,
  }],
  sequence: 1,
  selectable: true,
  active: true,
  updatedAt: '2026-01-01T00:00:00Z',
}

const product = {
  id: 'var_carrot_10kg',
  templateId: 'tpl_carrot',
  name: 'Carrot 10kg BAG',
  variantAttributes: [],
  listPrice: 42,
  standardPrice: 5,
  qtyOnHand: 100,
  active: true,
  categoryId: 'cat_veg',
  customerTaxRate: 0.135,
  images: [],
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
}

const r = resolvePrice(product, a, [a, b], 1)
console.log('Result:', r)
console.log('Price:', r.price)
console.log('isFallback:', r.isFallback)
