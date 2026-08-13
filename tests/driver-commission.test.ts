/**
 * 司机提成考核报表 —— 纯函数单测（台账 H3）
 *
 * SQL 聚合那部分由 `scripts/audit/driver-commission-test.ts` 打真库验证；
 * 这里只守两件在 UI 里最容易悄悄坏掉的事：导出的 CSV 与屏幕上是同一份数字，
 * 以及交叉表里「没跑车」和「跑了但为 0」不会被混成一格。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detailToCsv, pivotPeriods } from '../lib/analytics/driver-commission'
import type { DriverCommissionDetailRow, DriverPeriodRow } from '../lib/analytics/driver-commission'

function row(over: Partial<DriverCommissionDetailRow> = {}): DriverCommissionDetailRow {
  return {
    orderId: 'o1', orderCode: 'OP-001', bizDate: '2026-08-11',
    driverId: 'd1', driverName: 'BAO', tripId: 't1', tripName: 'PM',
    restaurantName: 'Achara', orderStatus: 'COMPLETED',
    deliveredSubtotal: 200, itemTotal: 10, fixedFee: 5, rateTotal: 4,
    computedTotal: 19, frozenTotal: 19, frozenAt: '2026-08-11T10:00:00.000Z', diff: 0,
    ...over,
  }
}

test('CSV：表头 + 每行一条，数字不带货币符号（Excel 要能直接求和）', () => {
  const csv = detailToCsv([row(), row({ orderId: 'o2', orderCode: 'OP-002' })])
  const lines = csv.split('\n')
  assert.equal(lines.length, 3)
  assert.ok(lines[0]!.includes('件提成'))
  assert.ok(lines[1]!.includes('19'))
  assert.ok(!lines[1]!.includes('€'))
})

test('CSV：前置 BOM，否则 Excel 把中文列头读成乱码', () => {
  assert.equal(detailToCsv([]).charCodeAt(0), 0xfeff)
})

test('CSV：含逗号/引号/换行的客户名被正确转义', () => {
  const csv = detailToCsv([row({ restaurantName: 'A, "B"\nC' })])
  assert.ok(csv.includes('"A, ""B""\nC"'))
  // 转义后整行的字段数仍是 12（逗号没有把一列劈成两列）
  const dataPart = csv.slice(csv.indexOf('\n') + 1)
  assert.equal(dataPart.split('"')[0]!.split(',').length - 1, 3)
})

test('CSV：未冻结的单在冻结列写「未冻结」，不是 0', () => {
  const csv = detailToCsv([row({ frozenAt: null, frozenTotal: null, diff: 19 })])
  assert.ok(csv.includes('未冻结'))
})

test('CSV：orderCode 为空时退回订单 id，不留空格', () => {
  const csv = detailToCsv([row({ orderCode: null, orderId: 'abc123' })])
  assert.ok(csv.includes('abc123'))
})

const p = (period: string, driverName: string, computedTotal: number): DriverPeriodRow =>
  ({ period, driverName, driverId: driverName, orderCount: 1, computedTotal, frozenTotal: computedTotal })

test('透视：行=周期升序、列=司机字典序', () => {
  const t = pivotPeriods([p('2026-08-12', 'SEAN', 3), p('2026-08-11', 'BAO', 1)])
  assert.deepEqual(t.periods, ['2026-08-11', '2026-08-12'])
  assert.deepEqual(t.drivers, ['BAO', 'SEAN'])
})

test('透视：没跑车的格是 undefined，不是 0 —— 两者含义不同', () => {
  const t = pivotPeriods([p('2026-08-11', 'BAO', 10), p('2026-08-11', 'SEAN', 0)])
  assert.equal(t.cell('2026-08-11', 'BAO')?.computedTotal, 10)
  assert.equal(t.cell('2026-08-11', 'SEAN')?.computedTotal, 0)   // 跑了但为 0
  assert.equal(t.cell('2026-08-12', 'BAO'), undefined)            // 那天没跑
})

test('透视：行合计 = 该周期全部司机之和，且按分保留两位', () => {
  const t = pivotPeriods([p('2026-08-11', 'BAO', 10.005), p('2026-08-11', 'SEAN', 0.1)])
  assert.equal(t.rowTotal('2026-08-11'), 10.11)
  assert.equal(t.rowTotal('2026-08-99'), 0)
})

test('透视：空输入不炸', () => {
  const t = pivotPeriods([])
  assert.deepEqual(t.periods, [])
  assert.deepEqual(t.drivers, [])
  assert.equal(t.cell('x', 'y'), undefined)
})
