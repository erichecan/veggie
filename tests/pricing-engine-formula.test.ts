import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePrice } from '../lib/pricing-engine'
import type { Product, OdooPricelist, OdooPricelistItem } from '../lib/types'

// ─── 测试商品 ────────────────────────────────────────────────────────────────
// 覆盖不同定价场景，命名直接说明它是为哪个特性设计的

const formulaProduct: Product = {
  id: 'p-formula', templateId: 't-formula', name: 'Formula Test Product',
  listPrice: 100, standardPrice: 60, commissionPrice: 40, price: 100,
  variantAttributes: [], qtyOnHand: 0, active: true, images: [], createdAt: '', updatedAt: '',
} as unknown as Product

const noCostProduct: Product = {
  id: 'p-nocost', templateId: 't-nocost', name: 'No Cost Snapshot Product',
  listPrice: 30, standardPrice: undefined, commissionPrice: undefined, price: 30,
  variantAttributes: [], qtyOnHand: 0, active: true, images: [], createdAt: '', updatedAt: '',
} as unknown as Product

const commissionFallbackProduct: Product = {
  id: 'p-commission', templateId: 't-commission', name: 'Commission Fallback Product',
  listPrice: 30, standardPrice: undefined, commissionPrice: 22, price: 30,
  variantAttributes: [], qtyOnHand: 0, active: true, images: [], createdAt: '', updatedAt: '',
} as unknown as Product

// 复刻真实客户订单里的大米商品：listPrice=25.50，standardPrice=18.03
const riceProduct: Product = {
  id: 'p-rice', templateId: 't-rice', name: 'Nested Pricelist Product (Rice)',
  listPrice: 25.5, standardPrice: 18.03, price: 25.5,
  variantAttributes: [], qtyOnHand: 0, active: true, images: [], createdAt: '', updatedAt: '',
} as unknown as Product

const marginProduct: Product = {
  id: 'p-margin', templateId: 't-margin', name: 'Margin Cap Product',
  listPrice: 50, standardPrice: 30, price: 50,
  variantAttributes: [], qtyOnHand: 0, active: true, images: [], createdAt: '', updatedAt: '',
} as unknown as Product

const tierProduct: Product = {
  id: 'p-tier', templateId: 't-tier', name: 'Qty Tier Product',
  listPrice: 20, standardPrice: 10, price: 20,
  variantAttributes: [], qtyOnHand: 0, active: true, images: [], createdAt: '', updatedAt: '',
} as unknown as Product

const seasonalProduct: Product = {
  id: 'p-season', templateId: 't-season', name: 'Seasonal Product',
  listPrice: 15, standardPrice: 8, price: 15,
  variantAttributes: [], qtyOnHand: 0, active: true, images: [], createdAt: '', updatedAt: '',
} as unknown as Product

const categoryProduct: Product = {
  id: 'p-cat', templateId: 't-cat', name: 'Category Product',
  listPrice: 40, standardPrice: 25, price: 40, categoryId: 'cat-fruit',
  variantAttributes: [], qtyOnHand: 0, active: true, images: [], createdAt: '', updatedAt: '',
} as unknown as Product

function pl(id: string, items: OdooPricelistItem[]): OdooPricelist {
  return { id, name: id, currency: 'EUR', sequence: 1, selectable: true, active: true, updatedAt: '', items } as unknown as OdooPricelist
}

function item(overrides: Partial<OdooPricelistItem>): OdooPricelistItem {
  return { id: `item-${Math.random()}`, applyOn: 'global', minQty: 0, computeType: 'formula', sequence: 10, ...overrides } as OdooPricelistItem
}

// ─── computeType: fixed / percentage ───────────────────────────────────────

test('fixed：固定价，忽略基准价', () => {
  const p = pl('pl-fixed', [item({ computeType: 'fixed', fixedPrice: 42 })])
  const r = resolvePrice(formulaProduct, p, [p])
  assert.equal(r.price, 42)
  assert.equal(r.isFallback, false)
})

