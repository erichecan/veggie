import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTaxRate } from '../lib/server-pricing'

test('小数量纲归一成百分数（Product.customerTaxRate 存的是 0.1350）', () => {
  assert.equal(normalizeTaxRate(0.135), 13.5)
  assert.equal(normalizeTaxRate(0.23), 23)
  assert.equal(normalizeTaxRate(0.048), 4.8)
})

test('已经是百分数的原样保留', () => {
  assert.equal(normalizeTaxRate(13.5), 13.5)
  assert.equal(normalizeTaxRate(23), 23)
  assert.equal(normalizeTaxRate(9), 9)
})

test('0 不做换算 —— 零税率是合法档位，不能被当成"未填"', () => {
  assert.equal(normalizeTaxRate(0), 0)
})

test('空值返回 undefined，让 Prisma 落 NULL 而不是 0', () => {
  assert.equal(normalizeTaxRate(null), undefined)
  assert.equal(normalizeTaxRate(undefined), undefined)
  assert.equal(normalizeTaxRate(NaN), undefined)
})

test('IE 的 VAT 档位在 (0,1) 区间无合法值，故判别无歧义', () => {
  // 0 / 4.8 / 9 / 13.5 / 23 —— 归一后都 >= 1，不会被二次换算
  for (const pct of [4.8, 9, 13.5, 23]) {
    assert.equal(normalizeTaxRate(normalizeTaxRate(pct)), pct, `${pct} 二次归一应幂等`)
  }
})
