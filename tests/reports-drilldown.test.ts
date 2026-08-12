/**
 * 报表下钻（台账 H2）
 * ============================================================================
 * 下钻 = 原查询 + 多一个分组维度 + 把范围锁死在被点的那一行。
 * 这里把「锁」的语义逐条钉住 —— 锁错了不会报错，只会让子行合计对不上父行，
 * 而两个数字都"看起来挺合理"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDrillRequest, rowFilterFor, rowFieldAlias, rowKeyOf, drillCandidates, intervalRange,
} from '../lib/reports/drilldown'

test('rowFieldAlias: 日期维度的列名带 interval 后缀（与 sql-builder 的别名一致）', () => {
  assert.equal(rowFieldAlias({ field: 'product_name' }), 'product_name')
  assert.equal(rowFieldAlias({ field: 'order_date', interval: 'month' }), 'order_date_month')
})

test('rowFilterFor: 普通维度按等值锁', () => {
  const f = rowFilterFor({ field: 'supplier_name' }, { supplier_name: '本地有机农场' })
  assert.deepEqual(f, [{ field: 'supplier_name', operator: '=', value: '本地有机农场' }])
})

test('rowFilterFor: 时间桶锁成 >= 与 < 两条，绝不用 between', () => {
  const f = rowFilterFor({ field: 'order_date', interval: 'month' }, { order_date_month: '2026-08-01T00:00:00.000Z' })
  assert.equal(f?.length, 2)
  assert.deepEqual(f?.[0], { field: 'order_date', operator: '>=', value: '2026-08-01' })
  assert.deepEqual(f?.[1], { field: 'order_date', operator: '<', value: '2026-09-01' })
  // between 是闭区间，对 timestamp 列会把末日整天切掉（G1 栽过同一个坑）
  assert.ok(!f?.some(x => x.operator === 'between'))
})

test('intervalRange: 五种粒度的下一个桶起点', () => {
  assert.deepEqual(intervalRange('2026-08-12', 'day'), ['2026-08-12', '2026-08-13'])
  assert.deepEqual(intervalRange('2026-08-10', 'week'), ['2026-08-10', '2026-08-17'])
  assert.deepEqual(intervalRange('2026-12-01', 'month'), ['2026-12-01', '2027-01-01'])
  assert.deepEqual(intervalRange('2026-10-01', 'quarter'), ['2026-10-01', '2027-01-01'])
  assert.deepEqual(intervalRange('2026-01-01', 'year'), ['2026-01-01', '2027-01-01'])
})

test('rowFilterFor: 空值锁不住 → 返回 null（不能拿 `= \'\'` 去筛 NULL）', () => {
  assert.equal(rowFilterFor({ field: 'salesman' }, { salesman: null }), null)
  assert.equal(rowFilterFor({ field: 'salesman' }, { salesman: '' }), null)
  assert.equal(rowFilterFor({ field: 'salesman' }, {}), null)
})

test('buildDrillRequest: 锁住所有行维度，再按目标维度分组', () => {
  const req = buildDrillRequest({
    base: {
      rowDimensions: [{ field: 'supplier_name' }, { field: 'order_date', interval: 'month' }],
      colDimensions: [],
      measures: ['subtotal_ex_tax'],
      filters: [{ field: 'po_status', operator: '=', value: 'CONFIRMED' }],
    },
    row: { supplier_name: '南海水产', order_date_month: '2026-08-01' },
    by: { field: 'product_name' },
  })
  assert.deepEqual(req?.rowDimensions, [{ field: 'product_name' }])
  assert.deepEqual(req?.measures, ['subtotal_ex_tax'])
  // 原有筛选保留 + 三条锁（供应商 1 条 + 月份 2 条）
  assert.equal(req?.filters?.length, 4)
  assert.deepEqual(req?.filters?.[0], { field: 'po_status', operator: '=', value: 'CONFIRMED' })
  assert.deepEqual(req?.filters?.[1], { field: 'supplier_name', operator: '=', value: '南海水产' })
})

test('buildDrillRequest: 任一维度锁不住就整体放弃（宁可不给，不给假答案）', () => {
  const req = buildDrillRequest({
    base: { rowDimensions: [{ field: 'supplier_name' }, { field: 'category_name' }], colDimensions: [], measures: ['ordered_qty'] },
    row: { supplier_name: '南海水产', category_name: null },
    by: { field: 'product_name' },
  })
  assert.equal(req, null)
})

test('buildDrillRequest: 列维度原样带上（否则子行没法与父行逐格对照）', () => {
  const req = buildDrillRequest({
    base: {
      rowDimensions: [{ field: 'customer_name' }],
      colDimensions: [{ field: 'delivery_date', interval: 'week' }],
      measures: ['line_subtotal'],
    },
    row: { customer_name: '老王饭店' },
    by: { field: 'product_name' },
  })
  assert.deepEqual(req?.colDimensions, [{ field: 'delivery_date', interval: 'week' }])
})

test('drillCandidates: 排除已经在行上用过的维度', () => {
  const all = [{ field: 'a' }, { field: 'b' }, { field: 'c' }]
  assert.deepEqual(drillCandidates(all, [{ field: 'b' }]).map(d => d.field), ['a', 'c'])
})

test('rowKeyOf: 行标识按维度取值拼，排序变了也还认得同一行', () => {
  const dims = [{ field: 'supplier_name' }, { field: 'order_date', interval: 'month' as const }]
  const row = { supplier_name: '南海水产', order_date_month: '2026-08-01' }
  assert.equal(rowKeyOf(dims, row), 'supplier_name=南海水产|order_date=2026-08-01')
  // 同样的行、不同的对象顺序，key 必须一致
  assert.equal(rowKeyOf(dims, { order_date_month: '2026-08-01', supplier_name: '南海水产' }), rowKeyOf(dims, row))
})
