import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePrice, resolveCustomerPrice } from '../lib/pricing-engine'
import type { Product, OdooPricelist, OdooPricelistItem, Customer } from '../lib/types'

/**
 * 专门测试"价格表优先级"这个主题，区分两种嵌套关系：
 *
 * - 并列（sibling）：同一张价格表内部的多个 item，或客户挂载的多张价格表，
 *   彼此是平级候选，谁生效由 sequence（数字小优先）+ 数组原始顺序决定。
 * - 串联（chained）：一个 item 的 formulaBase='pricelist' 指向另一张价格表，
 *   价格通过递归调用逐层算出（见 pricing-engine-formula.test.ts 的嵌套测试）。
 *
 * 这里重点验证：这两种关系混在一起时，优先级到底是怎么判定的——
 * 结论：全程只看 sequence（相同则看数组顺序），跟规则是"直接命中"还是
 * "串联到别的表"、跟嵌套算出来的价格是贵是便宜，完全无关。
 */

const priorityProduct: Product = {
  id: 'p-priority', templateId: 't-priority', name: 'Priority Test Product',
  listPrice: 100, standardPrice: 50, price: 100,
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

// ═══ 第 1 组：同一张表内部"并列"条目 — 纯粹拼 sequence，不隐含"谁更具体谁优先" ═══

test('并列-同表：全局规则 sequence 更小 → 抢先于更具体的变体规则', () => {
  const p = pl('pl-1a', [
    item({ sequence: 1, applyOn: 'global', fixedPrice: 10 }),
    item({ sequence: 2, applyOn: 'variant', productVariantId: 'p-priority', fixedPrice: 99 }),
  ])
  const r = resolvePrice(priorityProduct, p, [p])
  assert.equal(r.price, 10, '全局规则 sequence 更小，即使变体规则更"具体"也不会被优先采用')
})

test('并列-同表：调换 sequence 后，具体规则 sequence 更小则具体规则赢（对照组）', () => {
  const p = pl('pl-1b', [
    item({ sequence: 1, applyOn: 'variant', productVariantId: 'p-priority', fixedPrice: 99 }),
    item({ sequence: 2, applyOn: 'global', fixedPrice: 10 }),
  ])
  const r = resolvePrice(priorityProduct, p, [p])
  assert.equal(r.price, 99, '证明没有隐含的"variant > global"层级，纯粹看 sequence 数字')
})

test('并列-同表：sequence 相同时，按数组原始顺序（先到先得）', () => {
  const pForward = pl('pl-1c-fwd', [
    item({ sequence: 10, fixedPrice: 5 }),
    item({ sequence: 10, fixedPrice: 8 }),
  ])
  assert.equal(resolvePrice(priorityProduct, pForward, [pForward]).price, 5)

  const pReversed = pl('pl-1c-rev', [
    item({ sequence: 10, fixedPrice: 8 }),
    item({ sequence: 10, fixedPrice: 5 }),
  ])
  assert.equal(resolvePrice(priorityProduct, pReversed, [pReversed]).price, 8, 'sequence 相同时数组顺序换了，结果也跟着换，证明是数组顺序在兜底裁决')
})

// ═══ 第 2 组：同一张表内，"直接命中"条目 与 "串联到别的表"条目 并列竞争 ═══

test('并列-同表：直接固定价 sequence 更小 → 优先，串联条目引用的嵌套表根本不会被查', () => {
  const nested = pl('pl-2a-nested', [item({ fixedPrice: 999 })])  // 故意设夸张值，一旦被误用测试立刻能看出来
  const outer = pl('pl-2a-outer', [
    item({ sequence: 1, computeType: 'fixed', fixedPrice: 20 }),
    item({ sequence: 2, computeType: 'formula', formulaBase: 'pricelist', basedOnPricelistId: 'pl-2a-nested' }),
  ])
  const r = resolvePrice(priorityProduct, outer, [outer, nested])
  assert.equal(r.price, 20, '直接命中条目 sequence 更小，串联那条被跳过，不应该是嵌套表的 999')
})

test('并列-同表：串联到别的表的条目 sequence 更小 → 优先命中，即使后面还有更"直接"的条目', () => {
  const nested = pl('pl-2b-nested', [item({ computeType: 'fixed', fixedPrice: 30 })])
  const outer = pl('pl-2b-outer', [
    item({ sequence: 1, computeType: 'formula', formulaBase: 'pricelist', basedOnPricelistId: 'pl-2b-nested' }),
    item({ sequence: 2, computeType: 'fixed', fixedPrice: 20 }),
  ])
  const r = resolvePrice(priorityProduct, outer, [outer, nested])
  assert.equal(r.price, 30, '串联条目 sequence 更小就该赢，不会因为后面那条"更直接"就被抢走')
})

test('并列-同表：两条都是"串联"到不同表，sequence 小的赢——不是比价择优，纯粹先到先得', () => {
  const nestedExpensive = pl('pl-4-expensive', [item({ computeType: 'fixed', fixedPrice: 200 })])
  const nestedCheap = pl('pl-4-cheap', [item({ computeType: 'fixed', fixedPrice: 10 })])
  const outer = pl('pl-4-outer', [
    item({ sequence: 1, computeType: 'formula', formulaBase: 'pricelist', basedOnPricelistId: 'pl-4-expensive' }),
    item({ sequence: 2, computeType: 'formula', formulaBase: 'pricelist', basedOnPricelistId: 'pl-4-cheap' }),
  ])
  const r = resolvePrice(priorityProduct, outer, [outer, nestedExpensive, nestedCheap])
  assert.equal(r.price, 200, '定价引擎不会自动挑更便宜/更贵的规则，谁 sequence 小谁生效，跟结果金额无关')
})

// ═══ 第 3 组：客户挂载多张"并列"价格表 × 单张表内部"串联"嵌套 —— 组合场景 ═══
// 这是最容易搞混的地方：客户链条上第一张表，如果是靠内部串联嵌套才算出价格的，
// 算不算"命中"？会不会因为是"绕了一圈"算出来的，就被当成没命中而继续查第二张？

test('客户并列链：第一张表靠内部串联嵌套算出价 → 链条在第一张即终止，不再看第二张', () => {
  const nested = pl('pl-3a-nested', [item({ computeType: 'fixed', fixedPrice: 45 })])
  const plFirst = pl('pl-3a-first', [item({ computeType: 'formula', formulaBase: 'pricelist', basedOnPricelistId: 'pl-3a-nested' })])
  const plSecond = pl('pl-3a-second', [item({ computeType: 'fixed', fixedPrice: 60 })])

  const c = customer({ pricelists: [{ pricelistId: 'pl-3a-first', sequence: 1 }, { pricelistId: 'pl-3a-second', sequence: 2 }] })
  const r = resolveCustomerPrice(priorityProduct, c, [plFirst, plSecond, nested], 1)

  assert.equal(r.price, 45, '第一张表串联嵌套算出 45，应直接采用')
  assert.equal(r.pricelistName, 'pl-3a-first', '来源应显示第一张表，而不是第二张')
})

test('客户并列链：第一张表内部串联的嵌套表查无结果 → 判定第一张整体未命中，继续查第二张', () => {
  const nestedEmpty = pl('pl-3b-nested-empty', [])  // 空规则，必定 fallback
  const plFirst = pl('pl-3b-first', [item({ computeType: 'formula', formulaBase: 'pricelist', basedOnPricelistId: 'pl-3b-nested-empty' })])
  const plSecond = pl('pl-3b-second', [item({ computeType: 'fixed', fixedPrice: 60 })])

  const c = customer({ pricelists: [{ pricelistId: 'pl-3b-first', sequence: 1 }, { pricelistId: 'pl-3b-second', sequence: 2 }] })
  const r = resolveCustomerPrice(priorityProduct, c, [plFirst, plSecond, nestedEmpty], 1)

  assert.equal(r.price, 60, '第一张表串联的目标查无结果，第一张整体应算未命中，链条继续查第二张')
  assert.equal(r.pricelistName, 'pl-3b-second')
})

test('客户并列链：第一张表内部是三层串联，走完三层拿到价 → 依然不查第二张', () => {
  const level3 = pl('pl-3c-l3', [item({ computeType: 'formula', formulaBase: 'list_price', priceSurcharge: 1 })])       // 100+1=101
  const level2 = pl('pl-3c-l2', [item({ computeType: 'formula', formulaBase: 'pricelist', basedOnPricelistId: 'pl-3c-l3', priceDiscount: 10 })]) // 101*0.9=90.9
  const plFirst = pl('pl-3c-first', [item({ computeType: 'formula', formulaBase: 'pricelist', basedOnPricelistId: 'pl-3c-l2' })]) // 90.9
  const plSecond = pl('pl-3c-second', [item({ computeType: 'fixed', fixedPrice: 999 })])  // 哨兵值，不该被用到

  const c = customer({ pricelists: [{ pricelistId: 'pl-3c-first', sequence: 1 }, { pricelistId: 'pl-3c-second', sequence: 2 }] })
  const r = resolveCustomerPrice(priorityProduct, c, [plFirst, plSecond, level2, level3], 1)

  assert.equal(r.price, 90.9, '三层串联全部走通，链条在第一张表即终止')
  assert.notEqual(r.price, 999)
})
