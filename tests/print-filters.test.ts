import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyPrintContentFilter,
  appendPrintFilterParams,
  describePrintFilter,
  filterPrintLines,
  hasContentFilter,
  keepPrintOrder,
  parseIdListParam,
} from '../lib/print/print-filters'

type L = { productId: string; qty: number }
type O = { id: string; customerId: string; lines: L[] }

const ORDERS: O[] = [
  { id: 'o1', customerId: 'cA', lines: [{ productId: 'p1', qty: 1 }, { productId: 'p2', qty: 2 }] },
  { id: 'o2', customerId: 'cB', lines: [{ productId: 'p2', qty: 3 }] },
  { id: 'o3', customerId: 'cA', lines: [{ productId: 'p3', qty: 4 }] },
  { id: 'o4', customerId: 'cC', lines: [] },
]

test('无筛选 = 原样返回，且不复制对象', () => {
  assert.equal(hasContentFilter(undefined), false)
  assert.equal(hasContentFilter({ customerIds: [], productIds: [] }), false)
  const out = applyPrintContentFilter(ORDERS, {})
  assert.equal(out, ORDERS)
})

test('客户维度：整单级筛选', () => {
  const out = applyPrintContentFilter(ORDERS, { customerIds: ['cA'] })
  assert.deepEqual(out.map(o => o.id), ['o1', 'o3'])
  // 客户筛选不动行
  assert.equal(out[0].lines.length, 2)
})

test('商品维度：行级筛选，行光了的订单整单不打', () => {
  const out = applyPrintContentFilter(ORDERS, { productIds: ['p2'] })
  assert.deepEqual(out.map(o => o.id), ['o1', 'o2'])
  assert.deepEqual(out[0].lines.map(l => l.productId), ['p2'])
  assert.deepEqual(out[1].lines.map(l => l.productId), ['p2'])
})

test('商品维度不修改原数组（返回新对象）', () => {
  applyPrintContentFilter(ORDERS, { productIds: ['p2'] })
  assert.equal(ORDERS[0].lines.length, 2, '原订单的行不能被就地砍掉')
})

test('两维组合 = 交集', () => {
  const out = applyPrintContentFilter(ORDERS, { customerIds: ['cA'], productIds: ['p2'] })
  assert.deepEqual(out.map(o => o.id), ['o1'])
  assert.deepEqual(out[0].lines.map(l => l.productId), ['p2'])
})

test('组合到空集时返回空数组而不是报错', () => {
  const out = applyPrintContentFilter(ORDERS, { customerIds: ['cB'], productIds: ['p3'] })
  assert.deepEqual(out, [])
})

test('无行数据的历史订单在商品筛选下不打（证明不了它含该商品）', () => {
  assert.equal(keepPrintOrder(ORDERS[3], { productIds: ['p1'] }), false)
  // 但只按客户筛时照打
  assert.equal(keepPrintOrder(ORDERS[3], { customerIds: ['cC'] }), true)
})

test('未知 id 不匹配任何东西，不会退化成"不筛"', () => {
  const out = applyPrintContentFilter(ORDERS, { customerIds: ['不存在'] })
  assert.deepEqual(out, [])
})

test('filterPrintLines 无商品筛选时保持引用', () => {
  const lines = ORDERS[0].lines
  assert.equal(filterPrintLines(lines, { customerIds: ['cA'] }), lines)
})

test('空串 / 空白 id 被忽略，不当成筛选条件', () => {
  assert.equal(hasContentFilter({ customerIds: [''] }), false)
  assert.deepEqual(parseIdListParam('a, ,b,'), ['a', 'b'])
  assert.equal(parseIdListParam(''), undefined)
  assert.equal(parseIdListParam(null), undefined)
  assert.equal(parseIdListParam(' , '), undefined)
})

test('查询参数编解码往返一致', () => {
  const params = new URLSearchParams()
  appendPrintFilterParams(params, { customerIds: ['c1', 'c2'], productIds: ['p9'] })
  assert.equal(params.get('customerIds'), 'c1,c2')
  assert.equal(params.get('productIds'), 'p9')
  assert.deepEqual(parseIdListParam(params.get('customerIds')), ['c1', 'c2'])

  const empty = new URLSearchParams()
  appendPrintFilterParams(empty, { customerIds: [], productIds: null })
  assert.equal(empty.toString(), '', '空筛选不该写出空参数')
})

test('纸面提示语只在筛选生效时出现，并报出实际打了多少', () => {
  assert.equal(describePrintFilter({}, {}), null)
  const s = describePrintFilter({ customerIds: ['c1'], productIds: ['p1', 'p2'] }, { customers: 1, products: 2 })
  assert.match(s ?? '', /客户 1 家/)
  assert.match(s ?? '', /商品 2 种/)
  assert.match(s ?? '', /非该批次全部内容/)
})
