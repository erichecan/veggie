import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePrice, resolveCustomerPrice } from '../lib/pricing-engine'
import type { Product, OdooPricelist, OdooPricelistItem, Customer } from '../lib/types'

/**
 * 价格表按可售单位差异化定价（DEV-PLAN 模块 C，决策 #4/#5/#6）。
 *
 * - #4：uomId 限定只对 applyOn ∈ {product, variant} 有意义（category/global 传了也不影响匹配，
 *   因为 category/global 条目本来就不会去比较 productTemplateId/productVariantId）
 * - #5：不限定单位的规则（无 uomId）对该商品所有可售单位都生效，包括从未传 uomId 的旧调用
 * - #6：命中单位限定规则后，返回的 price 就是最终价，不应再被调用方乘以 factor
 *   （由 matchedUomId 回填告诉调用方"这个已经是最终价"）
 */

const uomProduct: Product = {
  id: 'p-uom', templateId: 't-uom', name: 'UoM Scope Test Product',
  listPrice: 100, standardPrice: 50, price: 100,
  variantAttributes: [], qtyOnHand: 0, active: true, images: [], createdAt: '', updatedAt: '',
} as unknown as Product

/** 带真实 factor 的商品：uom-case 是基准单位（factor 1），uom-pack 是 1/4 箱（factor 0.25） */
const uomScaledProduct: Product = {
  id: 'p-uom-scaled', templateId: 't-uom-scaled', name: 'UoM Scaled Test Product',
  listPrice: 100, standardPrice: 50, price: 100,
  saleUoms: [
    { uomId: 'uom-case', isDefault: true, factor: 1, active: true, sequence: 1, spec: null, uom: { name: 'Case' } },
    { uomId: 'uom-pack', isDefault: false, factor: 0.25, active: true, sequence: 2, spec: null, uom: { name: 'Pack' } },
  ],
  variantAttributes: [], qtyOnHand: 0, active: true, images: [], createdAt: '', updatedAt: '',
} as unknown as Product

function pl(id: string, items: OdooPricelistItem[]): OdooPricelist {
  return { id, name: id, currency: 'EUR', sequence: 1, selectable: true, active: true, updatedAt: '', items } as unknown as OdooPricelist
}

function item(overrides: Partial<OdooPricelistItem>): OdooPricelistItem {
  return { id: `item-${Math.random()}`, applyOn: 'global', minQty: 0, computeType: 'fixed', sequence: 10, ...overrides } as OdooPricelistItem
}

function customer(overrides: Partial<Customer>): Customer {
  return {
    id: 'c1', name: 'Test', address: '', phone: '', email: '', vatNumber: '',
    paymentTerm: 'monthly', createdAt: '', specialPrices: [], priceType: 'multi', ...overrides,
  } as Customer
}

test('不传 uomId（未改造的旧调用点）：单位限定规则一律不命中，回退到不限定规则', () => {
  const p = pl('pl-1', [
    item({ sequence: 1, applyOn: 'variant', productVariantId: 'p-uom', uomId: 'uom-case', fixedPrice: 999 }),
    item({ sequence: 2, applyOn: 'variant', productVariantId: 'p-uom', fixedPrice: 42 }),
  ])
  const r = resolvePrice(uomProduct, p, [p])
  assert.equal(r.price, 42, '没传 uomId 时必须表现得跟改造前逐字一致')
  assert.equal(r.matchedUomId, undefined)
})

test('传入 uomId 且与限定规则匹配 → 命中单位限定规则，price 就是最终价', () => {
  const p = pl('pl-2', [
    item({ sequence: 1, applyOn: 'variant', productVariantId: 'p-uom', uomId: 'uom-case', computeType: 'fixed', fixedPrice: 55 }),
    item({ sequence: 2, applyOn: 'variant', productVariantId: 'p-uom', fixedPrice: 42 }),
  ])
  const r = resolvePrice(uomProduct, p, [p], 1, undefined, 'uom-case')
  assert.equal(r.price, 55)
  assert.equal(r.matchedUomId, 'uom-case', '调用方据此知道不该再乘 factor')
})

test('传入 uomId 但请求的单位与限定规则不同 → 跳过该条，落到不限定规则（决策 #5：不限定=对所有单位生效的兜底）', () => {
  const p = pl('pl-3', [
    item({ sequence: 1, applyOn: 'variant', productVariantId: 'p-uom', uomId: 'uom-case', fixedPrice: 55 }),
    item({ sequence: 2, applyOn: 'variant', productVariantId: 'p-uom', fixedPrice: 42 }),
  ])
  const r = resolvePrice(uomProduct, p, [p], 1, undefined, 'uom-pkt')
  assert.equal(r.price, 42, 'uom-pkt 没有专门的限定规则，应该落到不限定规则')
  assert.equal(r.matchedUomId, undefined)
})

