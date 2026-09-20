/**
 * 时间桶标签：lib/reports/date-label.ts
 *
 * 这层看着琐碎，但它是 20260920 那个 bug 的另一半：交叉表的列头原来直接印
 * `2026-08-01T00:00:00.000Z`。重点是**一律按 UTC 取年月日** —— 用本地时区的话，
 * 都柏林夏令时（UTC+1）下 `2026-08-01T00:00:00Z` 会被读成 7 月 31 日，
 * 整列月份标签集体往前串一个月，而格子里的数字是对的，谁也看不出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bucketLabel, bucketLabelShort, allSameYear, bucketKey } from '../lib/reports/date-label'

const AUG = '2026-08-01T00:00:00.000Z'
const SEP = '2026-09-01T00:00:00.000Z'
const JAN27 = '2027-01-01T00:00:00.000Z'

test('月：中英两种标签', () => {
  assert.equal(bucketLabel(AUG, 'month', false), '2026 年 8 月')
  assert.equal(bucketLabel(AUG, 'month', true), 'August 2026')
})

test('年 / 季度 / 周 / 日', () => {
  assert.equal(bucketLabel(AUG, 'year', false), '2026 年')
  assert.equal(bucketLabel(AUG, 'year', true), '2026')
  assert.equal(bucketLabel(AUG, 'quarter', false), '2026 年 Q3')
  assert.equal(bucketLabel(AUG, 'quarter', true), 'Q3 2026')
  assert.equal(bucketLabel('2026-08-03T00:00:00.000Z', 'week', true), 'W32 2026')
  assert.equal(bucketLabel(AUG, 'day', false), '2026-08-01')
})

test('⛔ 按 UTC 取月份，不受运行机器时区影响', () => {
  // 都柏林 8 月是 UTC+1：本地化会把这个时刻读成 2026-07-31 23:00 → "7 月"
  const tz = process.env.TZ
  try {
    process.env.TZ = 'Europe/Dublin'
    assert.equal(bucketLabel(AUG, 'month', false), '2026 年 8 月')
    process.env.TZ = 'Pacific/Auckland'   // 另一侧：UTC+12，会读成 8 月 1 日 12:00，同样得是 8 月
    assert.equal(bucketLabel(AUG, 'month', false), '2026 年 8 月')
  } finally {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  }
})

test('空值与非法值不印 Invalid Date', () => {
  assert.equal(bucketLabel(null, 'month', false), '—')
  assert.equal(bucketLabel(undefined, 'month', false), '—')
  assert.equal(bucketLabel('', 'month', false), '—')
  assert.equal(bucketLabel('不是日期', 'month', false), '不是日期')
})

test('同年时用短标签，跨年时退回长标签', () => {
  assert.equal(allSameYear([AUG, SEP]), true)
  assert.equal(allSameYear([AUG, JAN27]), false)

  assert.equal(bucketLabelShort(AUG, 'month', false, true), '8 月')
  assert.equal(bucketLabelShort(AUG, 'month', true, true), 'August')
  assert.equal(bucketLabelShort(AUG, 'month', false, false), '2026 年 8 月')
  assert.equal(bucketLabelShort(AUG, 'quarter', true, true), 'Q3')
  // 年粒度永远带年份，短不了
  assert.equal(bucketLabelShort(AUG, 'year', false, true), '2026 年')
})

test('bucketKey 同一时刻恒等，空值归空串', () => {
  assert.equal(bucketKey(AUG), bucketKey(new Date(AUG)))
  assert.equal(bucketKey(null), '')
  assert.equal(bucketKey(''), '')
})
