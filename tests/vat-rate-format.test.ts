import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatVatRate } from '../lib/order-pdf'

test('爱尔兰带小数的档位不得被整数化 —— 13.5% 曾被显示成 14%', () => {
  assert.equal(formatVatRate(13.5), '13.5%')
  assert.equal(formatVatRate(4.8), '4.8%')
})

test('整数档位不显示多余小数位', () => {
  assert.equal(formatVatRate(23), '23%')
  assert.equal(formatVatRate(9), '9%')
  assert.equal(formatVatRate(0), '0%')
})

test('行级与汇总的税率显示必须一致 —— 同一张发票上不能出现两个税率', () => {
  // 汇总行用 rate.toFixed(1)，行级用 formatVatRate，两者对同一税率应指向同一个值
  for (const rate of [13.5, 4.8, 23, 9]) {
    const summary = rate.toFixed(1)          // "13.5" / "23.0"
    const line = formatVatRate(rate).replace('%', '')
    assert.equal(parseFloat(line), parseFloat(summary), `${rate} 行级与汇总不一致`)
  }
})
