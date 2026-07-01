/**
 * 回归测试：单号含中文时条形码取值回退到 ASCII fallback(id)，避免 CODE128 抛错致条形码空白。
 * bug: 订单号 "运营-260701-001"(创建者"运营")→ JsBarcode CODE128 抛错 → 条形码整块不显示。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { barcodeValue } from '../lib/barcode'

test('纯 ASCII 单号 → 用单号本身', () => {
  assert.equal(barcodeValue('CJ-260424-001', 'id_x'), 'CJ-260424-001')
  assert.equal(barcodeValue('INV-00001', 'id_x'), 'INV-00001')
})

test('含中文单号 → 回退 fallback(id)', () => {
  assert.equal(barcodeValue('运营-260701-001', 'id_x'), 'id_x')
})

test('空 / null / 纯空白 → 回退 fallback', () => {
  assert.equal(barcodeValue('', 'id_x'), 'id_x')
  assert.equal(barcodeValue(null, 'id_x'), 'id_x')
  assert.equal(barcodeValue('   ', 'id_x'), 'id_x')
})
