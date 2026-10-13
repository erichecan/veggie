import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextSequenceName, nextSequenceNumber } from '../lib/sequence-number'
import { nextLotNumbers } from '../lib/lot-number'

// 20261013：PO/批次号/供应商账单等编号以前是 count()+1，删过一张或有空号就撞唯一键，新建一直 500
function mockClient(max: number | null) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  return {
    calls,
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => { calls.push({ sql, params }); return [{ max }] },
  }
}

test('取同前缀下现有最大号 + 1，与总条数无关', async () => {
  assert.equal(await nextSequenceName(mockClient(4), 'PurchaseOrder', 'PO-', 5), 'PO-00005')
  assert.equal(await nextSequenceName(mockClient(null), 'VendorBill', 'VB-', 5), 'VB-00001')
  assert.equal(await nextSequenceName(mockClient(7), 'CreditNote', 'CN-20261013-', 4), 'CN-20261013-0008')
})

test('前缀走参数绑定，表名/列名来自白名单', async () => {
  const c = mockClient(1)
  await nextSequenceNumber(c, 'OrderDiscrepancy', "DISC-'; drop")
  assert.deepEqual(c.calls[0].params, ["DISC-'; drop"])
  assert.match(c.calls[0].sql, /FROM "OrderDiscrepancy"/)
  assert.match(c.calls[0].sql, /"code"/)
})

test('一张采购单多行收货：批次号连续发', async () => {
  assert.deepEqual(await nextLotNumbers(mockClient(2), 3), ['LOT-00003', 'LOT-00004', 'LOT-00005'])
  assert.deepEqual(await nextLotNumbers(mockClient(2), 0), [])
})
