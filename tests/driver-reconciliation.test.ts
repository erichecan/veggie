/**
 * 司机对账状态统计（台账 C10）—— 汇总层单测
 *
 * 这层最怕的三件事：
 *   1. **「未提交」漏掉** —— 只按日报表出行，出了车没报账的人一行都不会出现，
 *      而他恰恰是财务唯一需要去催的人。行集必须是「有行程」∪「有日报」
 *   2. **「有差异」把状态吃掉** —— 已确认且对不上的那一行最该复核，
 *      压成一个枚举就看不出它已经被谁确认过了
 *   3. **未提交被当成「报了 0」** —— 申报列填 0 的话，导出到 Excel 里
 *      「没报账」和「报了 0 元」长得一模一样
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { foldTrips, derivedKey, type DailyDerived, type TripRow } from '../lib/driver-daily-report'
import {
  buildReconciliationRows, filterReconciliationRows, summarizeReconciliation,
  reconciliationCsvRows, RECON_CSV_HEADERS,
  type ReportSnapshot,
} from '../lib/driver-reconciliation'

const derived = (over: Partial<DailyDerived> = {}): DailyDerived => ({
  tripIds: ['t1'], cashCollected: 0, onlineCollected: 0, orderTotal: 0,
  returnCount: 0, exchangeCount: 0, stopCount: 0, unsettledTripCount: 0, ...over,
})

const report = (
  driverId: string, reportDate: string, over: Partial<ReportSnapshot> = {},
): ReportSnapshot => ({
  id: `r-${driverId}-${reportDate}`, driverId, reportDate,
  cashCollected: 0, orderTotal: 0, returnCount: 0, exchangeCount: 0,
  status: 'submitted', note: null, submittedAt: null, submittedByName: '司机甲',
  confirmedAt: null, confirmedByName: null, ...over,
})

const NAMES = new Map([['d1', '司机甲'], ['d2', '司机乙']])

describe('C10 对账行集：未提交必须从行程派生', () => {
  test('有行程但没日报 → 出现一行「未提交」', () => {
    const rows = buildReconciliationRows(
      new Map([[derivedKey('d1', '2026-08-10'), derived({ cashCollected: 300 })]]),
      [],
      NAMES,
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.status, 'not_submitted')
    assert.equal(rows[0]!.driverName, '司机甲')
    // 系统值照常给出 —— 那是「该报多少」的凭据
    assert.equal(rows[0]!.system.cashCollected, 300)
  })

  test('未提交的行申报值是 null 而不是 0，且不算「有差异」', () => {
    const rows = buildReconciliationRows(
      new Map([[derivedKey('d1', '2026-08-10'), derived({ cashCollected: 300 })]]),
      [], NAMES,
    )
    assert.equal(rows[0]!.declared, null)
    assert.equal(rows[0]!.hasDiff, false, '没申报值就无从比对，混进「有差异」会把两类待办搅在一起')
    assert.deepEqual(rows[0]!.diffs, [])
  })

  test('有日报但当天没行程 → 同样出现，且差异指出「申报了钱却查无行程」', () => {
    const rows = buildReconciliationRows(
      new Map(),
      [report('d1', '2026-08-10', { cashCollected: 200 })],
      NAMES,
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.status, 'submitted')
    assert.equal(rows[0]!.system.cashCollected, 0)
    assert.equal(rows[0]!.hasDiff, true)
    assert.equal(rows[0]!.diffs[0]!.diff, 200)
  })

  test('行集是并集，不是任一单边', () => {
    const rows = buildReconciliationRows(
      new Map([
        [derivedKey('d1', '2026-08-10'), derived()],   // 有行程无日报
        [derivedKey('d2', '2026-08-10'), derived()],   // 两边都有
      ]),
      [
        report('d2', '2026-08-10'),
        report('d1', '2026-08-09'),                    // 有日报无行程
      ],
      NAMES,
    )
    assert.equal(rows.length, 3)
    const keys = rows.map(r => `${r.driverId}|${r.date}`).sort()
    assert.deepEqual(keys, ['d1|2026-08-09', 'd1|2026-08-10', 'd2|2026-08-10'])
  })

  test('司机账号被删也不吞掉这一行 —— 欠的账不会因为人走了就消失', () => {
    const rows = buildReconciliationRows(
      new Map([[derivedKey('gone', '2026-08-10'), derived()]]), [], NAMES,
    )
    assert.equal(rows[0]!.driverName, '(已删除账号)')
  })
})

describe('C10 状态与差异是两个维度', () => {
  test('已确认 + 有差异可以同时成立，状态不被差异吃掉', () => {
    const rows = buildReconciliationRows(
      new Map([[derivedKey('d1', '2026-08-10'), derived({ cashCollected: 250 })]]),
      [report('d1', '2026-08-10', {
        cashCollected: 200, status: 'confirmed',
        confirmedAt: '2026-08-11T09:00:00.000Z', confirmedByName: '财务丙',
      })],
      NAMES,
    )
    assert.equal(rows[0]!.status, 'confirmed')
    assert.equal(rows[0]!.hasDiff, true)
    assert.equal(rows[0]!.confirmedByName, '财务丙')
    assert.equal(rows[0]!.diffs[0]!.diff, -50)
  })

  test('金额 1 分以内不算差异，笔数差一笔就算', () => {
    const rows = buildReconciliationRows(
      new Map([[derivedKey('d1', '2026-08-10'), derived({ cashCollected: 100.005, returnCount: 2 })]]),
      [report('d1', '2026-08-10', { cashCollected: 100, returnCount: 3 })],
      NAMES,
    )
    const fields = rows[0]!.diffs.map(d => d.field)
    assert.deepEqual(fields, ['returnCount'])
  })

  test('日期倒序，同日按司机名', () => {
    const rows = buildReconciliationRows(
      new Map([
        [derivedKey('d2', '2026-08-09'), derived()],
        [derivedKey('d1', '2026-08-10'), derived()],
        [derivedKey('d2', '2026-08-10'), derived()],
      ]), [], NAMES,
    )
    assert.deepEqual(
      rows.map(r => `${r.date}/${r.driverName}`),
      ['2026-08-10/司机甲', '2026-08-10/司机乙', '2026-08-09/司机乙'],
    )
  })
})

describe('C10 筛选与计数', () => {
  const rows = buildReconciliationRows(
    new Map([
      [derivedKey('d1', '2026-08-10'), derived()],                          // 未提交
      [derivedKey('d2', '2026-08-10'), derived({ cashCollected: 50 })],     // 待确认 + 有差异
      [derivedKey('d1', '2026-08-09'), derived()],                          // 已确认
    ]),
    [
      report('d2', '2026-08-10', { cashCollected: 10 }),
      report('d1', '2026-08-09', { status: 'confirmed' }),
    ],
    NAMES,
  )

  test('各页签筛出的条数与角标一致 —— 两者出自同一份 rows', () => {
    const s = summarizeReconciliation(rows)
    assert.deepEqual(s, { total: 3, notSubmitted: 1, submitted: 1, confirmed: 1, hasDiff: 1 })
    assert.equal(filterReconciliationRows(rows, 'all').length, s.total)
    assert.equal(filterReconciliationRows(rows, 'not_submitted').length, s.notSubmitted)
    assert.equal(filterReconciliationRows(rows, 'submitted').length, s.submitted)
    assert.equal(filterReconciliationRows(rows, 'confirmed').length, s.confirmed)
    assert.equal(filterReconciliationRows(rows, 'has_diff').length, s.hasDiff)
  })

  test('「有差异」是横切筛选，能筛出已确认的那些', () => {
    const withConfirmedDiff = buildReconciliationRows(
      new Map([[derivedKey('d1', '2026-08-10'), derived({ orderTotal: 900 })]]),
      [report('d1', '2026-08-10', { orderTotal: 800, status: 'confirmed' })],
      NAMES,
    )
    assert.equal(filterReconciliationRows(withConfirmedDiff, 'has_diff').length, 1)
    assert.equal(filterReconciliationRows(withConfirmedDiff, 'confirmed').length, 1)
  })
})

describe('C10 导出', () => {
  test('导出行数与列数与屏幕一致，表头不多不少', () => {
    const rows = buildReconciliationRows(
      new Map([[derivedKey('d1', '2026-08-10'), derived({ cashCollected: 250 })]]),
      [report('d1', '2026-08-10', { cashCollected: 200 })], NAMES,
    )
    const csv = reconciliationCsvRows(rows)
    assert.equal(csv.length, rows.length)
    assert.equal(csv[0]!.length, RECON_CSV_HEADERS.length)
  })

  test('未提交的行申报列留空，不写 0 —— Excel 里 0 会被当成「报了 0」', () => {
    const rows = buildReconciliationRows(
      new Map([[derivedKey('d1', '2026-08-10'), derived({ cashCollected: 300 })]]), [], NAMES,
    )
    const row = reconciliationCsvRows(rows)[0]!
    const idx = RECON_CSV_HEADERS.indexOf('申报现金')
    assert.equal(row[idx], '')
    assert.equal(row[RECON_CSV_HEADERS.indexOf('系统现金')], 300)
  })

  test('确认时间不是裸 ISO 串 —— Excel 里 `…T03:16:08.508Z` 没人会去换算时区', () => {
    const rows = buildReconciliationRows(
      new Map([[derivedKey('d1', '2026-08-10'), derived()]]),
      [report('d1', '2026-08-10', {
        status: 'confirmed', confirmedAt: '2026-08-11T09:00:00.000Z', confirmedByName: '财务丙',
      })], NAMES,
    )
    const cell = String(reconciliationCsvRows(rows)[0]![RECON_CSV_HEADERS.indexOf('确认时间')])
    assert.ok(cell.length > 0, '确认过的行必须有确认时间')
    assert.ok(!/T\d{2}:\d{2}.*Z$/.test(cell), `仍是 ISO 串：${cell}`)
  })

  test('差异列给出带符号的差额', () => {
    const rows = buildReconciliationRows(
      new Map([[derivedKey('d1', '2026-08-10'), derived({ cashCollected: 250 })]]),
      [report('d1', '2026-08-10', { cashCollected: 200 })], NAMES,
    )
    const row = reconciliationCsvRows(rows)[0]!
    assert.equal(row[RECON_CSV_HEADERS.indexOf('现金差异')], -50)
  })
})

describe('C10 与司机端共用同一份折叠逻辑', () => {
  const trip = (over: Partial<TripRow> = {}): TripRow => ({
    id: 't1', cashCollected: 0, onlineCollected: 0, totalPayment: 0,
    settlementStatus: 'submitted', restaurants: [], ...over,
  })

  test('foldTrips 是唯一聚合口 —— 区间版与单日版都经由它', () => {
    const d = foldTrips([
      trip({ id: 'a', cashCollected: 100.1, totalPayment: 200 }),
      trip({
        id: 'b', cashCollected: 50.2, totalPayment: 300, settlementStatus: 'pending',
        restaurants: [{
          delivered: true,
          returns: [{ actionType: 'exchange' }, { actionType: 'return' }],
        }],
      }),
    ])
    assert.deepEqual(d.tripIds, ['a', 'b'])
    assert.equal(d.cashCollected, 150.3, '浮点累加后必须回到分')
    assert.equal(d.orderTotal, 500)
    assert.equal(d.exchangeCount, 1)
    assert.equal(d.returnCount, 1)
    assert.equal(d.stopCount, 1)
    assert.equal(d.unsettledTripCount, 1)
  })

  test('settlementStatus 为 null 也算未交账 —— 漏掉的话「都交齐了」是假的', () => {
    assert.equal(foldTrips([trip({ settlementStatus: null })]).unsettledTripCount, 1)
  })
})
