/**
 * B-2 回归测试：发票过账时按行精确回写 invoicedQty。
 * 纯逻辑，无需 DB。验证:
 *   1. orderLineIdsFromInvoiceLines 只提取非空 orderLineId
 *   2. 有 orderLineId → 走行级 UPDATE(WHERE id = ANY)
 *   3. 无 orderLineId 的旧发票 → 回退整单(WHERE orderId = ANY)
 *   4. 两者皆空 → 不发 SQL
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderLineIdsFromInvoiceLines, writebackInvoicedQty } from '../lib/invoice-invoiced-qty'

test('orderLineIdsFromInvoiceLines 只取非空 orderLineId', () => {
  const lines = [
    { orderLineId: 'ol_1', productId: 'p1' },
    { productId: 'p2' },                 // 无 orderLineId(旧行)
    { orderLineId: '', productId: 'p3' },// 空串忽略
    { orderLineId: 'ol_4' },
  ]
  assert.deepEqual(orderLineIdsFromInvoiceLines(lines), ['ol_1', 'ol_4'])
  assert.deepEqual(orderLineIdsFromInvoiceLines(null), [])
  assert.deepEqual(orderLineIdsFromInvoiceLines('nope'), [])
})

function mockTx() {
  const calls: Array<{ sql: string; args: unknown[] }> = []
  return {
    calls,
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => { calls.push({ sql, args }); return 0 },
  }
}

test('有 orderLineId → 行级回写 WHERE id = ANY', async () => {
  const tx = mockTx()
  await writebackInvoicedQty(tx, [{ orderLineId: 'ol_1' }, { orderLineId: 'ol_2' }], ['ord_1'])
  assert.equal(tx.calls.length, 1)
  assert.match(tx.calls[0].sql, /WHERE "id" = ANY/)
  assert.deepEqual(tx.calls[0].args, [['ol_1', 'ol_2']])
})

test('无 orderLineId 的旧发票 → 回退整单 WHERE orderId = ANY', async () => {
  const tx = mockTx()
  await writebackInvoicedQty(tx, [{ productId: 'p1' }], ['ord_1', 'ord_2'])
  assert.equal(tx.calls.length, 1)
  assert.match(tx.calls[0].sql, /WHERE "orderId" = ANY/)
  assert.deepEqual(tx.calls[0].args, [['ord_1', 'ord_2']])
})

test('无行也无单 → 不发 SQL', async () => {
  const tx = mockTx()
  await writebackInvoicedQty(tx, [], [])
  assert.equal(tx.calls.length, 0)
})