test('percentage：按牌价打折', () => {
  const p = pl('pl-pct', [item({ computeType: 'percentage', percentDiscount: 20 })])
  const r = resolvePrice(formulaProduct, p, [p])
  assert.equal(r.price, 80, '牌价 100 打 8 折 = 80')
})

// ─── formula: list_price / standard_price ──────────────────────────────────

test('formula + list_price：牌价基础上折扣再加价', () => {
  const p = pl('pl-list', [item({ formulaBase: 'list_price', priceDiscount: 10, priceSurcharge: 5 })])
  const r = resolvePrice(formulaProduct, p, [p])
  assert.equal(r.price, 95, '(100 * 0.9) + 5 = 95')
})

test('formula + standard_price：以成本价为基础', () => {
  const p = pl('pl-cost', [item({ formulaBase: 'standard_price', priceSurcharge: 10 })])
  const r = resolvePrice(formulaProduct, p, [p])
  assert.equal(r.price, 70, '成本 60 + 10 = 70')
})

test('formula + standard_price：商品无 standardPrice 时回退 commissionPrice', () => {
  const p = pl('pl-cost2', [item({ formulaBase: 'standard_price', priceSurcharge: 3 })])
  const r = resolvePrice(commissionFallbackProduct, p, [p])
  assert.equal(r.price, 25, 'standardPrice 缺失，回退 commissionPrice 22 + 3 = 25')
})

test('formula + standard_price：成本与提成价都缺失时回退牌价', () => {
  const p = pl('pl-cost3', [item({ formulaBase: 'standard_price', priceSurcharge: 3 })])
  const r = resolvePrice(noCostProduct, p, [p])
  assert.equal(r.price, 33, 'standardPrice/commissionPrice 都缺失，回退牌价 30 + 3 = 33')
})

// ─── formula: pricelist（嵌套价格表）── Bug 1 回归测试 ──────────────────────
// 修复前：case 'pricelist' 算完 formulaBase 后没有 break，会掉进 default 被
// 覆盖成 basePrice，导致嵌套价格表形同虚设。这组测试专门验证嵌套结果真的生效。

test('formula + pricelist：嵌套价格表算出的价必须生效（Bug 1 回归）', () => {
  const nested = pl('pl-nested', [
    item({ applyOn: 'variant', productVariantId: 'p-rice', formulaBase: 'list_price', priceSurcharge: 6 }),
  ])
  const outer = pl('pl-outer', [
    item({ applyOn: 'global', formulaBase: 'pricelist', basedOnPricelistId: 'pl-nested' }),
  ])
  const r = resolvePrice(riceProduct, outer, [outer, nested])
  assert.equal(r.price, 31.5, '嵌套表算出 25.50+6=31.50，外层应直接采用，而不是被 basePrice(25.50) 覆盖')
})

test('formula + pricelist：复刻真实客户报单场景（CITY CENTREtest → M7N3M1test）', () => {
  const nested = pl('pl-m7n3m1test', [
    item({ applyOn: 'variant', productVariantId: 'p-rice', formulaBase: 'list_price', priceSurcharge: 6, minQty: 1 }),
  ])
  const outer = pl('pl-city-centre-test', [
    item({
      applyOn: 'global', formulaBase: 'pricelist', basedOnPricelistId: 'pl-m7n3m1test',
      // 生产库这条数据当时被 priceMinMargin/priceMaxMargin=0 覆盖，Bug 2 已修复为 undefined
      priceMinMargin: undefined, priceMaxMargin: undefined,
    }),
  ])
  const r = resolvePrice(riceProduct, outer, [outer, nested])
  assert.equal(r.price, 31.5, '客户预期结果：不应再等于成本价 18.03')
})

