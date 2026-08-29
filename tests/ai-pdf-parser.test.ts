import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildResultFromModelJson } from '../lib/purchase/ai-pdf-parser'

const SUPPLIERS = [{ id: 's1', name: 'Dublin Veg Wholesale' }]

describe('buildResultFromModelJson（AI 辅助路径的后置校验，不碰网络）', () => {
  test('⛔ 不信模型把自家抬头当供应商 —— 20260828 gemini-3.1-flash-lite 实测把 JohnstoneBros 当成了供应商', () => {
    const r = buildResultFromModelJson({
      supplierName: 'JohnstoneBros',
      currency: 'EUR',
      lines: [{ productName: 'Courgette LOOSE', quantity: 1, unitCost: 1.2, uom: 'LOOSE' }],
    }, SUPPLIERS)
    assert.equal(r.supplierName, null)
    assert.equal(r.supplierId, null)
  })

  test('⛔ 同一条规则不分大小写/空格写法（Johnstone Bros / johnstonebros）', () => {
    assert.equal(buildResultFromModelJson({ supplierName: 'Johnstone Bros', lines: [{ productName: 'x' }] }, []).supplierName, null)
    assert.equal(buildResultFromModelJson({ supplierName: 'johnstonebros', lines: [{ productName: 'x' }] }, []).supplierName, null)
  })

  test('真供应商名不受影响，且命中系统名单能给出 supplierId', () => {
    const r = buildResultFromModelJson({
      supplierName: 'Dublin Veg Wholesale',
      lines: [{ productName: 'Apple', quantity: 3, unitCost: 2.5 }],
    }, SUPPLIERS)
    assert.equal(r.supplierName, 'Dublin Veg Wholesale')
    assert.equal(r.supplierId, 's1')
  })

  test('供应商名读到了但系统里没有 → 如实返回名字、supplierId 为 null，不替人挑', () => {
    const r = buildResultFromModelJson({
      supplierName: 'Fresh Iberia SL',
      lines: [{ productName: 'Apple' }],
    }, SUPPLIERS)
    assert.equal(r.supplierName, 'Fresh Iberia SL')
    assert.equal(r.supplierId, null)
  })

  test('没有商品行时明确报错，而不是静默返回空表', () => {
    const r = buildResultFromModelJson({ lines: [] }, [])
    assert.equal(r.lines.length, 0)
    assert.match(r.error ?? '', /未能.*识别出商品行/)
  })

  test('商品名为空白的行会被丢弃', () => {
    const r = buildResultFromModelJson({
      lines: [{ productName: '  ' }, { productName: 'Apple', quantity: 1, unitCost: 1 }],
    }, [])
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0].productName, 'Apple')
  })
})
