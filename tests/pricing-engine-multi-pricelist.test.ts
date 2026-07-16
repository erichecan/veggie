import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCustomerPrice } from '../lib/pricing-engine'
import type { Product, OdooPricelist, Customer } from '../lib/types'

const product: Product = {
  id: 'prod-1',
  templateId: 'tmpl-1',
  name: 'Test Tomato',
  listPrice: 10,
  standardPrice: 6,
  price: 10,
  variantAttributes: [],
  qtyOnHand: 0,
  active: true,
  images: [],
  createdAt: '',
  updatedAt: '',
} as unknown as Product

function pricelist(id: string, fixedPrice: number): OdooPricelist {
  return {
    id,
    name: id,
    currency: 'EUR',
    sequence: 1,
    selectable: true,
    active: true,
    updatedAt: '',
    items: [
      { applyOn: 'product', productTemplateId: 'tmpl-1', computeType: 'fixed', fixedPrice, minQty: 0, sequence: 1 },
    ],
  } as unknown as OdooPricelist
}

const plA = pricelist('pl-A', 7)   // 第一优先级：命中价 7
const plB = pricelist('pl-B', 5)   // 第二优先级：命中价 5（不该被用到，因为 A 已命中）
const plC_noMatch: OdooPricelist = {
  id: 'pl-C', name: 'pl-C', currency: 'EUR', sequence: 1, selectable: true, active: true, updatedAt: '',
  items: [], // 空规则，必定 fallback
} as unknown as OdooPricelist

function customer(overrides: Partial<Customer>): Customer {
  return { id: 'c1', name: 'Test', address: '', phone: '', email: '', vatNumber: '',
    paymentTerm: 'monthly', createdAt: '', specialPrices: [], ...overrides } as Customer
}

test('multi：客户挂 2 张表，第一张命中 → 用第一张的价，不查第二张', () => {
  const c = customer({ priceType: 'multi', pricelists: [{ pricelistId: 'pl-A', sequence: 1 }, { pricelistId: 'pl-B', sequence: 2 }] })
  const r = resolveCustomerPrice(product, c, [plA, plB], 1, 8)
  assert.equal(r.price, 7, '应该用价格表 A 的固定价 7，而不是 B 的 5 或 lastPrice 8')
  assert.equal(r.isFallback, false)
})

test('multi：客户挂 2 张表，第一张未命中(空规则)、第二张命中 → 用第二张', () => {
  const c = customer({ priceType: 'multi', pricelists: [{ pricelistId: 'pl-C', sequence: 1 }, { pricelistId: 'pl-B', sequence: 2 }] })
  const r = resolveCustomerPrice(product, c, [plC_noMatch, plB], 1, 8)
  assert.equal(r.price, 5, '第一张空规则未命中，应该继续查第二张，命中 5')
})

test('multi：两张表都未命中 → 查 last price', () => {
  const c = customer({ priceType: 'multi', pricelists: [{ pricelistId: 'pl-C', sequence: 1 }] })
  const r = resolveCustomerPrice(product, c, [plC_noMatch], 1, 8)
  assert.equal(r.price, 8, '价格表链全部未命中，应该回退 lastPrice 8')
  assert.equal(r.isFallback, false)
})

test('multi：两张表都未命中、无 lastPrice → 回退牌价', () => {
  const c = customer({ priceType: 'multi', pricelists: [{ pricelistId: 'pl-C', sequence: 1 }] })
  const r = resolveCustomerPrice(product, c, [plC_noMatch], 1, undefined)
  assert.equal(r.price, 10, '应该回退牌价 listPrice=10')
  assert.equal(r.isFallback, true)
})

test('default：价格表命中 → 用价格表价（不再是"忽略价格表"）', () => {
  const c = customer({ priceType: 'default', pricelists: [{ pricelistId: 'pl-A', sequence: 1 }] })
  const r = resolveCustomerPrice(product, c, [plA], 1, 8)
  assert.equal(r.price, 7, 'default 模式现在应该先查价格表，命中 7')
  assert.equal(r.isFallback, false)
})

test('default：价格表未命中 → 回退牌价，不查 lastPrice（这是 default 和 multi 的核心区别）', () => {
  const c = customer({ priceType: 'default', pricelists: [{ pricelistId: 'pl-C', sequence: 1 }] })
  const r = resolveCustomerPrice(product, c, [plC_noMatch], 1, 8)
  assert.equal(r.price, 10, 'default 未命中价格表时应直接回退牌价 10，不该用 lastPrice 8')
  assert.equal(r.isFallback, true)
})

test('default：客户没挂任何价格表 → 直接回退牌价', () => {
  const c = customer({ priceType: 'default', pricelists: [] })
  const r = resolveCustomerPrice(product, c, [], 1, 8)
  assert.equal(r.price, 10)
  assert.equal(r.isFallback, true)
})

test('last：即使挂了价格表也完全不查，直接用 lastPrice（行为不变）', () => {
  const c = customer({ priceType: 'last', pricelists: [{ pricelistId: 'pl-A', sequence: 1 }] })
  const r = resolveCustomerPrice(product, c, [plA], 1, 9)
  assert.equal(r.price, 9)
})

test('客户专属特殊价格：优先级高于价格表链（行为不变）', () => {
  const c = customer({
    priceType: 'multi',
    pricelists: [{ pricelistId: 'pl-A', sequence: 1 }],
    specialPrices: [{ id: 'sp1', productId: 'prod-1', minQty: 0, fixedPrice: 3.5 }],
  })
  const r = resolveCustomerPrice(product, c, [plA], 1, 8)
  assert.equal(r.price, 3.5, '专属特殊价应该覆盖价格表链和 lastPrice')
  assert.equal(r.isSpecialPrice, true)
})
