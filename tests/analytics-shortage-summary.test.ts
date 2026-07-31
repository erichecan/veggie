import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeShortageDaily } from '../lib/analytics/shortage'

test('空数组 → 全 0，缺货率不除零', () => {
  assert.deepEqual(summarizeShortageDaily([]), { shortageLines: 0, orderLines: 0, shortageRate: 0 })
})

test('按天累加缺货行/订单行，算出缺货率并四舍五入到万分位', () => {
  const daily = [
    { day: new Date('2026-07-01'), shortage_lines: 2, order_lines: 20 },
    { day: new Date('2026-07-02'), shortage_lines: 1, order_lines: 30 },
  ]
  assert.deepEqual(summarizeShortageDaily(daily), { shortageLines: 3, orderLines: 50, shortageRate: 0.06 })
})

test('订单行数为 0 → 缺货率记 0（不是 NaN）', () => {
  const daily = [{ day: new Date('2026-07-01'), shortage_lines: 0, order_lines: 0 }]
  assert.deepEqual(summarizeShortageDaily(daily), { shortageLines: 0, orderLines: 0, shortageRate: 0 })
})
