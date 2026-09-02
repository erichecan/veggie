import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateSaleUomItems, normalizeFactor, factorOf, priceOf, commissionPriceOf, baseUomId,
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

describe('提成价换算（20260901）：照抄价格机制，可 null（不计提成）', () => {
  // 基础单位提成价 €0.50/包；箱(u-case) 没配提成 override → 按 AUTO 用 factor 折算；
  // 整托(u-pallet) 配了 FIXED 一口价；再加一个 FORMULA 折扣/加价的规格 u-formula。
  const SHRIMP_COMMISSION: SaleUomRow[] = [
    { uomId: 'u-pkt', isDefault: true, factor: 1, priceOverride: null },
    { uomId: 'u-case', isDefault: false, factor: 10, priceOverride: null },
    {
      uomId: 'u-pallet', isDefault: false, factor: 400, priceOverride: 3800,
      commissionPriceMode: 'FIXED', commissionPriceOverride: 150,
    },
    {
      uomId: 'u-formula', isDefault: false, factor: 20, priceOverride: null,
      commissionPriceMode: 'FORMULA', commissionDiscountPct: -10, commissionSurcharge: 2,
    },
  ]

  it('基础单位用基础提成价原样返回', () => {
    assert.equal(commissionPriceOf(SHRIMP_COMMISSION, 'u-pkt', 0.5), 0.5)
  })

  it('AUTO（未配置提成 override）→ 按 factor 线性折算，与改造前行为一致', () => {
    assert.equal(commissionPriceOf(SHRIMP_COMMISSION, 'u-case', 0.5), 5)
  })

  it('FIXED → 用独立提成价，不是 0.5 × 400 = 200', () => {
    assert.equal(commissionPriceOf(SHRIMP_COMMISSION, 'u-pallet', 0.5), 150)
  })

  it('FORMULA → base × factor × (1 + pct/100) + surcharge', () => {
    // 0.5 × 20 × (1 - 10/100) + 2 = 10 × 0.9 + 2 = 11
    assert.equal(commissionPriceOf(SHRIMP_COMMISSION, 'u-formula', 0.5), 11)
  })

  it('商品本身不计提成（base=null）时，AUTO/FORMULA 折算不出提成', () => {
    assert.equal(commissionPriceOf(SHRIMP_COMMISSION, 'u-case', null), null)
    assert.equal(commissionPriceOf(SHRIMP_COMMISSION, 'u-formula', null), null)
  })

  it('商品本身不计提成，但该单位配了 FIXED override → 仍按 override 给', () => {
    assert.equal(commissionPriceOf(SHRIMP_COMMISSION, 'u-pallet', null), 150)
  })

  it('没配多规格 / 选的就是基础单位 → 原样返回基础提成价', () => {
    assert.equal(commissionPriceOf([], 'u-case', 0.5), 0.5)
    assert.equal(commissionPriceOf(SHRIMP_COMMISSION, null, 0.5), 0.5)
  })

  it('选了个没配过的单位 → 回落到基础提成价，不抛错', () => {
    assert.equal(commissionPriceOf(SHRIMP_COMMISSION, 'u-unknown', 0.5), 0.5)
  })
})

describe('提成校验（20260901）：跟价格的校验规则一样', () => {
  it('独立提成价必须在 0–1,000,000 之间', () => {
    assert.match(validateSaleUomItems([
      { uomId: 'a', isDefault: true, factor: 1 },
      { uomId: 'b', isDefault: false, factor: 1, commissionPriceOverride: -1 },
    ]) ?? '', /独立提成价/)
  })

  it('FORMULA 模式下提成百分比调整必须在 −100–1000 之间（下限对应"打到 0 折"，不是 0）', () => {
    assert.match(validateSaleUomItems([
      { uomId: 'a', isDefault: true, factor: 1 },
      { uomId: 'b', isDefault: false, factor: 1, commissionPriceMode: 'FORMULA', commissionDiscountPct: -150 },
    ]) ?? '', /提成百分比/)
    assert.match(validateSaleUomItems([
      { uomId: 'a', isDefault: true, factor: 1 },
      { uomId: 'b', isDefault: false, factor: 1, commissionPriceMode: 'FORMULA', commissionDiscountPct: 2000 },
    ]) ?? '', /提成百分比/)
  })

  it('负数（打折）合法——跟价格公式编辑器"负数=打折"的 UI 提示一致', () => {
    assert.equal(validateSaleUomItems([
      { uomId: 'a', isDefault: true, factor: 1 },
      { uomId: 'b', isDefault: false, factor: 1, commissionPriceMode: 'FORMULA', commissionDiscountPct: -20 },
    ]), null)
  })

  it('FORMULA 模式下提成加减金额必须在 ±1,000,000 之间', () => {
    assert.match(validateSaleUomItems([
      { uomId: 'a', isDefault: true, factor: 1 },
      { uomId: 'b', isDefault: false, factor: 1, commissionPriceMode: 'FORMULA', commissionSurcharge: 2_000_000 },
    ]) ?? '', /提成加减金额/)
  })

  it('不配置提成字段的合法配置照常通过（未特意配置的商品完全不受影响）', () => {
    assert.equal(validateSaleUomItems([
      { uomId: 'u-pkt', isDefault: true, factor: 1 },
      { uomId: 'u-case', isDefault: false, factor: 10 },
    ]), null)
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
