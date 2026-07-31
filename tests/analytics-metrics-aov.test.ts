import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveAov } from '../lib/analytics/metrics'

test('订单数为 0 → 客单价 0，不除以零', () => {
  assert.equal(deriveAov(1234.5, 0), 0)
})

test('正常计算并四舍五入到分', () => {
  assert.equal(deriveAov(100, 3), 33.33)
})

test('整除的情况保留两位小数语义（数值相等即可）', () => {
  assert.equal(deriveAov(200, 2), 100)
})
