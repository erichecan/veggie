import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateSaleUomItems, normalizeFactor, factorOf, priceOf, baseUomId,
  type SaleUomRow,
} from '../lib/sale-uom'

/**
 * 场景取自客户 20260819 的原话：
 * 「一个马铃薯，它有 3kg、5kg、10kg、一整箱、一袋的报价」
 * 以及生产库里真实存在的 `ASIAN CHOICE Black Tiger Shrimp 700g PKT / 10*700g CASE`。
 */
const SHRIMP: SaleUomRow[] = [
  { uomId: 'u-pkt', isDefault: true, factor: 1, priceOverride: null },      // 基础：一包 700g
  { uomId: 'u-case', isDefault: false, factor: 10, priceOverride: null },   // 一箱 10 包
  { uomId: 'u-pallet', isDefault: false, factor: 400, priceOverride: 3800 } // 整托，谈好的价
]

describe('校验', () => {
  it('默认单位的换算系数只能是 1 —— 它是库存的计数尺子', () => {
    const err = validateSaleUomItems([{ uomId: 'a', isDefault: true, factor: 2 }])
    assert.match(err ?? '', /默认单位/)
  })

  it('恰好一个默认单位', () => {
    assert.match(validateSaleUomItems([
      { uomId: 'a', isDefault: true, factor: 1 },
      { uomId: 'b', isDefault: true, factor: 1 },
    ]) ?? '', /只能有一个默认/)
    assert.match(validateSaleUomItems([{ uomId: 'a', isDefault: false, factor: 1 }]) ?? '', /只能有一个默认/)
  })

  it('单位不能重复', () => {
    assert.match(validateSaleUomItems([
      { uomId: 'a', isDefault: true, factor: 1 },
      { uomId: 'a', isDefault: false, factor: 10 },
    ]) ?? '', /不能重复/)
  })

  it('系数为 0 或负数被拒 —— 否则一箱等于零包，库存会算成不动', () => {
    assert.ok(validateSaleUomItems([
      { uomId: 'a', isDefault: true, factor: 1 },
      { uomId: 'b', isDefault: false, factor: 0 },
    ]))
    assert.ok(validateSaleUomItems([
      { uomId: 'a', isDefault: true, factor: 1 },
      { uomId: 'b', isDefault: false, factor: -5 },
    ]))
  })

  it('合法配置通过', () => {
    assert.equal(validateSaleUomItems([
      { uomId: 'u-pkt', isDefault: true, factor: 1 },
      { uomId: 'u-case', isDefault: false, factor: 10 },
      { uomId: 'u-pallet', isDefault: false, factor: 400, priceOverride: 3800 },
    ]), null)
  })

  it('空配置合法（绝大多数商品没配多规格）', () => {
    assert.equal(validateSaleUomItems([]), null)
  })

  it('小数系数合法 —— 1kg ≈ 1.43 包（700g/包）', () => {
    assert.equal(validateSaleUomItems([
      { uomId: 'u-pkt', isDefault: true, factor: 1 },
      { uomId: 'u-kg', isDefault: false, factor: 1.428571 },
    ]), null)
  })
})

describe('normalizeFactor：空与非法一律回落到 1', () => {
  it('空值', () => {
    assert.equal(normalizeFactor(null), 1)
    assert.equal(normalizeFactor(undefined), 1)
    assert.equal(normalizeFactor(''), 1)
  })
  it('非法值', () => {
    assert.equal(normalizeFactor('abc'), 1)
    assert.equal(normalizeFactor(0), 1)
    assert.equal(normalizeFactor(-3), 1)
  })
  it('正常值原样', () => {
    assert.equal(normalizeFactor('10'), 10)
    assert.equal(normalizeFactor(1.5), 1.5)
  })
})

describe('换算：1 个此单位 = 多少个基础单位', () => {
  it('基础单位是 1', () => {
    assert.equal(factorOf(SHRIMP, 'u-pkt'), 1)
  })
  it('整箱是 10', () => {
    assert.equal(factorOf(SHRIMP, 'u-case'), 10)
  })
  it('⛔ 没配多规格的商品一律 1 —— 与多规格上线前逐字一致', () => {
    assert.equal(factorOf([], 'u-case'), 1)
  })
  it('选了个没配过的单位也回落到 1，不抛错', () => {
    assert.equal(factorOf(SHRIMP, 'u-unknown'), 1)
  })
  it('uomId 为空时回落到 1', () => {
    assert.equal(factorOf(SHRIMP, null), 1)
  })
})

describe('计价：独立售价优先，否则按系数换算', () => {
  it('基础单位用基础价', () => {
    assert.equal(priceOf(SHRIMP, 'u-pkt', 12), 12)
  })
  it('整箱无独立价 → 12 × 10 = 120', () => {
    assert.equal(priceOf(SHRIMP, 'u-case', 12), 120)
  })
  it('整托有独立价 → 用谈好的 3800，而不是 12 × 400 = 4800', () => {
    assert.equal(priceOf(SHRIMP, 'u-pallet', 12), 3800)
  })
  it('没配多规格时原样返回基础价', () => {
    assert.equal(priceOf([], 'u-case', 12), 12)
  })
})

describe('基础单位（库存计数单位）', () => {
  it('取 isDefault 那一行', () => {
    assert.equal(baseUomId(SHRIMP), 'u-pkt')
  })
  it('没配多规格时为 null', () => {
    assert.equal(baseUomId([]), null)
  })
})

describe('客户原话场景：一个马铃薯 3kg / 5kg / 10kg / 整箱 / 一袋', () => {
  // 基础单位 kg，基础价 €1.20
  const POTATO: SaleUomRow[] = [
    { uomId: 'kg', isDefault: true, factor: 1, priceOverride: null },
    { uomId: 'bag3', isDefault: false, factor: 3, priceOverride: null },
    { uomId: 'bag5', isDefault: false, factor: 5, priceOverride: null },
    { uomId: 'bag10', isDefault: false, factor: 10, priceOverride: 10.5 }, // 整袋优惠
    { uomId: 'case', isDefault: false, factor: 25, priceOverride: 25 },    // 整箱优惠
  ]

  it('五个规格各自的报价', () => {
    assert.equal(priceOf(POTATO, 'kg', 1.2), 1.2)
    assert.equal(priceOf(POTATO, 'bag3', 1.2), 3.6)
    assert.equal(priceOf(POTATO, 'bag5', 1.2), 6)
    assert.equal(priceOf(POTATO, 'bag10', 1.2), 10.5)  // 优惠价，不是 12
    assert.equal(priceOf(POTATO, 'case', 1.2), 25)     // 优惠价，不是 30
  })

  it('卖出去时各自该扣多少库存（按基础单位 kg）', () => {
    assert.equal(2 * factorOf(POTATO, 'bag3'), 6)
    assert.equal(1 * factorOf(POTATO, 'bag10'), 10)
    assert.equal(1 * factorOf(POTATO, 'case'), 25)
  })
})
