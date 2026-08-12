/**
 * 客户对账单口径（台账 G1）
 * ============================================================================
 * 四处生成错位在这里各钉一条，避免以后被"顺手改回去"：
 * 末日整天要算进来 / 日界按业务时区 / 期末恒等式 / 核对差额分开报。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveStatementPeriod, summarizeStatement, reconcileStatement,
  paymentSource, paymentTripId, StatementInputError,
} from '../lib/finance/statement'

const iso = (d: Date) => d.toISOString()

test('resolveStatementPeriod: 末日整天必须包含在内（右开到次日 00:00）', () => {
  const p = resolveStatementPeriod('2026-08-01', '2026-08-31')
  // 都柏林 8-31 23:00（= UTC 22:00，夏令时 UTC+1）的单必须落在区间内 ——
  // 原实现 `lte: new Date('2026-08-31')` 的上界是 UTC 00:00 = 都柏林 01:00，
  // 末日 23 个小时的单全被切掉
  const lateOnLastDay = new Date('2026-08-31T22:00:00.000Z')
  assert.ok(lateOnLastDay >= p.start && lateOnLastDay < p.endExclusive,
    `末日晚间应在期内：${iso(p.start)} ~ ${iso(p.endExclusive)}`)
  const oldBuggyUpperBound = new Date('2026-08-31T00:00:00.000Z')
  assert.ok(lateOnLastDay > oldBuggyUpperBound, '这条正是原实现漏掉的那批单')
  // 次月第一天不能算进来
  assert.ok(new Date('2026-09-01T12:00:00.000Z') >= p.endExclusive)
})

test('resolveStatementPeriod: 单日对账合法（start == end 不是错误）', () => {
  const p = resolveStatementPeriod('2026-08-12', '2026-08-12')
  assert.ok(p.endExclusive > p.start)
  assert.equal(Math.round((p.endExclusive.getTime() - p.start.getTime()) / 3600000), 24)
})

test('resolveStatementPeriod: 日界按业务时区（都柏林），不按进程时区', () => {
  // 夏令时（IST=UTC+1）下，都柏林 8-01 00:00 == UTC 7-31 23:00
  const p = resolveStatementPeriod('2026-08-01', '2026-08-31')
  assert.equal(iso(p.start), '2026-07-31T23:00:00.000Z')
})

test('resolveStatementPeriod: 起止颠倒与非法日期都要报错', () => {
  assert.throws(() => resolveStatementPeriod('2026-08-31', '2026-08-01'), StatementInputError)
  assert.throws(() => resolveStatementPeriod('not-a-date', '2026-08-01'), StatementInputError)
})

test('summarizeStatement: 期末 = 期初 + 销售 − 收款，且金额两位小数', () => {
  const s = summarizeStatement(
    120.5,
    [{ id: 'o1', incTaxTotal: 33.33 }, { id: 'o2', incTaxTotal: 66.67 }],
    [{ id: 'p1', invoiceId: 'i1', amount: 50 }, { id: 'p2', invoiceId: 'i1', amount: 20.25 }],
  )
  assert.equal(s.totalSales, 100)
  assert.equal(s.totalPayments, 70.25)
  assert.equal(s.closingBalance, 150.25)
  assert.deepEqual(s.orderIds, ['o1', 'o2'])
  assert.deepEqual(s.invoiceIds, ['i1'])   // 同一发票两笔收款只记一次
})

test('summarizeStatement: 期初可以是负数（客户预付），不当成 0', () => {
  const s = summarizeStatement(-200, [{ id: 'o1', incTaxTotal: 50 }], [])
  assert.equal(s.closingBalance, -150)
})

test('reconcileStatement: 完全对上时 ok=true 且无问题项', () => {
  const r = reconcileStatement({
    stored: { openingBalance: 10, totalSales: 100, totalPayments: 40, closingBalance: 70 },
    orders: [{ id: 'o1', incTaxTotal: 60 }, { id: 'o2', incTaxTotal: 40 }],
    payments: [{ id: 'p1', invoiceId: 'i1', amount: 40 }],
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.problems, [])
  assert.equal(r.salesFromOrders, 100)
})

test('reconcileStatement: 明细被改动后差额指向销售侧，不牵连其它两项', () => {
  const r = reconcileStatement({
    stored: { openingBalance: 0, totalSales: 100, totalPayments: 0, closingBalance: 100 },
    orders: [{ id: 'o1', incTaxTotal: 97 }],   // 生成后订单被改小了 3 元
    payments: [],
  })
  assert.equal(r.ok, false)
  assert.equal(r.salesDiff, -3)
  assert.equal(r.paymentsDiff, 0)
  assert.equal(r.closingDiff, 0)              // 恒等式本身仍成立
  assert.equal(r.problems.length, 1)
})

test('reconcileStatement: 期末余额算错时单独报出来', () => {
  const r = reconcileStatement({
    stored: { openingBalance: 10, totalSales: 100, totalPayments: 40, closingBalance: 999 },
    orders: [{ id: 'o1', incTaxTotal: 100 }],
    payments: [{ id: 'p1', invoiceId: 'i1', amount: 40 }],
  })
  assert.equal(r.ok, false)
  assert.equal(r.closingExpected, 70)
  assert.equal(r.closingDiff, -929)
  assert.match(r.problems[0], /期初 \+ 销售 − 收款/)
})

test('reconcileStatement: 半分以内的浮点误差不算差异', () => {
  const r = reconcileStatement({
    stored: { openingBalance: 0, totalSales: 100.01, totalPayments: 0, closingBalance: 100.01 },
    orders: [{ id: 'o1', incTaxTotal: 33.34 }, { id: 'o2', incTaxTotal: 33.34 }, { id: 'o3', incTaxTotal: 33.33 }],
    payments: [],
  })
  assert.equal(r.ok, true)
})

test('paymentSource: 司机交账写的 TRIP 标记能认出来，并取得行程 id', () => {
  assert.equal(paymentSource('司机交账核销 · 老王饭店 · TRIP:cmsp123abc'), 'DRIVER_CASH')
  assert.equal(paymentTripId('司机交账核销 · 老王饭店 · TRIP:cmsp123abc'), 'cmsp123abc')
  assert.equal(paymentSource('客户银行汇款'), 'MANUAL')
  assert.equal(paymentSource(null), 'MANUAL')
  assert.equal(paymentTripId('客户银行汇款'), null)
})
