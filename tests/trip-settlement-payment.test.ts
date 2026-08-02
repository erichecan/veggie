/**
 * 司机交账 → 收款核销。
 * 缺口来自审计：生产库 Invoice 148,285 张、Payment 0 条——财务确认交账只翻状态，不入账。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allocateCollections,
  tripPaymentMarker,
  type InvoiceForAllocation,
  type StopCollection,
} from '../lib/trip-settlement-payment'

function inv(over: Partial<InvoiceForAllocation> = {}): InvoiceForAllocation {
  return { id: 'i1', name: 'INV-001', customerId: 'c1', amountDue: 100, status: 'POSTED', dueDate: '2026-07-01', ...over }
}

function stop(over: Partial<StopCollection> = {}): StopCollection {
  return { restaurantId: 'r1', restaurantName: '张记餐厅', amount: 100, orderIds: ['o1'], ...over }
}

const map = (m: Record<string, string[]>) => new Map(Object.entries(m))

test('正常核销：一站一票，金额刚好', () => {
  const r = allocateCollections([stop()], [inv()], map({ o1: ['i1'] }))
  assert.equal(r.payments.length, 1)
  assert.equal(r.payments[0].amount, 100)
  assert.equal(r.totalAllocated, 100)
  assert.deepEqual(r.unallocated, [])
})

test('部分付款：只核销收到的部分，剩余仍挂账', () => {
  const r = allocateCollections([stop({ amount: 40 })], [inv({ amountDue: 100 })], map({ o1: ['i1'] }))
  assert.equal(r.payments[0].amount, 40)
  assert.equal(r.totalAllocated, 40)
  assert.deepEqual(r.unallocated, [])
})

test('跨多张发票：按到期日从早到晚还，不是平均分摊', () => {
  const invoices = [
    inv({ id: 'i-late', name: 'INV-LATE', amountDue: 60, dueDate: '2026-07-20' }),
    inv({ id: 'i-early', name: 'INV-EARLY', amountDue: 60, dueDate: '2026-07-01' }),
  ]
  const r = allocateCollections([stop({ amount: 80, orderIds: ['o1'] })], invoices, map({ o1: ['i-late', 'i-early'] }))

  assert.equal(r.payments.length, 2)
  assert.equal(r.payments[0].invoiceName, 'INV-EARLY', '到期早的先还')
  assert.equal(r.payments[0].amount, 60)
  assert.equal(r.payments[1].invoiceName, 'INV-LATE')
  assert.equal(r.payments[1].amount, 20)
})

test('发票还是草稿：不自动过账，如实报告让财务决定', () => {
  const r = allocateCollections([stop()], [inv({ status: 'DRAFT', name: 'INV-DRAFT' })], map({ o1: ['i1'] }))
  assert.equal(r.payments.length, 0, '绝不能自动过账后核销')
  assert.equal(r.unallocated.length, 1)
  assert.match(r.unallocated[0].reason, /尚未过账/)
  assert.match(r.unallocated[0].reason, /INV-DRAFT/)
  assert.equal(r.unallocated[0].amount, 100)
})

test('超收：多出来的部分不硬塞进发票，交财务判断', () => {
  const r = allocateCollections([stop({ amount: 150 })], [inv({ amountDue: 100 })], map({ o1: ['i1'] }))
  assert.equal(r.totalAllocated, 100)
  assert.equal(r.unallocated.length, 1)
  assert.equal(r.unallocated[0].amount, 50)
  assert.match(r.unallocated[0].reason, /超过该客户未结清发票总额/)
})

test('没有对应发票：报告而不是静默丢弃这笔钱', () => {
  const r = allocateCollections([stop()], [], new Map())
  assert.equal(r.payments.length, 0)
  assert.match(r.unallocated[0].reason, /没有对应发票/)
  assert.equal(r.unallocated[0].amount, 100)
})

test('发票已结清：不重复核销', () => {
  const r = allocateCollections([stop()], [inv({ amountDue: 0, status: 'PAID' })], map({ o1: ['i1'] }))
  assert.equal(r.payments.length, 0)
  assert.match(r.unallocated[0].reason, /已结清或已作废/)
})

test('实收为 0 或负数的站直接跳过，不产生噪音记录', () => {
  const r = allocateCollections(
    [stop({ amount: 0 }), stop({ restaurantId: 'r2', restaurantName: 'B', amount: -5 })],
    [inv()], map({ o1: ['i1'] }),
  )
  assert.equal(r.payments.length, 0)
  assert.deepEqual(r.unallocated, [])
})

test('多站互不串账：各站只核销自己订单对应的发票', () => {
  const invoices = [
    inv({ id: 'iA', name: 'INV-A', customerId: 'cA', amountDue: 50 }),
    inv({ id: 'iB', name: 'INV-B', customerId: 'cB', amountDue: 50 }),
  ]
  const stops = [
    stop({ restaurantId: 'rA', restaurantName: 'A店', amount: 50, orderIds: ['oA'] }),
    stop({ restaurantId: 'rB', restaurantName: 'B店', amount: 50, orderIds: ['oB'] }),
  ]
  const r = allocateCollections(stops, invoices, map({ oA: ['iA'], oB: ['iB'] }))
  assert.equal(r.payments.length, 2)
  assert.equal(r.payments.find(p => p.restaurantName === 'A店')!.customerId, 'cA')
  assert.equal(r.payments.find(p => p.restaurantName === 'B店')!.customerId, 'cB')
})

test('一张发票合并多单时不会被重复计入同一站', () => {
  const r = allocateCollections(
    [stop({ amount: 100, orderIds: ['o1', 'o2'] })],
    [inv({ amountDue: 100 })],
    map({ o1: ['i1'], o2: ['i1'] }),
  )
  assert.equal(r.payments.length, 1, '同一张发票只核销一次')
  assert.equal(r.totalAllocated, 100)
})

test('金额保留两位，不出现浮点毛刺', () => {
  const r = allocateCollections([stop({ amount: 33.33 })], [inv({ amountDue: 100 })], map({ o1: ['i1'] }))
  assert.equal(r.payments[0].amount, 33.33)
  assert.equal(r.totalAllocated, 33.33)
})

test('幂等标记带上 trip id', () => {
  assert.equal(tripPaymentMarker('t123'), 'TRIP:t123')
})
