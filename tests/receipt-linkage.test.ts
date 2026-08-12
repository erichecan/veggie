import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  arrivalDelay,
  describeArrivalDelay,
  describeArrivalDelayEn,
  isUnlinkedInbound,
  summarizeOnTime,
} from '../lib/receipt-linkage'

describe('未关联入库的判据', () => {
  test('收货单来的入库算有据可查', () => {
    assert.equal(isUnlinkedInbound({ type: 'IN', qty: 10, sourceType: 'GOODS_RECEIPT' }), false)
    assert.equal(isUnlinkedInbound({ type: 'IN', qty: 10, sourceType: 'RECEIPT_DAMAGE' }), false)
  })

  test('销售侧的退回/释放也算有据可查（不是「收了没单的货」）', () => {
    assert.equal(isUnlinkedInbound({ type: 'IN', qty: 5, sourceType: 'ORDER' }), false)
    assert.equal(isUnlinkedInbound({ type: 'IN', qty: 5, sourceType: 'RETURN' }), false)
  })

  test('手工调整 / 导入 / 没写来源的入库要被揪出来', () => {
    assert.equal(isUnlinkedInbound({ type: 'IN', qty: 5, sourceType: 'MANUAL' }), true)
    assert.equal(isUnlinkedInbound({ type: 'IN', qty: 5, sourceType: null }), true)
    assert.equal(isUnlinkedInbound({ type: 'ADJUSTMENT', qty: 5, sourceType: 'STOCK_TAKE' }), true)
  })

  test('出库方向一律不算（负数调整是盘亏，不是「进来的货」）', () => {
    assert.equal(isUnlinkedInbound({ type: 'ADJUSTMENT', qty: -5, sourceType: 'STOCK_TAKE' }), false)
    assert.equal(isUnlinkedInbound({ type: 'OUT', qty: -5, sourceType: 'ORDER' }), false)
    assert.equal(isUnlinkedInbound({ type: 'SCRAP', qty: -5, sourceType: 'SCRAP' }), false)
  })

  test('⛔ 白名单反选：将来新增的入库来源默认落进「未关联」被看见，而不是静默漏掉', () => {
    assert.equal(isUnlinkedInbound({ type: 'IN', qty: 1, sourceType: 'SOME_FUTURE_SOURCE' }), true)
  })

  test('期初余额不算「未关联」——一次性建账事件，不排掉会把真正的问题淹了', () => {
    assert.equal(
      isUnlinkedInbound({ type: 'ADJUSTMENT', qty: 500, sourceType: 'ADJUSTMENT', sourceRef: 'OPENING-BALANCE' }),
      false,
    )
    // 但同类型、没有期初标记的正数调整仍要被揪出来（悄悄塞货最可能的路径）
    assert.equal(
      isUnlinkedInbound({ type: 'ADJUSTMENT', qty: 500, sourceType: 'ADJUSTMENT', sourceRef: 'SOMETHING-ELSE' }),
      true,
    )
  })
})

describe('预计 vs 实际到货', () => {
  test('同一天 = 按期', () => {
    const d = arrivalDelay('2026-08-10', '2026-08-10')
    assert.equal(d.timing, 'ON_TIME')
    assert.equal(d.days, 0)
    assert.equal(describeArrivalDelay(d), '按期到货')
  })

  test('晚到几天算正数', () => {
    const d = arrivalDelay('2026-08-10', '2026-08-13')
    assert.equal(d.timing, 'LATE')
    assert.equal(d.days, 3)
    assert.equal(describeArrivalDelay(d), '迟到 3 天')
    assert.equal(describeArrivalDelayEn(d), '3 day(s) late')
  })

  test('早到算负数', () => {
    const d = arrivalDelay('2026-08-10', '2026-08-08')
    assert.equal(d.timing, 'EARLY')
    assert.equal(d.days, -2)
    assert.equal(describeArrivalDelay(d), '提前 2 天')
  })

  test('只比日期部分：差几小时不该被算成迟到一天', () => {
    const d = arrivalDelay('2026-08-10T00:00:00.000Z', '2026-08-10T23:59:00.000Z')
    assert.equal(d.days, 0)
    assert.equal(d.timing, 'ON_TIME')
  })

  test('Date 对象与字符串等价', () => {
    assert.deepEqual(
      arrivalDelay(new Date('2026-08-10T00:00:00Z'), new Date('2026-08-12T00:00:00Z')),
      arrivalDelay('2026-08-10', '2026-08-12'),
    )
  })

  test('⛔ 采购单没填预计到货日 → UNKNOWN，不拿今天或创建日顶替', () => {
    const d = arrivalDelay(null, '2026-08-10')
    assert.equal(d.timing, 'UNKNOWN')
    assert.equal(d.days, null)
    assert.equal(describeArrivalDelay(d), null, '没有依据时不该输出任何时效文案')
  })

  test('跨月跨年也按真实天数算', () => {
    assert.equal(arrivalDelay('2026-12-30', '2027-01-02').days, 3)
    assert.equal(arrivalDelay('2026-02-27', '2026-03-01').days, 2, '2026 不是闰年')
  })
})

describe('到货准时率（台账 E7）', () => {
  const po = (expected: string | null, last: string | null, fully: boolean) =>
    ({ expectedDate: expected, lastArrivedAt: last, fullyReceived: fully })

  test('按期与提前都算准时，迟到不算', () => {
    const s = summarizeOnTime([
      po('2026-08-10', '2026-08-10', true),   // 按期
      po('2026-08-10', '2026-08-08', true),   // 提前
      po('2026-08-10', '2026-08-14', true),   // 迟到
    ])
    assert.equal(s.measured, 3)
    assert.equal(s.onTime, 1)
    assert.equal(s.early, 1)
    assert.equal(s.late, 1)
    assert.equal(s.rate, 0.667)
  })

  test('⛔ 未收齐的单不进分母 —— 否则一张永远收不齐的单会被算成「按期」', () => {
    const s = summarizeOnTime([
      po('2026-08-10', '2026-08-09', true),
      po('2026-08-10', '2026-08-09', false),  // 到了一部分，还没收齐
    ])
    assert.equal(s.measured, 1, '只有收齐的那张进分母')
    assert.equal(s.pending, 1)
    assert.equal(s.rate, 1)
  })

  test('⛔ 没填预计到货日的单单独计数，不拿下单日顶替', () => {
    const s = summarizeOnTime([po(null, '2026-08-09', true)])
    assert.equal(s.noExpected, 1)
    assert.equal(s.measured, 0)
    assert.equal(s.rate, null, '没有可判定的单时是 null，不是 0')
  })

  test('⛔ 一单可判定都没有时 rate 是 null 而不是 0 —— 0% 会被读成「这家从不准时」', () => {
    assert.equal(summarizeOnTime([]).rate, null)
    assert.equal(summarizeOnTime([po('2026-08-10', null, false)]).rate, null)
  })

  test('收齐但没有到货日（数据异常）按未收齐处理，不硬判', () => {
    const s = summarizeOnTime([po('2026-08-10', null, true)])
    assert.equal(s.measured, 0)
    assert.equal(s.pending, 1)
  })
})