test('formula + pricelist：多层嵌套（3 层）价格正确复合', () => {
  const level3 = pl('pl-l3', [item({ formulaBase: 'list_price', priceSurcharge: 1 })])       // 100 + 1 = 101
  const level2 = pl('pl-l2', [item({ formulaBase: 'pricelist', basedOnPricelistId: 'pl-l3', priceDiscount: 10 })]) // 101 * 0.9 = 90.9
  const level1 = pl('pl-l1', [item({ formulaBase: 'pricelist', basedOnPricelistId: 'pl-l2', priceSurcharge: 2 })]) // 90.9 + 2 = 92.9
  const r = resolvePrice(formulaProduct, level1, [level1, level2, level3])
  assert.equal(r.price, 92.9)
})

test('formula + pricelist：嵌套表未命中(fallback) → 外层该条目跳过，继续找下一条', () => {
  const nestedNoMatch = pl('pl-nested-empty', [])  // 空规则，必定 fallback
  const outer = pl('pl-outer2', [
    item({ applyOn: 'global', sequence: 5, formulaBase: 'pricelist', basedOnPricelistId: 'pl-nested-empty' }),
    item({ applyOn: 'global', sequence: 10, computeType: 'fixed', fixedPrice: 77 }),
  ])
  const r = resolvePrice(formulaProduct, outer, [outer, nestedNoMatch])
  assert.equal(r.price, 77, '第一条引用的嵌套表未命中，应跳过，改用第二条固定价规则')
})

test('formula + pricelist：循环引用不会死循环，超过递归深度后安全回退', () => {
  const circA = pl('pl-circ-a', [item({ formulaBase: 'pricelist', basedOnPricelistId: 'pl-circ-b' })])
  const circB = pl('pl-circ-b', [item({ formulaBase: 'pricelist', basedOnPricelistId: 'pl-circ-a' })])
  const r = resolvePrice(formulaProduct, circA, [circA, circB])
  assert.equal(r.isFallback, true, '循环引用最终应触发深度保护并回退牌价，而不是栈溢出')
  assert.equal(r.price, 100)
})

// ─── priceMinMargin / priceMaxMargin ── Bug 2 相关 ──────────────────────────

test('priceMaxMargin：显式设置时应封顶价格', () => {
  const p = pl('pl-maxmargin', [item({ formulaBase: 'list_price', priceMaxMargin: 5 })])
  const r = resolvePrice(marginProduct, p, [p])
  assert.equal(r.price, 35, '牌价 50 本应直接采用，但 priceMaxMargin=5 把价格封顶在 成本30+5=35')
})

test('priceMinMargin：显式设置时应兜底价格下限', () => {
  const p = pl('pl-minmargin', [item({ formulaBase: 'list_price', priceDiscount: 90, priceMinMargin: 8 })])
  const r = resolvePrice(marginProduct, p, [p])
  assert.equal(r.price, 38, '牌价打1折后仅5，被 priceMinMargin=8 兜到 成本30+8=38')
})

test('priceMinMargin=0：显式设为0是合法用法（不低于成本价出售），必须仍然生效', () => {
  const p = pl('pl-minmargin0', [item({ formulaBase: 'list_price', priceDiscount: 95, priceMinMargin: 0 })])
  const r = resolvePrice(marginProduct, p, [p])
  assert.equal(r.price, 30, '牌价打05折后仅2.5，minMargin=0 应兜底到成本价30，且0要被当成真实值而非"未设置"')
})

test('priceMaxMargin/priceMinMargin 均未设置（undefined）：不做任何封顶或兜底（Bug 2 回归）', () => {
  const p = pl('pl-nomargin', [item({ formulaBase: 'list_price' })])
  const r = resolvePrice(marginProduct, p, [p])
  assert.equal(r.price, 50, '未配置 margin 限制时应直接用牌价 50，不能被误当成 0 而封顶到成本价')
})

// ─── minQty 分层 ─────────────────────────────────────────────────────────────

