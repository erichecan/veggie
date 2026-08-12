import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitIntoPacks, pickLargestPack, type PackSpec } from '../lib/pack-split'

const CASE12: PackSpec = { factor: 12, caseUomName: '箱', baseUomName: '包' }

test('整除 → 只印整箱，不印「+ 0 包」', () => {
  const s = splitIntoPacks(24, CASE12)!
  assert.equal(s.cases, 2)
  assert.equal(s.loose, 0)
  assert.equal(s.mixed, false)
  assert.equal(s.text, '2 箱')
})

test('不足一箱 → 只印零散', () => {
  const s = splitIntoPacks(5, CASE12)!
  assert.equal(s.cases, 0)
  assert.equal(s.loose, 5)
  assert.equal(s.text, '5 包')
})

test('混装 → 两段都印（这是本功能的主用例）', () => {
  const s = splitIntoPacks(30, CASE12)!
  assert.equal(s.cases, 2)
  assert.equal(s.loose, 6)
  assert.equal(s.mixed, true)
  assert.equal(s.text, '2 箱 + 6 包')
})

test('小数数量（散称货按重量卖）不丢精度', () => {
  const s = splitIntoPacks(12.5, CASE12)!
  assert.equal(s.cases, 1)
  assert.equal(s.loose, 0.5)
  assert.equal(s.text, '1 箱 + 0.5 包')
})

test('浮点尾巴被消掉，不会印出 6.000000000000001', () => {
  // 0.1×3 = 0.30000000000000004 这类；用 10.3 构造跨箱的小数
  const s = splitIntoPacks(36.3, CASE12)!
  assert.equal(s.cases, 3)
  assert.equal(s.loose, 0.3)
  assert.equal(s.text, '3 箱 + 0.3 包')
})

test('数量为 0 印「0 包」而不是空白格', () => {
  const s = splitIntoPacks(0, CASE12)!
  assert.equal(s.text, '0 包')
})

test('没箱规 / 箱规为 1 → 返回 null，调用方照原样印', () => {
  assert.equal(splitIntoPacks(30, null), null)
  assert.equal(splitIntoPacks(30, undefined), null)
  assert.equal(splitIntoPacks(30, { factor: 1, caseUomName: '包', baseUomName: '包' }), null)
  assert.equal(splitIntoPacks(30, { factor: 0, caseUomName: 'x', baseUomName: 'y' }), null)
})

test('负数量（退货冲减）不拆', () => {
  assert.equal(splitIntoPacks(-12, CASE12), null)
})

test('非整数箱规（如 1 托 = 2.5 箱）也能拆', () => {
  const s = splitIntoPacks(11, { factor: 2.5, caseUomName: '托', baseUomName: '箱' })!
  assert.equal(s.cases, 4)
  assert.equal(s.loose, 1)
  assert.equal(s.text, '4 托 + 1 箱')
})

test('pickLargestPack 取最大的大单位——能整托搬就不拆成箱', () => {
  const spec = pickLargestPack(
    [
      { name: '箱', factor: 12, type: 'BIGGER' },
      { name: '托', factor: 144, type: 'BIGGER' },
      { name: '包', factor: 1, type: 'REFERENCE' },
    ],
    '包',
  )!
  assert.equal(spec.factor, 144)
  assert.equal(spec.caseUomName, '托')
  assert.equal(spec.baseUomName, '包')
})

test('pickLargestPack：只有基准单位时没有箱规', () => {
  assert.equal(pickLargestPack([{ name: '包', factor: 1, type: 'REFERENCE' }], '包'), null)
  assert.equal(pickLargestPack([], '包'), null)
})