test('sequence 决定优先级：不限定规则排在限定规则前面 → 不限定规则先命中，单位限定规则被跳过', () => {
  const p = pl('pl-4', [
    item({ sequence: 1, applyOn: 'variant', productVariantId: 'p-uom', fixedPrice: 42 }),
    item({ sequence: 2, applyOn: 'variant', productVariantId: 'p-uom', uomId: 'uom-case', fixedPrice: 55 }),
  ])
  const r = resolvePrice(uomProduct, p, [p], 1, undefined, 'uom-case')
  assert.equal(r.price, 42, '决策#5：不发明"更具体优先"——sequence 排在前面的先命中')
  assert.equal(r.matchedUomId, undefined)
})

test('只有单位限定规则、没有兜底规则，且请求单位不匹配 → 整条不命中，回退牌价', () => {
  const p = pl('pl-5', [
    item({ sequence: 1, applyOn: 'variant', productVariantId: 'p-uom', uomId: 'uom-case', fixedPrice: 55 }),
  ])
  const r = resolvePrice(uomProduct, p, [p], 1, undefined, 'uom-pkt')
  assert.equal(r.isFallback, true)
  assert.equal(r.price, 100, '回退到 listPrice 牌价')
})

test('resolveCustomerPrice 透传 uomId：客户走价格表链，单位限定规则也能命中', () => {
  const p = pl('pl-6', [
    item({ sequence: 1, applyOn: 'variant', productVariantId: 'p-uom', uomId: 'uom-case', computeType: 'fixed', fixedPrice: 70 }),
    item({ sequence: 2, applyOn: 'variant', productVariantId: 'p-uom', fixedPrice: 42 }),
  ])
  const c = customer({ pricelists: [{ pricelistId: 'pl-6', sequence: 1 }] } as unknown as Partial<Customer>)
  const r = resolveCustomerPrice(uomProduct, c, [p], 1, undefined, 'uom-case')
  assert.equal(r.price, 70)
  assert.equal(r.matchedUomId, 'uom-case')
})

test('formula 计算方式也能被单位限定：折扣基于牌价，命中后同样标记 matchedUomId', () => {
  const p = pl('pl-7', [
    item({
      sequence: 1, applyOn: 'variant', productVariantId: 'p-uom', uomId: 'uom-case',
      computeType: 'formula', formulaBase: 'list_price', priceDiscount: 10, priceSurcharge: 0,
    }),
  ])
  const r = resolvePrice(uomProduct, p, [p], 1, undefined, 'uom-case')
  assert.equal(r.price, 90, 'listPrice 100 打九折')
  assert.equal(r.matchedUomId, 'uom-case')
})

test('20261025修复：formula 命中的 uomId 对应的 factor != 1 时，基准价要先按 factor 换算，不能直接拿商品基准单位的价算', () => {
  const p = pl('pl-8', [
    item({
      sequence: 1, applyOn: 'variant', productVariantId: 'p-uom-scaled', uomId: 'uom-pack',
      computeType: 'formula', formulaBase: 'list_price', priceDiscount: 0, priceSurcharge: 10,
    }),
  ])
  const r = resolvePrice(uomScaledProduct, p, [p], 1, undefined, 'uom-pack')
  // 整箱 listPrice 100，uom-pack factor 0.25 → 单包基准价 25，+10 加价 = 35
  // 改之前的 bug：直接拿整箱 100 + 10 = 110
  assert.equal(r.price, 35, 'PACK 基准价应该是 100*0.25=25，不是整箱 100')
  assert.equal(r.matchedUomId, 'uom-pack')
})

test('20261025修复：percentage 命中的 uomId 对应的 factor != 1 时，折扣基准价也要先按 factor 换算', () => {
  const p = pl('pl-9', [
    item({
      sequence: 1, applyOn: 'variant', productVariantId: 'p-uom-scaled', uomId: 'uom-pack',
      computeType: 'percentage', percentDiscount: 10,
    }),
  ])
  const r = resolvePrice(uomScaledProduct, p, [p], 1, undefined, 'uom-pack')
  // 单包基准价 25，打九折 = 22.5；改之前的 bug：拿整箱 100 打九折 = 90
  assert.equal(r.price, 22.5, 'PACK 基准价应该是 100*0.25=25 打九折，不是整箱 100 打九折')
  assert.equal(r.matchedUomId, 'uom-pack')
})

test('20261025修复：formulaBase=pricelist 嵌套命中同一个 uomId 时已经是最终价，不能再乘一次 factor', () => {
  const base = pl('pl-10-base', [
    item({
      sequence: 1, applyOn: 'variant', productVariantId: 'p-uom-scaled', uomId: 'uom-pack',
      computeType: 'formula', formulaBase: 'list_price', priceDiscount: 0, priceSurcharge: 0,
    }),
  ])
  const outer = pl('pl-10-outer', [
    item({
      sequence: 1, applyOn: 'variant', productVariantId: 'p-uom-scaled', uomId: 'uom-pack',
      computeType: 'formula', formulaBase: 'pricelist', basedOnPricelistId: 'pl-10-base',
      priceDiscount: 0, priceSurcharge: 0,
    }),
  ])
  const r = resolvePrice(uomScaledProduct, outer, [base, outer], 1, undefined, 'uom-pack')
  // base 已经算出 PACK 最终价 25（100*0.25），outer 不该再乘一次 factor 变成 6.25
  assert.equal(r.price, 25, '嵌套命中同一 uomId 后已是最终价，不能二次换算')
})