test('minQty：按购买数量匹配不同档位', () => {
  const p = pl('pl-tier', [
    item({ applyOn: 'global', sequence: 10, minQty: 10, computeType: 'fixed', fixedPrice: 15 }),
    item({ applyOn: 'global', sequence: 20, minQty: 5, computeType: 'fixed', fixedPrice: 17 }),
    item({ applyOn: 'global', sequence: 30, minQty: 0, computeType: 'fixed', fixedPrice: 20 }),
  ])
  assert.equal(resolvePrice(tierProduct, p, [p], 1).price, 20, 'qty=1 只够最低档')
  assert.equal(resolvePrice(tierProduct, p, [p], 5).price, 17, 'qty=5 够第二档')
  assert.equal(resolvePrice(tierProduct, p, [p], 10).price, 15, 'qty=10 够最高档')
  assert.equal(resolvePrice(tierProduct, p, [p], 4).price, 20, 'qty=4 不够 minQty=5，退回最低档')
})

// ─── dateStart / dateEnd ─────────────────────────────────────────────────────

test('dateStart/dateEnd：促销价只在有效期内生效', () => {
  const p = pl('pl-season', [
    item({ applyOn: 'global', sequence: 10, computeType: 'fixed', fixedPrice: 5, dateStart: '2026-07-01', dateEnd: '2026-07-31' }),
    item({ applyOn: 'global', sequence: 20, computeType: 'fixed', fixedPrice: 15 }),
  ])
  assert.equal(resolvePrice(seasonalProduct, p, [p], 1, '2026-07-15').price, 5, '在促销期内命中促销价')
  assert.equal(resolvePrice(seasonalProduct, p, [p], 1, '2026-08-01').price, 15, '促销结束后回退常规价')
  assert.equal(resolvePrice(seasonalProduct, p, [p], 1, '2026-06-30').price, 15, '促销开始前回退常规价')
})

// ─── sequence 排序 / applyOn 匹配 ────────────────────────────────────────────

test('sequence：数字小的优先，即使后面还有更"具体"的规则也不会被覆盖', () => {
  const p = pl('pl-seq', [
    item({ applyOn: 'global', sequence: 1, computeType: 'fixed', fixedPrice: 9 }),
    item({ applyOn: 'variant', productVariantId: 'p-formula', sequence: 2, computeType: 'fixed', fixedPrice: 88 }),
  ])
  const r = resolvePrice(formulaProduct, p, [p])
  assert.equal(r.price, 9, '优先级完全由 sequence 决定，不是按 applyOn 类型自动分层')
})

test('applyOn=variant：只匹配指定的具体变体，不匹配其他商品', () => {
  const p = pl('pl-variant', [item({ applyOn: 'variant', productVariantId: 'p-formula', computeType: 'fixed', fixedPrice: 11 })])
  assert.equal(resolvePrice(formulaProduct, p, [p]).price, 11)
  assert.equal(resolvePrice(marginProduct, p, [p]).isFallback, true, '不是该变体，应该 fallback')
})

test('applyOn=product：按 productTemplateId 匹配整个模板下的所有变体', () => {
  const p = pl('pl-product', [item({ applyOn: 'product', productTemplateId: 't-formula', computeType: 'fixed', fixedPrice: 13 })])
  assert.equal(resolvePrice(formulaProduct, p, [p]).price, 13)
})

test('applyOn=category：按商品分类匹配', () => {
  const p = pl('pl-cat', [item({ applyOn: 'category', categoryId: 'cat-fruit', computeType: 'fixed', fixedPrice: 22 })])
  assert.equal(resolvePrice(categoryProduct, p, [p]).price, 22)
  assert.equal(resolvePrice(formulaProduct, p, [p]).isFallback, true, '不属于该分类应该 fallback')
})

test('applyOn=global：无条件匹配所有商品', () => {
  const p = pl('pl-global', [item({ applyOn: 'global', computeType: 'fixed', fixedPrice: 6 })])
  assert.equal(resolvePrice(formulaProduct, p, [p]).price, 6)
  assert.equal(resolvePrice(marginProduct, p, [p]).price, 6)
})

// ─── 完全未命中 ──────────────────────────────────────────────────────────────

test('未匹配任何规则：回退到 listPrice 牌价', () => {
  const p = pl('pl-empty', [])
  const r = resolvePrice(formulaProduct, p, [p])
  assert.equal(r.price, 100)
  assert.equal(r.isFallback, true)
})
