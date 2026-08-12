/**
 * 供应商结算口径（台账 G2）
 * ============================================================================
 * 分批付款的余额递减、超付拒绝、账龄分桶 —— 三件事各自钉住。
 * 账龄这一层是**给校验脚本用的第二实现**：接口那边在 SQL 里分桶，
 * 校验脚本在 JS 里独立算一遍再比对，两边一致才叫「账龄与明细一致」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyVendorPayment, agingBucketOf, summarizeAging } from '../lib/finance/vendor-settlement'

test('applyVendorPayment: 三笔付清，余额逐笔递减', () => {
  const total = 300
  const a = applyVendorPayment({ totalIncTax: total, paidSoFar: 0, amount: 100 })
  assert.equal(a.newPaid, 100); assert.equal(a.newDue, 200); assert.equal(a.fullyPaid, false)
  const b = applyVendorPayment({ totalIncTax: total, paidSoFar: a.newPaid, amount: 150 })
  assert.equal(b.newPaid, 250); assert.equal(b.newDue, 50); assert.equal(b.fullyPaid, false)
  const c = applyVendorPayment({ totalIncTax: total, paidSoFar: b.newPaid, amount: 50 })
  assert.equal(c.newPaid, 300); assert.equal(c.newDue, 0); assert.equal(c.fullyPaid, true)
})

test('applyVendorPayment: 超付被拒，且账单原样不动（不截断成刚好付清）', () => {
  const r = applyVendorPayment({ totalIncTax: 100, paidSoFar: 90, amount: 20 })
  assert.match(r.error ?? '', /付款超额/)
  assert.equal(r.newPaid, 90)
  assert.equal(r.newDue, 10)
})

test('applyVendorPayment: 浮点累加不该让最后一笔差一分钱付不清', () => {
  // 0.1 + 0.2 = 0.30000000000000004；不 round2 的话 due 会是 -4e-17，
  // 「付清」判定和「超额」判定都会在这种数上翻车
  const r = applyVendorPayment({ totalIncTax: 0.3, paidSoFar: 0.1, amount: 0.2 })
  assert.equal(r.newPaid, 0.3)
  assert.equal(r.newDue, 0)
  assert.equal(r.fullyPaid, true)
  assert.equal(r.error, undefined)
})

test('applyVendorPayment: 金额必须大于 0', () => {
  assert.match(applyVendorPayment({ totalIncTax: 100, paidSoFar: 0, amount: 0 }).error ?? '', /必须大于 0/)
  assert.match(applyVendorPayment({ totalIncTax: 100, paidSoFar: 0, amount: -5 }).error ?? '', /必须大于 0/)
})

test('agingBucketOf: 与 ap-aging 同一套阈值，边界逐个钉住', () => {
  const today = new Date('2026-08-12T00:00:00Z')
  assert.equal(agingBucketOf(null, today), 'unknown')
  assert.equal(agingBucketOf('2026-08-13', today), 'current')   // 未到期
  assert.equal(agingBucketOf('2026-08-12', today), 'current')   // 当天到期不算逾期
  assert.equal(agingBucketOf('2026-08-11', today), 'd1_30')
  assert.equal(agingBucketOf('2026-07-13', today), 'd1_30')     // 逾期 30 天
  assert.equal(agingBucketOf('2026-07-12', today), 'd31_60')    // 逾期 31 天
  assert.equal(agingBucketOf('2026-06-13', today), 'd31_60')    // 60 天
  assert.equal(agingBucketOf('2026-06-12', today), 'd61_90')
  assert.equal(agingBucketOf('2026-05-14', today), 'd61_90')    // 90 天
  assert.equal(agingBucketOf('2026-05-13', today), 'd90_plus')
})

test('agingBucketOf: 无法解析的日期归 unknown，不能悄悄算成 current', () => {
  assert.equal(agingBucketOf('not-a-date', new Date('2026-08-12T00:00:00Z')), 'unknown')
})

test('summarizeAging: 按供应商 × 桶汇总，同桶累加', () => {
  const today = new Date('2026-08-12T00:00:00Z')
  const m = summarizeAging([
    { supplierId: 's1', amountDue: 100, dueDate: '2026-08-20' },
    { supplierId: 's1', amountDue: 50.5, dueDate: '2026-08-30' },
    { supplierId: 's1', amountDue: 20, dueDate: '2026-07-01' },
    { supplierId: 's2', amountDue: 7, dueDate: null },
  ], today)
  assert.equal(m.get('s1|current'), 150.5)
  assert.equal(m.get('s1|d31_60'), 20)
  assert.equal(m.get('s2|unknown'), 7)
  assert.equal(m.size, 3)
})
