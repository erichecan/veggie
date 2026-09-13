/**
 * 回归测试：Trip.totalPayment（司机上门收现总额）必须含订单调整行（折扣/配送费/
 * 差价修正，20260913），否则有调整的订单司机收的现金对不上。见 lib/order-adjustments.ts。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTripFromWave } from '../lib/trip-from-wave'

function mockTx(opts: {
  orders: Array<{ id: string; restaurantId: string; restaurantName: string; totalAmount: number }>
  adjustments: Array<{ orderId: string; amount: number }>
}) {
  const created: Array<Record<string, unknown>> = []
  const tx = {
    pickingWave: {
      findUnique: async () => ({
        id: 'wave_1', name: '波次1', orderIds: opts.orders.map(o => o.id),
        driverSlotId: null, driverName: '司机张三', waveType: null,
      }),
    },
    driverSlot: { findUnique: async () => null },
    order: {
      findMany: async () => opts.orders.map(o => ({ ...o, lines: [] })),
    },
    customer: { findMany: async () => [] },
    orderAdjustment: {
      findMany: async (args: unknown) => {
        const ids = (args as { where: { orderId: { in: string[] } } }).where.orderId.in
        return opts.adjustments.filter(a => ids.includes(a.orderId))
      },
    },
    trip: {
      create: async (args: unknown) => {
        created.push((args as { data: Record<string, unknown> }).data)
        return { id: 'trip_1' }
      },
    },
  }
  return { tx, created }
}

test('无调整行：totalPayment 等于各单 totalAmount 之和', async () => {
  const { tx, created } = mockTx({
    orders: [
      { id: 'o1', restaurantId: 'c1', restaurantName: '张记', totalAmount: 100 },
      { id: 'o2', restaurantId: 'c2', restaurantName: '李记', totalAmount: 50 },
    ],
    adjustments: [],
  })
  await createTripFromWave(tx, 'wave_1')
  assert.equal(created[0].totalPayment, 150)
})

test('有折扣(负)+配送费(正)：totalPayment 叠加调整合计', async () => {
  const { tx, created } = mockTx({
    orders: [
      { id: 'o1', restaurantId: 'c1', restaurantName: '张记', totalAmount: 100 },
      { id: 'o2', restaurantId: 'c2', restaurantName: '李记', totalAmount: 50 },
    ],
    adjustments: [
      { orderId: 'o1', amount: -10 },
      { orderId: 'o1', amount: 5 },
      { orderId: 'o2', amount: 3 },
    ],
  })
  await createTripFromWave(tx, 'wave_1')
  // (100 - 10 + 5) + (50 + 3) = 95 + 53 = 148
  assert.equal(created[0].totalPayment, 148)
})
