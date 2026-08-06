/**
 * resolveDateRange / toDayKey 的时区口径。
 *
 * 由来（2026-08-06 实测）：原实现用 `new Date('2026-01-01')` 再 `.setHours(0,0,0,0)`。
 * 前者按 **UTC** 解析 date-only 字符串，后者按**运行环境本地时区**生效 —— 两者不一致
 * 时整个范围会偏一天。生产容器是 UTC 所以碰巧不显现，但：
 *   1. 本地开发（如 UTC-4）实测差 19 小时，会把 2025-12 的数据串进 2026-01 的查询
 *   2. 更要紧的是业务口径：客户是爱尔兰实体，日报/波次/交账都按**都柏林**的业务日
 *      切分，而按 UTC 切会把 1,909 张订单（占 1.27%）算到相邻的错误日期上
 *
 * 所以这里锁死两件事：**结果与运行环境时区无关**，且**边界按 Europe/Dublin**。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDateRange, toDayKey, BUSINESS_TIMEZONE } from '../lib/analytics/metrics'

/** 在指定 TZ 下跑一段逻辑。Node 会在 process.env.TZ 变化后重建时区缓存。 */
function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ
  process.env.TZ = tz
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
}

describe('resolveDateRange 时区口径', () => {
  test('业务时区是都柏林', () => {
    assert.equal(BUSINESS_TIMEZONE, 'Europe/Dublin')
  })

  test('夏令时：from=2026-07-21 的起点是都柏林当日 00:00（= 前一日 23:00 UTC）', () => {
    const { start } = resolveDateRange('2026-07-21', '2026-07-21')
    // 爱尔兰 7 月是 IST（UTC+1）
    assert.equal(start.toISOString(), '2026-07-20T23:00:00.000Z')
  })

  test('冬令时：from=2026-01-15 的起点就是当日 00:00 UTC（都柏林冬季 = UTC+0）', () => {
    const { start } = resolveDateRange('2026-01-15', '2026-01-15')
    assert.equal(start.toISOString(), '2026-01-15T00:00:00.000Z')
  })

  test('to 是「含当日」，转成独占上界要 +1 天', () => {
    const { start, end } = resolveDateRange('2026-07-21', '2026-07-21')
    assert.equal((end.getTime() - start.getTime()) / 3600000, 24)
    assert.equal(end.toISOString(), '2026-07-21T23:00:00.000Z')
  })

  test('⛔ 结果与运行环境时区无关 —— 这正是原来的 bug', () => {
    const inUTC   = withTZ('UTC',              () => resolveDateRange('2026-01-01', '2026-08-01'))
    const inNY    = withTZ('America/New_York', () => resolveDateRange('2026-01-01', '2026-08-01'))
    const inTokyo = withTZ('Asia/Tokyo',       () => resolveDateRange('2026-01-01', '2026-08-01'))
    assert.equal(inNY.start.toISOString(), inUTC.start.toISOString())
    assert.equal(inNY.end.toISOString(), inUTC.end.toISOString())
    assert.equal(inTokyo.start.toISOString(), inUTC.start.toISOString())
    assert.equal(inTokyo.end.toISOString(), inUTC.end.toISOString())
  })

  test('跨夏令时切换的区间，天数按真实钟点算（3 月最后一个周日少 1 小时）', () => {
    // 2026-03-29 是爱尔兰进入夏令时的日子
    const { start, end } = resolveDateRange('2026-03-28', '2026-03-30')
    assert.equal(start.toISOString(), '2026-03-28T00:00:00.000Z')  // 还是冬令时
    assert.equal(end.toISOString(),   '2026-03-30T23:00:00.000Z')  // 已进夏令时
    // 3 个自然日，但因为跳过 1 小时，实际只有 71 小时
    assert.equal((end.getTime() - start.getTime()) / 3600000, 71)
  })

  test('非法输入回退默认区间，且默认区间也是时区无关的', () => {
    const a = withTZ('UTC',              () => resolveDateRange('not-a-date', null))
    const b = withTZ('America/New_York', () => resolveDateRange('not-a-date', null))
    assert.equal(a.start.toISOString(), b.start.toISOString())
    assert.ok(a.end > a.start)
  })

  test('end <= start 时兜底为 1 天', () => {
    const { start, end } = resolveDateRange('2026-07-21', '2026-07-01')
    assert.ok(end > start)
    assert.equal((end.getTime() - start.getTime()) / 3600000, 24)
  })
})

describe('toDayKey 时区口径', () => {
  test('按都柏林的日期给 key，而不是 UTC 的', () => {
    // 2026-07-20T23:30Z = 都柏林 2026-07-21 00:30 → 属于 21 号这个业务日
    assert.equal(toDayKey(new Date('2026-07-20T23:30:00Z')), '2026-07-21')
    // 2026-07-21T22:30Z = 都柏林 23:30 → 仍是 21 号
    assert.equal(toDayKey(new Date('2026-07-21T22:30:00Z')), '2026-07-21')
  })

  test('冬令时下与 UTC 日期一致', () => {
    assert.equal(toDayKey(new Date('2026-01-15T23:30:00Z')), '2026-01-15')
  })

  test('⛔ 与运行环境时区无关', () => {
    const d = new Date('2026-07-20T23:30:00Z')
    assert.equal(withTZ('UTC', () => toDayKey(d)), '2026-07-21')
    assert.equal(withTZ('America/New_York', () => toDayKey(d)), '2026-07-21')
    assert.equal(withTZ('Asia/Tokyo', () => toDayKey(d)), '2026-07-21')
  })

  test('toDayKey(range.start) 应等于请求的起始日 —— 两个函数口径必须一致', () => {
    const { start } = resolveDateRange('2026-07-21', '2026-07-21')
    assert.equal(toDayKey(start), '2026-07-21')
  })
})
