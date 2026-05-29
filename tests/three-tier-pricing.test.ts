/**
 * 三级定价优先级 端到端验证
 * ============================================================================
 * 运行：npx tsx --test --test-reporter=spec tests/three-tier-pricing.test.ts
 *
 * 验证优先级：
 *   1. CustomerSpecialPrice（客户专属价）  — 最高
 *   2. PricelistItem（价格表项）           — 中
 *   3. Product.listPrice（商品基础价）     — 最低（兜底）
 *
 * 模拟场景：
 *   商品「胡萝卜 10kg」listPrice = €10
 *   价格表规则：固定价 €7.50
 *   客户专属价：€5.00
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolvePrice,
  resolveCustomerPrice,
  type PriceResolution,
} from '../lib/pricing-engine'
import type {
  Customer, OdooPricelist, OdooPricelistItem, Product, CustomerSpecialPrice,
} from '../lib/types'

// ─── 模拟数据工厂 ────────────────────────────────────────────────────────

const PRODUCT: Product = {
  id: 'var_carrot_10kg',
  templateId: 'tpl_carrot',
  name: '胡萝卜 10kg BAG',
  variantAttributes: [],
  listPrice: 10,       // ← 第三级：商品基础价
  standardPrice: 5,
  qtyOnHand: 200,
  active: true,
  categoryId: 'cat_veg',
  customerTaxRate: 0.135,
  images: [],
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
}

const PRICELIST_ITEM: OdooPricelistItem = {
  id: 'item_global_fixed',
  applyOn: 'global',
  minQty: 0,
  computeType: 'fixed',
  fixedPrice: 7.50,    // ← 第二级：价格表项
  sequence: 1,
}

const PRICELIST: OdooPricelist = {
  id: 'pl_takeaway',
  name: 'TAKEAWAY 菜价',
  currency: 'EUR',
  items: [PRICELIST_ITEM],
  sequence: 1,
  selectable: true,
  active: true,
  updatedAt: '2026-01-01T00:00:00Z',
}

const SPECIAL_PRICE: CustomerSpecialPrice = {
  id: 'sp_carrot_vip',
  productId: 'var_carrot_10kg',
  minQty: 0,
  fixedPrice: 5.00,    // ← 第一级：客户专属价
  note: 'VIP 老客户特价',
}

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cust_golden_dragon',
    name: '金龙餐馆',
    address: '123 Main St',
    phone: '0851234567',
    email: 'golden@example.com',
    vatNumber: 'IE1234567T',
    paymentTerm: 'monthly',
    createdAt: '2026-01-01T00:00:00Z',
    pricelistId: 'pl_takeaway',
    priceType: 'multi',
    ...overrides,
  }
}

// ─── 核心验证：三级优先级 ────────────────────────────────────────────────

describe('三级定价优先级验证', () => {
  describe('级别 3: 商品基础价（Product.listPrice）— 兜底', () => {
    test('无价格表、无专属价 → 返回 listPrice €10', () => {
      const cust = makeCustomer({ pricelistId: undefined, specialPrices: undefined })
      const r = resolveCustomerPrice(PRODUCT, cust, [], 1)
      assert.equal(r.price, 10, '应返回商品基础价 €10')
      assert.equal(r.isFallback, true, '应标记为 fallback')
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })

    test('有价格表但规则不匹配 → 回退 listPrice €10', () => {
      const plEmpty = { ...PRICELIST, items: [{
        ...PRICELIST_ITEM,
        applyOn: 'variant' as const,
        productVariantId: 'OTHER_PRODUCT',
      }]}
      const cust = makeCustomer({ specialPrices: undefined })
      const r = resolveCustomerPrice(PRODUCT, cust, [plEmpty], 1)
      assert.equal(r.price, 10, '规则不匹配应回退到 listPrice')
      assert.equal(r.isFallback, true)
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })

    test('priceType=default 时直接用 listPrice，忽略价格表', () => {
      const cust = makeCustomer({ priceType: 'default', specialPrices: undefined })
      const r = resolveCustomerPrice(PRODUCT, cust, [PRICELIST], 1)
      assert.equal(r.price, 10, 'priceType=default 应直接返回 listPrice')
      assert.equal(r.pricelistName, '直接牌价')
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })
  })

  describe('级别 2: 价格表项（PricelistItem）— 中间级', () => {
    test('有匹配的价格表规则、无专属价 → 返回 €7.50', () => {
      const cust = makeCustomer({ specialPrices: undefined })
      const r = resolveCustomerPrice(PRODUCT, cust, [PRICELIST], 1)
      assert.equal(r.price, 7.50, '应命中价格表固定价 €7.50')
      assert.equal(r.isFallback, false, '不应是 fallback')
      assert.notEqual(r.isSpecialPrice, true, '不应是专属价')
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })

    test('价格表百分比折扣：listPrice €10 打 8 折 → €8', () => {
      const plDiscount: OdooPricelist = {
        ...PRICELIST, id: 'pl_discount', name: '8 折价格表',
        items: [{
          id: 'item_20off', applyOn: 'global', minQty: 0,
          computeType: 'percentage', percentDiscount: 20, sequence: 1,
        }],
      }
      const cust = makeCustomer({ pricelistId: 'pl_discount', specialPrices: undefined })
      const r = resolveCustomerPrice(PRODUCT, cust, [plDiscount], 1)
      assert.equal(r.price, 8, '8 折后应为 €8')
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })

    test('价格表公式：基于成本 +€2 加成 → €7', () => {
      const plFormula: OdooPricelist = {
        ...PRICELIST, id: 'pl_formula', name: '成本加成表',
        items: [{
          id: 'item_cost_plus', applyOn: 'global', minQty: 0,
          computeType: 'formula', formulaBase: 'standard_price',
          priceDiscount: 0, priceSurcharge: 2, sequence: 1,
        }],
      }
      const cust = makeCustomer({ pricelistId: 'pl_formula', specialPrices: undefined })
      const r = resolveCustomerPrice(PRODUCT, cust, [plFormula], 1)
      assert.equal(r.price, 7, '成本€5 + 加成€2 = €7')
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })
  })

  describe('级别 1: 客户专属价（CustomerSpecialPrice）— 最高优先级', () => {
    test('有专属价 → 即使价格表更便宜也用专属价 €5', () => {
      const plCheaper: OdooPricelist = {
        ...PRICELIST,
        items: [{
          ...PRICELIST_ITEM, fixedPrice: 3,  // 价格表给 €3，比专属价更便宜
        }],
      }
      const cust = makeCustomer({ specialPrices: [SPECIAL_PRICE] })
      const r = resolveCustomerPrice(PRODUCT, cust, [plCheaper], 1)
      assert.equal(r.price, 5, '专属价 €5 应覆盖更便宜的价格表 €3')
      assert.equal(r.isSpecialPrice, true, '应标记为 isSpecialPrice')
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })

    test('专属价优先于 listPrice（即使 listPrice 更低）', () => {
      const expensiveProduct = { ...PRODUCT, listPrice: 3 }
      const cust = makeCustomer({ pricelistId: undefined, specialPrices: [SPECIAL_PRICE] })
      const r = resolveCustomerPrice(expensiveProduct, cust, [], 1)
      assert.equal(r.price, 5, '专属价 €5 覆盖 listPrice €3')
      assert.equal(r.isSpecialPrice, true)
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })

    test('专属价 + priceType=default → 专属价仍然优先', () => {
      const cust = makeCustomer({
        priceType: 'default',
        specialPrices: [SPECIAL_PRICE],
      })
      const r = resolveCustomerPrice(PRODUCT, cust, [PRICELIST], 1)
      assert.equal(r.price, 5, '即使 priceType=default，专属价仍优先')
      assert.equal(r.isSpecialPrice, true)
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })

    test('专属价 + priceType=last → 专属价仍然优先', () => {
      const cust = makeCustomer({
        priceType: 'last',
        specialPrices: [SPECIAL_PRICE],
      })
      const r = resolveCustomerPrice(PRODUCT, cust, [PRICELIST], 1, 2.0)
      assert.equal(r.price, 5, '即使 lastPrice=€2 更低，专属价仍优先')
      assert.equal(r.isSpecialPrice, true)
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })
  })

  describe('专属价条件过滤', () => {
    test('productId 不匹配 → 跳过专属价，降级到价格表', () => {
      const wrongSp: CustomerSpecialPrice = { ...SPECIAL_PRICE, productId: 'OTHER_PRODUCT' }
      const cust = makeCustomer({ specialPrices: [wrongSp] })
      const r = resolveCustomerPrice(PRODUCT, cust, [PRICELIST], 1)
      assert.equal(r.price, 7.50, '专属价不匹配应降级到价格表 €7.50')
      assert.notEqual(r.isSpecialPrice, true)
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })

    test('minQty 不满足 → 跳过专属价，降级到价格表', () => {
      const bigQtySp: CustomerSpecialPrice = { ...SPECIAL_PRICE, minQty: 100 }
      const cust = makeCustomer({ specialPrices: [bigQtySp] })
      const r = resolveCustomerPrice(PRODUCT, cust, [PRICELIST], 5)
      assert.equal(r.price, 7.50, 'qty=5 不满足 minQty=100')
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })

    test('dateStart/dateEnd 不在范围 → 跳过专属价', () => {
      const expiredSp: CustomerSpecialPrice = {
        ...SPECIAL_PRICE,
        dateStart: '2020-01-01',
        dateEnd: '2020-12-31',
      }
      const cust = makeCustomer({ specialPrices: [expiredSp] })
      const r = resolveCustomerPrice(PRODUCT, cust, [PRICELIST], 1)
      assert.equal(r.price, 7.50, '过期专属价应被跳过')
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })

    test('多个专属价时选 minQty 最高的匹配项', () => {
      const sp1: CustomerSpecialPrice = { ...SPECIAL_PRICE, minQty: 0, fixedPrice: 6 }
      const sp2: CustomerSpecialPrice = { ...SPECIAL_PRICE, id: 'sp2', minQty: 10, fixedPrice: 4.50 }
      const cust = makeCustomer({ specialPrices: [sp1, sp2] })
      // qty=20 满足两个专属价，应选 minQty=10 的 €4.50
      const r = resolveCustomerPrice(PRODUCT, cust, [PRICELIST], 20)
      assert.equal(r.price, 4.50, '应选 minQty 最高的匹配 €4.50')
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })
  })

  describe('resolvePrice 独立接口验证', () => {
    test('直接调用 resolvePrice 走价格表逻辑', () => {
      const r = resolvePrice(PRODUCT, PRICELIST, [PRICELIST], 1)
      assert.equal(r.price, 7.50)
      assert.equal(r.isFallback, false)
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })

    test('无匹配规则时 resolvePrice 回退 listPrice', () => {
      const emptyPl: OdooPricelist = { ...PRICELIST, items: [] }
      const r = resolvePrice(PRODUCT, emptyPl, [emptyPl], 1)
      assert.equal(r.price, 10)
      assert.equal(r.isFallback, true)
      console.log(`  ✓ 结果: €${r.price} | ${r.pricelistName} | ${r.itemDesc}`)
    })
  })

  describe('完整三级降级链路', () => {
    test('同一商品同一客户：专属价 > 价格表 > 牌价 逐级验证', () => {
      // 场景：三种不同配置的客户，同一商品，验证三级分别生效
      const product = PRODUCT  // listPrice = €10

      // 客户 A: 有专属价 + 有价格表 → 应命中专属价 €5
      const custA = makeCustomer({ specialPrices: [SPECIAL_PRICE] })
      const rA = resolveCustomerPrice(product, custA, [PRICELIST], 1)

      // 客户 B: 无专属价 + 有价格表 → 应命中价格表 €7.50
      const custB = makeCustomer({ specialPrices: undefined })
      const rB = resolveCustomerPrice(product, custB, [PRICELIST], 1)

      // 客户 C: 无专属价 + 无价格表 → 应回退牌价 €10
      const custC = makeCustomer({ pricelistId: undefined, specialPrices: undefined })
      const rC = resolveCustomerPrice(product, custC, [], 1)

      console.log('\n  ┌─────────────────────────────────────────────────────────┐')
      console.log('  │  三级定价优先级 — 同一商品（胡萝卜 10kg, listPrice=€10）  │')
      console.log('  ├───────────┬──────────┬──────────────────────────────────┤')
      console.log('  │ 客户配置   │ 最终价格  │ 命中规则                         │')
      console.log('  ├───────────┼──────────┼──────────────────────────────────┤')
      console.log(`  │ 专属+价表  │ €${rA.price.toFixed(2).padStart(5)}   │ ${rA.pricelistName.padEnd(18)} │`)
      console.log(`  │ 仅价格表   │ €${rB.price.toFixed(2).padStart(5)}   │ ${rB.pricelistName.padEnd(18)} │`)
      console.log(`  │ 均无       │ €${rC.price.toFixed(2).padStart(5)}   │ ${rC.pricelistName.padEnd(18)} │`)
      console.log('  └───────────┴──────────┴──────────────────────────────────┘')

      // 严格断言三级优先级
      assert.equal(rA.price, 5, '级别1: 专属价 €5')
      assert.equal(rA.isSpecialPrice, true)
      assert.equal(rB.price, 7.50, '级别2: 价格表 €7.50')
      assert.equal(rB.isFallback, false)
      assert.equal(rC.price, 10, '级别3: 牌价 €10')
      assert.equal(rC.isFallback, true)

      // 价格严格递增：专属价 < 价格表 < 牌价
      assert.ok(rA.price < rB.price, '专属价应 < 价格表价')
      assert.ok(rB.price < rC.price, '价格表价应 < 牌价')
    })
  })
})
