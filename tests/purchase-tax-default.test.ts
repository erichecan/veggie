import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultPurchaseTaxRate, purchaseTaxRateFromVendorTax } from '../lib/purchase/tax-rates'

// 20261013：商品 Vendor Taxes 存小数(0.23)，采购单行存百分数(23)；采购建议转单曾把 0.23 当百分数用
test('Vendor Tax 小数换算成采购单百分数并对齐三档', () => {
  assert.equal(purchaseTaxRateFromVendorTax(0.23), 23)
  assert.equal(purchaseTaxRateFromVendorTax('0.135'), 13.5)
  assert.equal(purchaseTaxRateFromVendorTax(0), 0)
  assert.equal(purchaseTaxRateFromVendorTax(null), null)
  assert.equal(purchaseTaxRateFromVendorTax(''), null)
})

test('默认税率：商品优先、供应商兜底、都没有为 0', () => {
  assert.equal(defaultPurchaseTaxRate(0, 0.23), 0, '商品改成 0% 就是 0%，不能被供应商的 23% 盖掉')
  assert.equal(defaultPurchaseTaxRate(0.23, 0), 23)
  assert.equal(defaultPurchaseTaxRate(null, 0.135), 13.5)
  assert.equal(defaultPurchaseTaxRate(undefined, undefined), 0)
})
