/**
 * 服务端价格重算单元测试
 * ============================================================================
 * 用 node:test 内置框架 + 纯 TS mock，不依赖数据库。
 *
 * 验证：
 *   1. 前端传入 price 与权威价一致 → accepted=true
 *   2. 前端传入 price 偏差 > 1 分 → accepted=false，按权威价落库
 *   3. priceType=default 时忽略前端价，用 listPrice
 *   4. priceType=last + 历史订单存在 → 用历史价
 *   5. 商品不存在时抛错
 *   6. Idempotent：total = Σ subtotal
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOrderLines, PRICE_TOLERANCE_EUR } from '../lib/server-pricing'

// ─── 简化 Prisma Mock ───────────────────────────────────────────────────
function makeMockPrisma(opts: {
  userCustomerId?: string
  customer?: Record<string, unknown> | null
  products?: Array<Record<string, unknown>>
  pricelists?: Array<Record<string, unknown>>
  historicalOrders?: Array<Record<string, unknown>>
}) {
  return {
    user: {
      findFirst: async () => opts.userCustomerId ? { customerId: opts.userCustomerId } : null,
      findMany: async () => opts.userCustomerId ? [{ id: 'restaurant_user_1' }] : [],
    },
    customer: {
      findFirst: async () => opts.customer ?? null,
    },
    product: {
      findMany: async () => opts.products ?? [],
    },
    productTemplate: {},
    odooPricelist: {
      findMany: async () => opts.pricelists ?? [],
    },
    order: {
      findMany: async () => opts.historicalOrders ?? [],
    },
  }
}

const baseProduct = {
  id: 'p1',
  templateId: 't1',
  name: 'Carrot',
  variantAttributes: [],
  listPrice: 10,
  standardPrice: 5,
  qtyOnHand: 100,
  active: true,
  categoryId: 'cat1',
  customerTaxRate: 0.135,
  commissionPrice: 0,
  images: [],
  status: 'ACTIVE',
  createdAt: new Date(),
  updatedAt: new Date(),
  template: {
    id: 't1',
    type: 'PRODUCT',
    listPrice: 10,
    standardPrice: 5,
    customerTaxRate: 0.135,
    commissionPrice: 0,
    categoryId: 'cat1',
  },
  internalRef: null,
  externalId: null,
  sequence: 1,
  price: null,
  stock: null,
  spec: null,
}

const basePricelist = {
  id: 'pl1',
  name: 'TAKEAWAY',
  currency: 'EUR',
  items: [
    { id: 'r1', applyOn: 'global', minQty: 0, computeType: 'fixed', fixedPrice: 8, sequence: 1 },
  ],
  sequence: 1,
  selectable: true,
  active: true,
  updatedAt: new Date(),
  externalId: null,
}

const baseCustomer = {
  id: 'cust1',
  name: 'Test Cust',
  address: '',
  phone: '',
  email: '',
  vatNumber: '',
  paymentTerm: 'monthly',
  createdAt: new Date(),
  isActive: true,
  city: null,
  notes: null,
  externalId: null,
  creditLimit: null,
  commissionRate: null,
  priceType: 'multi',
  pricelistId: 'pl1',
  specialPrices: [],
}

describe('resolveOrderLines: 价格权威性', () => {
  test('前端价格与权威价一致 → accepted', async () => {
    const mockPrisma = makeMockPrisma({
      customer: baseCustomer,
      products: [baseProduct],
      pricelists: [basePricelist],
    })
    const result = await resolveOrderLines(
      { prisma: mockPrisma as never, restaurantId: 'cust1' },
      [{ productId: 'p1', productName: 'Carrot', price: 8, quantity: 2 }],
    )
    assert.equal(result.lines.length, 1)
    assert.equal(result.lines[0].authoritativeUnitPrice, 8)
    assert.equal(result.lines[0].accepted, true)
    assert.equal(result.lines[0].subtotal, 16)
    assert.equal(result.totalAmount, 16)
    assert.equal(result.warnings.length, 0)
  })

  test('前端价格偏差 > €0.01 → warning，按权威价落库', async () => {
    const mockPrisma = makeMockPrisma({
      customer: baseCustomer,
      products: [baseProduct],
      pricelists: [basePricelist],
    })
    const result = await resolveOrderLines(
      { prisma: mockPrisma as never, restaurantId: 'cust1' },
      [{ productId: 'p1', productName: 'Carrot', price: 3.0, quantity: 1 }], // 客户想少付 5 元
    )
    assert.equal(result.lines[0].authoritativeUnitPrice, 8)
    assert.equal(result.lines[0].submittedUnitPrice, 3)
    assert.equal(result.lines[0].accepted, false)
    assert.equal(result.lines[0].subtotal, 8)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /Carrot/)
  })

  test('前端价格在容差内（±€0.01）→ 通过', async () => {
    const mockPrisma = makeMockPrisma({
      customer: baseCustomer,
      products: [baseProduct],
      pricelists: [basePricelist],
    })
    const withinTolerance = 8 + PRICE_TOLERANCE_EUR
    const result = await resolveOrderLines(
      { prisma: mockPrisma as never, restaurantId: 'cust1' },
      [{ productId: 'p1', productName: 'Carrot', price: withinTolerance, quantity: 1 }],
    )
    assert.equal(result.lines[0].accepted, true)
  })
})

describe('resolveOrderLines: priceType 分派', () => {
  test('priceType=default → 用 listPrice（忽略 pricelist）', async () => {
    const mockPrisma = makeMockPrisma({
      customer: { ...baseCustomer, priceType: 'default' },
      products: [baseProduct],
      pricelists: [basePricelist], // 有规则 €8 但 default 下忽略
    })
    const result = await resolveOrderLines(
      { prisma: mockPrisma as never, restaurantId: 'cust1' },
      [{ productId: 'p1', productName: 'Carrot', price: 10, quantity: 1 }],
    )
    assert.equal(result.lines[0].authoritativeUnitPrice, 10) // listPrice
  })

  test('priceType=last + 历史订单存在 → 用历史价', async () => {
    const mockPrisma = makeMockPrisma({
      userCustomerId: 'cust1',
      customer: { ...baseCustomer, priceType: 'last' },
      products: [baseProduct],
      pricelists: [basePricelist],
      historicalOrders: [
        { items: [{ productId: 'p1', price: 6.5 }] },
      ],
    })
    const result = await resolveOrderLines(
      { prisma: mockPrisma as never, restaurantId: 'cust1' },
      [{ productId: 'p1', productName: 'Carrot', price: 6.5, quantity: 1 }],
    )
    assert.equal(result.lines[0].authoritativeUnitPrice, 6.5)
  })
})

describe('resolveOrderLines: 错误处理', () => {
  test('客户不存在 → 抛 400', async () => {
    const mockPrisma = makeMockPrisma({ customer: null })
    await assert.rejects(
      () => resolveOrderLines(
        { prisma: mockPrisma as never, restaurantId: 'ghost' },
        [{ productId: 'p1', quantity: 1 }],
      ),
      (err: unknown) => {
        const e = err as { status?: number; message?: string }
        return e.status === 400 && /客户不存在/.test(e.message ?? '')
      },
    )
  })

  test('商品不存在 → 抛 400', async () => {
    const mockPrisma = makeMockPrisma({
      customer: baseCustomer,
      products: [],
      pricelists: [basePricelist],
    })
    await assert.rejects(
      () => resolveOrderLines(
        { prisma: mockPrisma as never, restaurantId: 'cust1' },
        [{ productId: 'MISSING', quantity: 1 }],
      ),
      (err: unknown) => {
        const e = err as { status?: number; message?: string }
        return e.status === 400 && /商品不存在/.test(e.message ?? '')
      },
    )
  })
})
