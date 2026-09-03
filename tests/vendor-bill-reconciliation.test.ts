/**
 * 供应商账单三单核销（台账 20260902-finance-center-rebuild-tasks）
 * ============================================================================
 * 判定基准是"收货量 vs 账单量"（不是"收货量 vs 下单量"）：账单量超过收货量是
 * 财务最需要拦下来的情况（为没收到的货付钱），见 lib/vendor-bill-reconciliation.ts
 * 顶部注释里的判定依据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileVendorBill } from '../lib/vendor-bill-reconciliation'

test('MATCHED：收货量与账单量一致', () => {
  const r = reconcileVendorBill(
    [{ productId: 'p1', orderedQty: 100, receivedQty: 100 }],
    [{ productId: 'p1', productName: '苹果', billedQty: 100 }],
  )
  assert.equal(r.status, 'MATCHED')
  assert.equal(r.lines[0].status, 'MATCHED')
  assert.equal(r.lines[0].diff, 0)
})

test('OVER_RECEIVED：收货量超过账单量（供应商可能少开了这批账单）', () => {
  const r = reconcileVendorBill(
    [{ productId: 'p1', orderedQty: 100, receivedQty: 100 }],
    [{ productId: 'p1', productName: '苹果', billedQty: 60 }],
  )
  assert.equal(r.status, 'OVER_RECEIVED')
  assert.equal(r.lines[0].diff, 40)
})

test('UNDER_RECEIVED：账单量超过收货量（在为还没收到的货付钱）', () => {
  const r = reconcileVendorBill(
    [{ productId: 'p1', orderedQty: 100, receivedQty: 60 }],
    [{ productId: 'p1', productName: '苹果', billedQty: 100 }],
  )
  assert.equal(r.status, 'UNDER_RECEIVED')
  assert.equal(r.lines[0].diff, -40)
})

test('整单状态：多行里只要有一行 UNDER_RECEIVED，整单就是 UNDER_RECEIVED（优先于 OVER_RECEIVED）', () => {
  const r = reconcileVendorBill(
    [
      { productId: 'p1', orderedQty: 100, receivedQty: 100 },
      { productId: 'p2', orderedQty: 50, receivedQty: 50 },
    ],
    [
      { productId: 'p1', productName: '苹果', billedQty: 60 }, // OVER_RECEIVED
      { productId: 'p2', productName: '香蕉', billedQty: 80 }, // UNDER_RECEIVED
    ],
  )
  assert.equal(r.status, 'UNDER_RECEIVED')
})

test('浮点误差在容差内算 MATCHED，不会因为小数精度误判', () => {
  const r = reconcileVendorBill(
    [{ productId: 'p1', orderedQty: 100, receivedQty: 99.9995 }],
    [{ productId: 'p1', productName: '苹果', billedQty: 100 }],
  )
  assert.equal(r.status, 'MATCHED')
})

test('账单商品在 PO 行里找不到匹配（收货量按0处理）→ UNDER_RECEIVED，不静默跳过', () => {
  const r = reconcileVendorBill(
    [{ productId: 'p1', orderedQty: 100, receivedQty: 100 }],
    [{ productId: 'p2', productName: 'PO 上没有的商品', billedQty: 10 }],
  )
  assert.equal(r.lines.length, 1)
  assert.equal(r.lines[0].receivedQty, 0)
  assert.equal(r.lines[0].status, 'UNDER_RECEIVED')
})

test('账单未关联任何 PO（poLines 为空数组）→ 所有行收货量为0', () => {
  const r = reconcileVendorBill(
    [],
    [{ productId: 'p1', productName: '苹果', billedQty: 10 }],
  )
  assert.equal(r.lines[0].receivedQty, 0)
  assert.equal(r.status, 'UNDER_RECEIVED')
})

test('账单里同一 productId 出现两行会先合并再比较，不会各自单独判定', () => {
  const r = reconcileVendorBill(
    [{ productId: 'p1', orderedQty: 100, receivedQty: 100 }],
    [
      { productId: 'p1', productName: '苹果', billedQty: 40 },
      { productId: 'p1', productName: '苹果', billedQty: 60 },
    ],
  )
  assert.equal(r.lines.length, 1)
  assert.equal(r.lines[0].billedQty, 100)
  assert.equal(r.status, 'MATCHED')
})

test('空账单（billLines 为空）→ 返回空行列表，整单 MATCHED（没有可核对的行）', () => {
  const r = reconcileVendorBill(
    [{ productId: 'p1', orderedQty: 100, receivedQty: 100 }],
    [],
  )
  assert.deepEqual(r.lines, [])
  assert.equal(r.status, 'MATCHED')
})
