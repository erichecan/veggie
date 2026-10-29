import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { sortCustomerLines, type SortableLine } from '../lib/analytics/sales-stats-sort'

// 20261028 客户需求：销售统计「按客户」加订单号 / 批次 / 司机 / AM-PM 列并能按列排序
const line = (o: Partial<SortableLine> & { productName: string }): SortableLine => ({
  customerName: 'C', orderCode: '', batchNum: 0, timeOfDay: '', driverName: '', qty: 1, amount: 1, ...o,
})
const names = (ls: SortableLine[]) => ls.map(l => l.productName)

describe('sortCustomerLines', () => {
  test('订单号按数字自然顺序排（D-…-2 在 D-…-10 前），而不是逐字符', () => {
    const ls = [line({ productName: 'b', orderCode: 'D-261028-10' }), line({ productName: 'a', orderCode: 'D-261028-2' })]
    assert.deepEqual(names(sortCustomerLines(ls, 'order', 'asc')), ['a', 'b'])
    assert.deepEqual(names(sortCustomerLines(ls, 'order', 'desc')), ['b', 'a'])
  })

  test('批次：批次号 → AM/PM（am 在前）→ 司机', () => {
    const ls = [
      line({ productName: '2am', batchNum: 2, timeOfDay: 'am', driverName: 'X' }),
      line({ productName: '1pm', batchNum: 1, timeOfDay: 'pm', driverName: 'A' }),
      line({ productName: '1am', batchNum: 1, timeOfDay: 'am', driverName: 'Z' }),
    ]
    assert.deepEqual(names(sortCustomerLines(ls, 'batch', 'asc')), ['1am', '1pm', '2am'])
  })

  test('司机 / AM-PM 列各自为主键', () => {
    const ls = [
      line({ productName: 'moz-pm', batchNum: 1, timeOfDay: 'pm', driverName: 'Moazzam' }),
      line({ productName: 'ash-pm', batchNum: 2, timeOfDay: 'pm', driverName: 'ASHWIN' }),
      line({ productName: 'moz-am', batchNum: 3, timeOfDay: 'am', driverName: 'Moazzam' }),
    ]
    assert.deepEqual(names(sortCustomerLines(ls, 'driver', 'asc')), ['ash-pm', 'moz-am', 'moz-pm'])
    assert.deepEqual(names(sortCustomerLines(ls, 'time', 'asc')), ['moz-am', 'moz-pm', 'ash-pm'])
  })

  test('没有值的行（未分配批次 / 无订单号）升降序都垫底', () => {
    const ls = [
      line({ productName: 'none', batchNum: 0 }),
      line({ productName: 'b1', batchNum: 1, timeOfDay: 'am' }),
      line({ productName: 'b2', batchNum: 2, timeOfDay: 'am' }),
    ]
    assert.deepEqual(names(sortCustomerLines(ls, 'batch', 'asc')), ['b1', 'b2', 'none'])
    assert.deepEqual(names(sortCustomerLines(ls, 'batch', 'desc')), ['b2', 'b1', 'none'])
    const byOrder = [line({ productName: 'no-code' }), line({ productName: 'coded', orderCode: 'D-1' })]
    assert.deepEqual(names(sortCustomerLines(byOrder, 'order', 'desc')), ['coded', 'no-code'])
  })

  test('数量 / 金额按数值排；同值按 客户 → 订单号 → 商品 稳定兜底', () => {
    const ls = [
      line({ productName: 'y', customerName: 'B', amount: 5 }),
      line({ productName: 'x', customerName: 'A', amount: 5 }),
      line({ productName: 'big', customerName: 'Z', amount: 40 }),
    ]
    assert.deepEqual(names(sortCustomerLines(ls, 'amount', 'desc')), ['big', 'x', 'y'])
    assert.deepEqual(names(sortCustomerLines(ls, 'amount', 'asc')), ['x', 'y', 'big'])
  })

  test('客户列（缺货处理页用）按客户名排，同客户按订单号兜底', () => {
    const ls = [
      line({ productName: 'z2', customerName: 'Zen', orderCode: 'D-2' }),
      line({ productName: 'a', customerName: 'Afanti', orderCode: 'D-9' }),
      line({ productName: 'z1', customerName: 'Zen', orderCode: 'D-1' }),
    ]
    assert.deepEqual(names(sortCustomerLines(ls, 'customer', 'asc')), ['a', 'z1', 'z2'])
    assert.deepEqual(names(sortCustomerLines(ls, 'customer', 'desc')), ['z1', 'z2', 'a'])
  })

  test('不修改传入数组', () => {
    const ls = [line({ productName: 'b', qty: 2 }), line({ productName: 'a', qty: 1 })]
    sortCustomerLines(ls, 'qty', 'asc')
    assert.deepEqual(names(ls), ['b', 'a'])
  })
})
