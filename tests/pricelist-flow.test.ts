/**
 * Pricelist 主流程端到端验证（不依赖 DB，mock Prisma）
 * ============================================================================
 * 覆盖用户描述的完整闭环：
 *
 *   1. 运营新建 pricelist（Global 规则 + 部分商品的特殊价）
 *   2. 挂载到新餐馆
 *   3. 下单时自动按 pricelist 算单价（前端传错价 → 服务端重写）
 *   4. 查看/搜索/过滤 items
 *
 * 这组测试验证 Sprint 1/2 的"定价引擎 → 订单"这条最关键的链路仍然完整。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePrice, resolveCustomerPrice } from '../lib/pricing-engine'
import { resolveOrderLines } from '../lib/server-pricing'
import type { Customer, OdooPricelist, Product } from '../lib/types'

// ─── 场景数据：新建餐馆的标准 pricelist ─────────────────────────────────
const PRODUCTS: Product[] = [
  {
    id: 'p_carrot', templateId: 't_carrot', name: 'Carrot 10kg BAG',
    variantAttributes: [], listPrice: 10, standardPrice: 5, qtyOnHand: 100,
    active: true, categoryId: 'cat_veg', images: [], status: 'active',
    createdAt: '2026-01-01',
  },
  {
    id: 'p_onion', templateId: 't_onion', name: 'Onion 19.1kg BAG',
    variantAttributes: [], listPrice: 20, standardPrice: 12, qtyOnHand: 50,
    active: true, categoryId: 'cat_veg', images: [], status: 'active',
    createdAt: '2026-01-01',
  },
  {
    id: 'p_chilli', templateId: 't_chilli', name: 'Chilli Red KG',
    variantAttributes: [], listPrice: 8, standardPrice: 5, qtyOnHand: 200,
    active: true, categoryId: 'cat_veg', images: [], status: 'active',
    createdAt: '2026-01-01',
  },
]

// Scenario: "新餐馆价格表" 的典型配置
//   - Global 规则：Formula 基于 Public Price，-5%（所有商品都打 9.5 折）
//   - 特殊商品 1：Carrot 固定价 €7（胡萝卜是该餐厅主打菜，另谈了价）
//   - 特殊商品 2：Chilli 固定价 €6.5（同上）
//
// 这对应"全部商品的价格公式 + 部分商品的特殊价"的业务语义
const NEW_RESTAURANT_PRICELIST: OdooPricelist = {
  id: 'pl_new_restaurant',
  name: 'NEW RESTAURANT 菜价',
  currency: 'EUR',
  items: [
    // 全局 -5% 折扣
    {
      id: 'r_global', applyOn: 'global', minQty: 0, computeType: 'formula',
      formulaBase: 'list_price', priceDiscount: 5, priceSurcharge: 0,
      sequence: 100,
    },
    // 特殊：Carrot 固定价 €7
    {
      id: 'r_carrot', applyOn: 'variant', productVariantId: 'p_carrot',
      minQty: 0, computeType: 'fixed', fixedPrice: 7,
      sequence: 10,  // 数字小 = 优先
    },
    // 特殊：Chilli 固定价 €6.5
    {
      id: 'r_chilli', applyOn: 'variant', productVariantId: 'p_chilli',
      minQty: 0, computeType: 'fixed', fixedPrice: 6.5,
      sequence: 11,
    },
  ],
  sequence: 1,
  selectable: true,
  active: true,
  updatedAt: '2026-01-01',
}

const NEW_RESTAURANT: Customer = {
  id: 'cust_new_rest',
  name: 'NEW RESTAURANT',
  address: '1 Test St',
  phone: '',
  email: '',
  vatNumber: '',
  paymentTerm: 'monthly',
  createdAt: '2026-01-01',
  pricelistId: 'pl_new_restaurant',
  priceType: 'multi',
}

// ─── 第一组：定价引擎行为正确 ────────────────────────────────────────────

describe('运营流程：新餐馆 pricelist 定价', () => {
  test('特殊商品 Carrot 命中 variant 固定价 €7（而不是全局 -5%=€9.5）', () => {
    const r = resolveCustomerPrice(PRODUCTS[0], NEW_RESTAURANT, [NEW_RESTAURANT_PRICELIST], 1)
    assert.equal(r.price, 7)
    assert.ok(r.itemDesc.includes('固定价'))
  })

  test('未设特殊价的商品 Onion 走全局 -5% → €20 × 0.95 = €19', () => {
    const r = resolveCustomerPrice(PRODUCTS[1], NEW_RESTAURANT, [NEW_RESTAURANT_PRICELIST], 1)
    assert.equal(r.price, 19)
    assert.ok(!r.isFallback, '不应是 fallback')
  })

  test('Chilli 命中自己的特殊价 €6.5', () => {
    const r = resolveCustomerPrice(PRODUCTS[2], NEW_RESTAURANT, [NEW_RESTAURANT_PRICELIST], 1)
    assert.equal(r.price, 6.5)
  })

  test('若客户没绑 pricelist，回退到 listPrice', () => {
    const cust: Customer = { ...NEW_RESTAURANT, pricelistId: undefined }
    const r = resolveCustomerPrice(PRODUCTS[1], cust, [NEW_RESTAURANT_PRICELIST], 1)
    assert.equal(r.price, 20)  // Onion listPrice
    assert.ok(r.isFallback)
  })
})

describe('运营流程：priceType 的三种分派', () => {
  test('priceType=default 完全忽略 pricelist，即使有专属规则也用 listPrice', () => {
    const cust: Customer = { ...NEW_RESTAURANT, priceType: 'default' }
    const r = resolveCustomerPrice(PRODUCTS[0], cust, [NEW_RESTAURANT_PRICELIST], 1)
    // pricelist 有 Carrot €7 的规则，但因为 priceType=default，直接用 listPrice €10
    assert.equal(r.price, 10)
    assert.equal(r.pricelistName, '直接牌价')
  })

  test('priceType=last 用历史成交价', () => {
    const cust: Customer = { ...NEW_RESTAURANT, priceType: 'last' }
    const r = resolveCustomerPrice(PRODUCTS[0], cust, [NEW_RESTAURANT_PRICELIST], 1, 8.88)
    assert.equal(r.price, 8.88)
  })
})

describe('运营流程：客户专属特殊价覆盖 pricelist 规则', () => {
  test('客户特殊价 > pricelist 规则 > 牌价', () => {
    const cust: Customer = {
      ...NEW_RESTAURANT,
      specialPrices: [{ id: 'sp1', productId: 'p_carrot', minQty: 0, fixedPrice: 5.55 }],
    }
    const r = resolveCustomerPrice(PRODUCTS[0], cust, [NEW_RESTAURANT_PRICELIST], 1)
    // 专属价 €5.55 胜过 pricelist 的 €7
    assert.equal(r.price, 5.55)
    assert.equal(r.isSpecialPrice, true)
  })
})

// ─── 第二组：订单下单路径的权威重算 ─────────────────────────────────────

describe('下单时服务端强制按 pricelist 计算', () => {
  function makeMockPrisma() {
    return {
      user: {
        findFirst: async () => ({ customerId: 'cust_new_rest' }),
        findMany: async () => [{ id: 'user_restaurant_1' }],
      },
      customer: {
        findFirst: async () => ({
          id: 'cust_new_rest',
          name: 'NEW RESTAURANT',
          address: '', phone: '', email: '', vatNumber: '',
          paymentTerm: 'monthly',
          createdAt: new Date(),
          isActive: true,
          city: null, notes: null, externalId: null,
          creditLimit: null, commissionRate: null,
          priceType: 'multi', pricelistId: 'pl_new_restaurant',
          specialPrices: [],
        }),
      },
      product: {
        findMany: async () => PRODUCTS.map((p) => ({
          ...p, status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date(),
          template: {
            id: p.templateId, type: 'PRODUCT',
            listPrice: p.listPrice, standardPrice: p.standardPrice,
            customerTaxRate: 0.135, commissionPrice: 0, categoryId: p.categoryId,
          },
          price: null, stock: null, spec: null,
          internalRef: null, externalId: null,
        })),
      },
      productTemplate: {},
      odooPricelist: {
        findMany: async () => [{ ...NEW_RESTAURANT_PRICELIST, updatedAt: new Date() }],
      },
      order: { findMany: async () => [] },
    }
  }

  test('前端传 €10，服务端强制重写为 €7（Carrot 特殊价）+ 写 warning', async () => {
    const { lines, warnings, totalAmount } = await resolveOrderLines(
      { prisma: makeMockPrisma() as never, restaurantId: 'user_restaurant_1' },
      [{ productId: 'p_carrot', productName: 'Carrot', price: 10, quantity: 2 }],
    )
    assert.equal(lines[0].authoritativeUnitPrice, 7)
    assert.equal(lines[0].accepted, false)
    assert.equal(lines[0].subtotal, 14)  // 7 × 2
    assert.equal(totalAmount, 14)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /Carrot/)
  })

  test('前端传正确价格 €19（Onion 全局 -5%），服务端接受', async () => {
    const { lines, warnings } = await resolveOrderLines(
      { prisma: makeMockPrisma() as never, restaurantId: 'user_restaurant_1' },
      [{ productId: 'p_onion', productName: 'Onion', price: 19, quantity: 1 }],
    )
    assert.equal(lines[0].authoritativeUnitPrice, 19)
    assert.equal(lines[0].accepted, true)
    assert.equal(warnings.length, 0)
  })

  test('混合订单：Carrot 特殊价 + Onion 全局 + Chilli 特殊价，totalAmount 正确', async () => {
    const { lines, totalAmount } = await resolveOrderLines(
      { prisma: makeMockPrisma() as never, restaurantId: 'user_restaurant_1' },
      [
        { productId: 'p_carrot', productName: 'Carrot', quantity: 1 },
        { productId: 'p_onion',  productName: 'Onion',  quantity: 1 },
        { productId: 'p_chilli', productName: 'Chilli', quantity: 2 },
      ],
    )
    // Carrot €7 + Onion €19 + Chilli €6.5 × 2 = €7 + €19 + €13 = €39
    assert.equal(lines.length, 3)
    assert.equal(totalAmount, 39)
  })
})

// ─── 第三组：pricelist 规则优先级（sequence） ────────────────────────────

describe('Items 排序与优先级', () => {
  test('sequence 更小的规则先命中', () => {
    const pl: OdooPricelist = {
      ...NEW_RESTAURANT_PRICELIST,
      items: [
        { id: 'late', applyOn: 'global', minQty: 0, computeType: 'fixed', fixedPrice: 100, sequence: 100 },
        { id: 'early', applyOn: 'global', minQty: 0, computeType: 'fixed', fixedPrice: 5, sequence: 1 },
      ],
    }
    const r = resolvePrice(PRODUCTS[0], pl, [pl], 1)
    assert.equal(r.price, 5)
    assert.ok(r.itemDesc.includes('固定价'))
  })
})
