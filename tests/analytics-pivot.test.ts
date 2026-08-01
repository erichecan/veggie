import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPivot, DIMENSION_DEFS, DIMENSION_OPTIONS, PIVOT_MAX_COLS, PivotTooManyColumnsError,
  type PivotRawCell,
} from '../lib/analytics/pivot'

test('DIMENSION_DEFS 覆盖 7 个维度，时间桶维度标记正确', () => {
  const keys = Object.keys(DIMENSION_DEFS).sort()
  assert.deepEqual(keys, ['category', 'customer', 'day', 'month', 'product', 'salesUser', 'week'])
  assert.equal(DIMENSION_DEFS.day.isTimeBucket, true)
  assert.equal(DIMENSION_DEFS.week.isTimeBucket, true)
  assert.equal(DIMENSION_DEFS.month.isTimeBucket, true)
  assert.equal(DIMENSION_DEFS.product.isTimeBucket, false)
  assert.equal(DIMENSION_DEFS.category.isTimeBucket, false)
  assert.equal(DIMENSION_DEFS.customer.isTimeBucket, false)
  assert.equal(DIMENSION_DEFS.salesUser.isTimeBucket, false)
})

test('DIMENSION_OPTIONS 顺序与 DIMENSION_DEFS 一一对应，供前端下拉直接渲染', () => {
  const optionKeys = DIMENSION_OPTIONS.map((o) => o.key).sort()
  const defKeys = Object.keys(DIMENSION_DEFS).sort()
  assert.deepEqual(optionKeys, defKeys)
})

test('空数组 → 全零结果，不除以零', () => {
  const result = buildPivot([], { rowIsTimeBucket: false, colIsTimeBucket: false })
  assert.deepEqual(result, {
    rows: [], cols: [], cells: [],
    grandTotal: { qty: 0, revenueExTax: 0, cost: 0, grossProfit: 0, marginPct: 0 },
  })
})

function cell(rowKey: string, rowName: string, colKey: string, colName: string, revenueExTax: number, cost: number, qty: number): PivotRawCell {
  return { rowKey, rowName, colKey, colName, revenueExTax, cost, qty, grossProfit: revenueExTax - cost }
}

test('2x2 矩阵：行/列小计和总计按业务维度正确累加', () => {
  const raw: PivotRawCell[] = [
    cell('cust_a', 'A 客户', 'p_1', '洋葱', 100, 80, 10),
    cell('cust_a', 'A 客户', 'p_2', '土豆', 50, 40, 5),
    cell('cust_b', 'B 客户', 'p_1', '洋葱', 200, 100, 20),
  ]
  const result = buildPivot(raw, { rowIsTimeBucket: false, colIsTimeBucket: false })

  assert.deepEqual(result.rows.map((r) => r.key), ['cust_b', 'cust_a'])
  assert.equal(result.rows.find((r) => r.key === 'cust_a')!.subtotal.revenueExTax, 150)
  assert.equal(result.rows.find((r) => r.key === 'cust_a')!.subtotal.grossProfit, 30)
  assert.equal(result.rows.find((r) => r.key === 'cust_a')!.subtotal.marginPct, 20)

  assert.deepEqual(result.cols.map((c) => c.key), ['p_1', 'p_2'])
  assert.equal(result.cols.find((c) => c.key === 'p_1')!.subtotal.revenueExTax, 300)

  assert.equal(result.grandTotal.revenueExTax, 350)
  assert.equal(result.grandTotal.grossProfit, 130)
  assert.equal(result.grandTotal.qty, 35)

  const cellAP1 = result.cells.find((c) => c.rowKey === 'cust_a' && c.colKey === 'p_1')!
  assert.equal(cellAP1.revenueExTax, 100)
  assert.equal(cellAP1.grossProfit, 20)
  assert.equal(cellAP1.marginPct, 20)
})

test('时间桶维度按 key 字典序（即时间正序）排列，不按销售额排', () => {
  const raw: PivotRawCell[] = [
    cell('cust_a', 'A 客户', '2026-03', '2026年3月', 500, 300, 1),
    cell('cust_a', 'A 客户', '2026-01', '2026年1月', 10, 5, 1),
    cell('cust_a', 'A 客户', '2026-02', '2026年2月', 100, 50, 1),
  ]
  const result = buildPivot(raw, { rowIsTimeBucket: false, colIsTimeBucket: true })
  assert.deepEqual(result.cols.map((c) => c.key), ['2026-01', '2026-02', '2026-03'])
})

test('行是时间桶时同样按时间正序，不受销售额影响', () => {
  const raw: PivotRawCell[] = [
    cell('2026-03', '3月', 'cust_a', 'A', 500, 300, 1),
    cell('2026-01', '1月', 'cust_a', 'A', 10, 5, 1),
  ]
  const result = buildPivot(raw, { rowIsTimeBucket: true, colIsTimeBucket: false })
  assert.deepEqual(result.rows.map((r) => r.key), ['2026-01', '2026-03'])
})

test('distinct 列数超过 PIVOT_MAX_COLS(60) 时抛出 PivotTooManyColumnsError', () => {
  const raw: PivotRawCell[] = Array.from({ length: PIVOT_MAX_COLS + 1 }, (_, i) =>
    cell('cust_a', 'A', `d_${i}`, `day ${i}`, 10, 5, 1))
  assert.throws(
    () => buildPivot(raw, { rowIsTimeBucket: false, colIsTimeBucket: true }),
    (err: unknown) => err instanceof PivotTooManyColumnsError && err.columnCount === PIVOT_MAX_COLS + 1,
  )
})

test('单元格销售额为 0 时毛利率记 0，不是 NaN/Infinity', () => {
  const raw: PivotRawCell[] = [cell('cust_a', 'A', 'p_1', '洋葱', 0, 0, 0)]
  const result = buildPivot(raw, { rowIsTimeBucket: false, colIsTimeBucket: false })
  assert.equal(result.cells[0].marginPct, 0)
  assert.equal(result.rows[0].subtotal.marginPct, 0)
})
