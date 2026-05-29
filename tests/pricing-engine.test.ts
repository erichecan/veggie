/**
 * 定价引擎单元测试（node:test 原生）
 * ============================================================================
 * 运行方式（不需要额外依赖）：
 *    npx tsx --test tests/pricing-engine.test.ts
 *    npx tsx --test --test-reporter=spec tests/pricing-engine.test.ts
 *
 * 覆盖：
 *   1. Fix Price 规则
 *   2. Percentage 折扣
 *   3. Formula: base=list_price 带 discount + surcharge
 *   4. Formula: base=standard_price（成本加成）
 *   5. Formula: base=pricelist（嵌套价格表，防循环深度 5）
 *   6. ApplyOn 优先级：variant > product > category > global
 *   7. Min Qty 条件过滤
 *   8. Date range 过滤
 *   9. Customer priceType: default / last / multi 分派
 *  10. CustomerSpecialPrice 优先于 pricelist 规则
 *  11. Margin 上下限（Min / Max Margin）
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolvePrice,
  resolveCustomerPrice,
} from '../lib/pricing-engine'
import type {
  Customer, OdooPricelist, OdooPricelistItem, Product,
} from '../lib/types'

// ─── Fixtures ────────────────────────────────────────────────────────────
function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'var_carrot_10kg',
    templateId: 'tpl_carrot',
    name: 'Carrot 10kg BAG',
    variantAttributes: [],
    listPrice: 10,
    standardPrice: 5,
    qtyOnHand: 100,
    active: true,
    categoryId: 'cat_veg',
    customerTaxRate: 0.135,
    images: [],
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makePricelist(items: OdooPricelistItem[], overrides: Partial<OdooPricelist> = {}): OdooPricelist {
  return {
    id: 'pl_main',
    name: 'TAKEAWAY 菜价',
    currency: 'EUR',
    items,
    sequence: 1,
    selectable: true,
    active: true,
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cust_1',
    name: 'TAKEAWAY 1',
    address: '',
    phone: '',
    email: '',
    vatNumber: '',
    paymentTerm: 'monthly',
    createdAt: '2026-01-01T00:00:00Z',
    pricelistId: 'pl_main',
    priceType: 'multi',
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('resolvePrice: 基础命中', () => {
  test('Fix Price 规则直接返回 fixedPrice', () => {
    const pl = makePricelist([
      { id: '1', applyOn: 'global', minQty: 0, computeType: 'fixed', fixedPrice: 7.5, sequence: 1 },
    ])
    const r = resolvePrice(makeProduct(), pl, [pl], 1)
    assert.equal(r.price, 7.5)
    assert.equal(r.isFallback, false)
  })

  test('Percentage 折扣 = listPrice × (1 - percent/100)', () => {
    const pl = makePricelist([
      { id: '1', applyOn: 'global', minQty: 0, computeType: 'percentage', percentDiscount: 10, sequence: 1 },
    ])
    const r = resolvePrice(makeProduct({ listPrice: 100 }), pl, [pl], 1)
    assert.equal(r.price, 90)
  })

  test('未命中任何规则 → 回退 listPrice', () => {
    const pl = makePricelist([
      { id: '1', applyOn: 'product', productTemplateId: 'OTHER', minQty: 0, computeType: 'fixed', fixedPrice: 99, sequence: 1 },
    ])
    const r = resolvePrice(makeProduct(), pl, [pl], 1)
    assert.equal(r.price, 10)
    assert.equal(r.isFallback, true)
  })
})

describe('resolvePrice: Formula', () => {
  test('Formula + base=list_price + discount + surcharge', () => {
    const pl = makePricelist([{
      id: '1', applyOn: 'global', minQty: 0, computeType: 'formula',
      formulaBase: 'list_price', priceDiscount: 10, priceSurcharge: 2, sequence: 1,
    }])
    // 100 × (1 - 0.10) + 2 = 92
    const r = resolvePrice(makeProduct({ listPrice: 100 }), pl, [pl], 1)
    assert.equal(r.price, 92)
  })

  test('Formula + base=standard_price（成本加成）', () => {
    const pl = makePricelist([{
      id: '1', applyOn: 'global', minQty: 0, computeType: 'formula',
      formulaBase: 'standard_price', priceDiscount: 0, priceSurcharge: 3, sequence: 1,
    }])
    // standardPrice=5, +3 = 8
    const r = resolvePrice(makeProduct(), pl, [pl], 1)
    assert.equal(r.price, 8)
  })

  test('Formula + Min/Max Margin 保护', () => {
    const pl = makePricelist([{
      id: '1', applyOn: 'global', minQty: 0, computeType: 'formula',
      formulaBase: 'list_price', priceDiscount: 80, priceSurcharge: 0,
      priceMinMargin: 3,  // cost=5, 所以价格至少 5+3=8
      sequence: 1,
    }])
    // base: 10×0.2=2, 但 minMargin 拉到 8
    const r = resolvePrice(makeProduct(), pl, [pl], 1)
    assert.equal(r.price, 8)
  })

  test('Formula + base=pricelist（嵌套）', () => {
    const plBase = makePricelist([
      { id: '1', applyOn: 'global', minQty: 0, computeType: 'fixed', fixedPrice: 20, sequence: 1 },
    ], { id: 'pl_base', name: 'TAKEAWAY' })
    const plTop = makePricelist([{
      id: '1', applyOn: 'global', minQty: 0, computeType: 'formula',
      formulaBase: 'pricelist', basedOnPricelistId: 'pl_base',
      priceDiscount: 10, priceSurcharge: 0, sequence: 1,
    }], { id: 'pl_top', name: 'TAKEAWAY-2' })
    const r = resolvePrice(makeProduct(), plTop, [plTop, plBase], 1)
    assert.equal(r.price, 18) // 20 × 0.9
  })
})

describe('resolvePrice: ApplyOn 优先级 + 条件过滤', () => {
  test('Variant 优先于 Product', () => {
    // 这里 sequence 决定命中顺序：sequence 小的优先。测 sequence=1 的 variant 优先。
    const p = makeProduct({ id: 'var_A', templateId: 'tpl_A', categoryId: 'cat_X' })
    const pl = makePricelist([
      { id: 'v', applyOn: 'variant', productVariantId: 'var_A', minQty: 0, computeType: 'fixed', fixedPrice: 1, sequence: 1 },
      { id: 'p', applyOn: 'product', productTemplateId: 'tpl_A', minQty: 0, computeType: 'fixed', fixedPrice: 2, sequence: 5 },
      { id: 'c', applyOn: 'category', categoryId: 'cat_X', minQty: 0, computeType: 'fixed', fixedPrice: 3, sequence: 10 },
      { id: 'g', applyOn: 'global', minQty: 0, computeType: 'fixed', fixedPrice: 4, sequence: 20 },
    ])
    const r = resolvePrice(p, pl, [pl], 1)
    assert.equal(r.price, 1)
  })

  test('Min Qty 不满足则跳过该条规则', () => {
    const pl = makePricelist([
      { id: 'big', applyOn: 'global', minQty: 100, computeType: 'fixed', fixedPrice: 5, sequence: 1 },
      { id: 'small', applyOn: 'global', minQty: 0, computeType: 'fixed', fixedPrice: 10, sequence: 2 },
    ])
    // qty=10 < 100 所以跳过 big，落到 small
    const r = resolvePrice(makeProduct(), pl, [pl], 10)
    assert.equal(r.price, 10)
  })

  test('date_start/date_end 过滤', () => {
    const pl = makePricelist([
      { id: 'promo', applyOn: 'global', minQty: 0, computeType: 'fixed', fixedPrice: 1, sequence: 1,
        dateStart: '2020-01-01', dateEnd: '2020-12-31' },
      { id: 'normal', applyOn: 'global', minQty: 0, computeType: 'fixed', fixedPrice: 5, sequence: 2 },
    ])
    const r = resolvePrice(makeProduct(), pl, [pl], 1, '2026-04-19')
    assert.equal(r.price, 5)
  })
})

describe('resolveCustomerPrice: priceType 分派', () => {
  const pl = makePricelist([
    { id: 'g', applyOn: 'global', minQty: 0, computeType: 'fixed', fixedPrice: 8, sequence: 1 },
  ])

  test('multi → 走 pricelist', () => {
    const r = resolveCustomerPrice(makeProduct(), makeCustomer({ priceType: 'multi' }), [pl], 1)
    assert.equal(r.price, 8)
  })

  test('default → 直接用 listPrice，忽略 pricelist', () => {
    const r = resolveCustomerPrice(
      makeProduct({ listPrice: 10 }),
      makeCustomer({ priceType: 'default' }),
      [pl], 1,
    )
    assert.equal(r.price, 10)
    assert.equal(r.pricelistName, '直接牌价')
  })

  test('last → 传入 lastPrice 就用它', () => {
    const r = resolveCustomerPrice(
      makeProduct({ listPrice: 10 }),
      makeCustomer({ priceType: 'last' }),
      [pl], 1, 7.25,
    )
    assert.equal(r.price, 7.25)
    assert.equal(r.pricelistName, '最近成交价')
  })

  test('last → 未传 lastPrice 回退 listPrice', () => {
    const r = resolveCustomerPrice(
      makeProduct({ listPrice: 12 }),
      makeCustomer({ priceType: 'last' }),
      [pl], 1,
    )
    assert.equal(r.price, 12)
    assert.ok(r.isFallback)
  })
})

describe('resolveCustomerPrice: 客户专属特殊价', () => {
  test('specialPrices 最高优先级，即使 pricelist 规则更便宜也用 special', () => {
    const pl = makePricelist([
      { id: 'g', applyOn: 'global', minQty: 0, computeType: 'fixed', fixedPrice: 3, sequence: 1 },
    ])
    const cust = makeCustomer({
      priceType: 'multi',
      specialPrices: [{ id: 'sp1', productId: 'var_carrot_10kg', minQty: 0, fixedPrice: 9.99 }],
    })
    const r = resolveCustomerPrice(makeProduct(), cust, [pl], 1)
    assert.equal(r.price, 9.99)
    assert.equal(r.isSpecialPrice, true)
  })

  test('specialPrices 未匹配 productId 时不触发', () => {
    const pl = makePricelist([
      { id: 'g', applyOn: 'global', minQty: 0, computeType: 'fixed', fixedPrice: 3, sequence: 1 },
    ])
    const cust = makeCustomer({
      priceType: 'multi',
      specialPrices: [{ id: 'sp1', productId: 'OTHER_PRODUCT', minQty: 0, fixedPrice: 9.99 }],
    })
    const r = resolveCustomerPrice(makeProduct(), cust, [pl], 1)
    assert.equal(r.price, 3)
    assert.notEqual(r.isSpecialPrice, true)
  })

  test('specialPrices minQty 过滤：qty=2 但 minQty=10 → 不匹配', () => {
    const pl = makePricelist([
      { id: 'g', applyOn: 'global', minQty: 0, computeType: 'fixed', fixedPrice: 3, sequence: 1 },
    ])
    const cust = makeCustomer({
      priceType: 'multi',
      specialPrices: [{ id: 'sp1', productId: 'var_carrot_10kg', minQty: 10, fixedPrice: 9.99 }],
    })
    const r = resolveCustomerPrice(makeProduct(), cust, [pl], 2)
    assert.equal(r.price, 3)
  })
})

describe('resolvePrice: 嵌套循环保护', () => {
  test('嵌套深度超 5 → 回退到 listPrice', () => {
    const a = makePricelist([{
      id: 'f', applyOn: 'global', minQty: 0, computeType: 'formula',
      formulaBase: 'pricelist', basedOnPricelistId: 'b',
      priceDiscount: 0, priceSurcharge: 0, sequence: 1,
    }], { id: 'a', name: 'A' })
    const b = makePricelist([{
      id: 'f', applyOn: 'global', minQty: 0, computeType: 'formula',
      formulaBase: 'pricelist', basedOnPricelistId: 'a',  // 循环！
      priceDiscount: 0, priceSurcharge: 0, sequence: 1,
    }], { id: 'b', name: 'B' })
    const r = resolvePrice(makeProduct({ listPrice: 42 }), a, [a, b], 1)
    // 循环最终超过深度，回退 listPrice
    assert.equal(r.price, 42)
    assert.equal(r.isFallback, true)
  })
})
