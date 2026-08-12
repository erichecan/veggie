/**
 * D8 四个日指标的口径单测（日销售额 / 关键商品销量 / 客单价 / 缺货率）。
 *
 * 这里只测**纯函数那一层**：区间汇总、客单价、缺货率、业务日边界。
 * 数据库聚合那一层由 scripts/audit/daily-metrics-test.ts 走真 HTTP 交叉核对
 * —— 单测证明公式对，端到端证明公式真被用上了（B2 的教训：代码全实现、
 * 单测全过，对 15 万单产出 0）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  addBusinessDays,
  businessDayRange,
  businessDayStart,
  businessTodayStart,
  deriveAov,
  deriveShortageRate,
  summarizeSalesSeries,
  toDayKey,
} from '../lib/analytics/metrics'

/** 在指定进程时区下跑一段逻辑 —— 结果必须与它无关 */
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

describe('区间汇总（日销售额 + 客单价）', () => {
  const series = [
    { salesExTax: 1000, salesIncTax: 1135, orderCount: 10 },
    { salesExTax: 50, salesIncTax: 56.75, orderCount: 1 },
    { salesExTax: 0, salesIncTax: 0, orderCount: 0 },
  ]

  test('销售额与订单数是逐日累加', () => {
    const s = summarizeSalesSeries(series)
    assert.equal(s.salesExTax, 1050)
    assert.equal(s.salesIncTax, 1191.75)
    assert.equal(s.orderCount, 11)
  })

  test('⛔ 区间客单价 = Σ销售额 / Σ订单数，不是「每天客单价的平均」', () => {
    const s = summarizeSalesSeries(series)
    // 正确：1050 / 11 = 95.45
    assert.equal(s.aov, 95.45)
    // 错误做法（每天客单价再平均）会得到 (100 + 50 + 0)/3 = 50 —— 只有 1 单的那天
    // 与有 10 单的那天等权，把均价拉得面目全非
    const avgOfAvg = series.reduce((acc, p) => acc + deriveAov(p.salesExTax, p.orderCount), 0) / series.length
    assert.notEqual(s.aov, Math.round(avgOfAvg * 100) / 100)
  })

  test('空区间不报错也不除零', () => {
    const s = summarizeSalesSeries([])
    assert.deepEqual(s, { salesExTax: 0, salesIncTax: 0, orderCount: 0, aov: 0 })
  })

  test('浮点累加后仍收敛到分（0.1+0.2 那类误差不许透出去）', () => {
    const s = summarizeSalesSeries([
      { salesExTax: 0.1, salesIncTax: 0.1, orderCount: 1 },
      { salesExTax: 0.2, salesIncTax: 0.2, orderCount: 1 },
    ])
    assert.equal(s.salesExTax, 0.3)
  })
})

describe('缺货率', () => {
  test('缺货行 / 订单行，保留 4 位', () => {
    assert.equal(deriveShortageRate(3, 400), 0.0075)
  })

  test('那天没有订单行时记 0 —— 不能记成 100%', () => {
    assert.equal(deriveShortageRate(0, 0), 0)
    assert.equal(deriveShortageRate(5, 0), 0)
  })

  test('全缺 = 1', () => {
    assert.equal(deriveShortageRate(7, 7), 1)
  })
})

describe('业务日边界（都柏林），与进程时区无关', () => {
  // 2026-08-01 是夏令时（IST = UTC+1）：都柏林当日 00:00 = 前一天 23:00 UTC
  const summerNoonUtc = new Date('2026-08-01T12:00:00.000Z')
  // 2026-01-15 是标准时（GMT = UTC+0）：都柏林当日 00:00 = 同日 00:00 UTC
  const winterNoonUtc = new Date('2026-01-15T12:00:00.000Z')

  test('夏令时：业务日 00:00 是前一天 23:00 UTC', () => {
    for (const tz of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
      withTZ(tz, () => {
        assert.equal(
          businessDayStart(summerNoonUtc).toISOString(), '2026-07-31T23:00:00.000Z',
          `TZ=${tz} 时业务日起点算错了`,
        )
      })
    }
  })

  test('标准时：业务日 00:00 与 UTC 午夜重合', () => {
    assert.equal(businessDayStart(winterNoonUtc).toISOString(), '2026-01-15T00:00:00.000Z')
  })

  test('业务日区间恰好 24 小时，且上界是次日 00:00（独占）', () => {
    const { start, end } = businessDayRange(summerNoonUtc)
    assert.equal(end.getTime() - start.getTime(), 24 * 3600 * 1000)
    assert.equal(end.toISOString(), '2026-08-01T23:00:00.000Z')
  })

  test('⛔ 夏令时期间「都柏林 00:30」属于当天，不属于前一天', () => {
    // 都柏林 2026-08-01 00:30 = UTC 2026-07-31 23:30
    const at = new Date('2026-07-31T23:30:00.000Z')
    assert.equal(toDayKey(at), '2026-08-01')
    const { start, end } = businessDayRange(at)
    assert.ok(at >= start && at < end, '该时刻应落在 8/1 这个业务日内')
    assert.equal(toDayKey(start), '2026-08-01')
    // 这正是按 UTC 切会算错的那批单（生产副本 1909/149859 = 1.27%）：
    // 按 UTC 日切，这一刻会被算进 7/31
    assert.notEqual(at.toISOString().slice(0, 10), toDayKey(at))
  })

  test('夏令时切换当天（10/25 回拨）的日长是 25 小时，边界仍对齐 00:00', () => {
    const at = new Date('2026-10-25T12:00:00.000Z')
    const { start, end } = businessDayRange(at)
    assert.equal(toDayKey(start), '2026-10-25')
    assert.equal((end.getTime() - start.getTime()) / 3600000, 25)
  })

  test('加减天数跨夏令时切换仍落在 00:00', () => {
    const oct24 = new Date('2026-10-24T12:00:00.000Z')
    const next = addBusinessDays(oct24, 1)
    assert.equal(toDayKey(next), '2026-10-25')
    const back = addBusinessDays(next, -1)
    assert.equal(toDayKey(back), '2026-10-24')
  })

  test('businessTodayStart 就是「现在」所属业务日的起点', () => {
    const now = new Date()
    const t = businessTodayStart()
    assert.equal(toDayKey(t), toDayKey(now))
    assert.ok(t <= now)
    assert.ok(businessDayRange(now).end > now)
  })
})
