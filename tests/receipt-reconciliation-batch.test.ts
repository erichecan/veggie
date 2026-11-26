import test from 'node:test'
import assert from 'node:assert/strict'
import type { Prisma } from '../lib/generated/prisma/client'
import { createDraftInvoiceForOrderInTransaction, createOrderInvoiceDraftsBatch, type InvoiceTx } from '../lib/invoice-from-order'
import { assertReturnsResolved, invoiceSourceOrderIds } from '../lib/return-invoice-guard'

function fixture(count: number, held: string[] = []) {
  const orderIds = Array.from({ length: count }, (_, index) => `order-${index}`)
  const orders = orderIds.map(id => ({
    id, restaurantId: 'customer', restaurantName: 'Customer', deliveryDate: new Date('2026-11-25T00:00:00Z'),
    lines: [{ id: `line-${id}`, productId: 'product', productName: 'Product', spec: null, deliveredQty: 2, unitPrice: 5, taxRate: 0 }],
  }))
  let calls = 0
  const written: Array<Record<string, unknown>> = []
  const order = (id: string) => orders.find(row => row.id === id)
  const query = <T>(result: T) => { calls++; return Promise.resolve(result) }
  const tx = {
    $queryRaw: () => query([]),
    $executeRaw: () => query(0),
    invoice: {
      findFirst: ({ where }: { where: { name?: unknown } }) => query(where.name ? { id: 'prior', name: `INV-${String(written.length).padStart(5, '0')}` } : null),
      findMany: () => query([]),
      create: ({ data }: { data: Record<string, unknown> }) => { written.push(data); return query({ id: 'draft' }) },
      createManyAndReturn: ({ data }: { data: Array<Record<string, unknown>> }) => { written.push(...data); return query(data.map((row, index) => ({ id: `invoice-${index}`, saleOrderIds: row.saleOrderIds }))) },
    },
    order: {
      findFirst: () => query(null),
      findUnique: ({ where }: { where: { id: string } }) => query(order(where.id)),
      findMany: () => query(orders),
    },
    orderLine: { findMany: () => query([{ orderId: orderIds[0] }]) },
    customer: { findUnique: () => query({ name: 'Customer' }), findMany: () => query([{ id: 'customer', name: 'Customer' }]) },
    orderAdjustment: { findMany: () => query([]) },
    receiptManifestEntry: { findFirst: () => query(null), findMany: () => query([]) },
    orderReturn: {
      findMany: () => query(held.map(orderId => ({ orderId }))),
      findFirst: ({ where }: { where: { status: { in?: string[] } | string; orderId: { in: string[] } } }) =>
        query(typeof where.status === 'object' && where.orderId.in.some(id => held.includes(id)) ? { productName: 'Product' } : null),
    },
    returnIntake: { findFirst: () => query(null), findMany: () => query([]) },
    creditNoteRequest: { findFirst: () => query(null), findMany: () => query([]) },
  }
  return { tx: tx as unknown as Prisma.TransactionClient, orderIds, written, calls: () => calls }
}

test('200 receipts produce equivalent invoice drafts with at least five times fewer database calls', async t => {
  const serial = fixture(200)
  for (const id of serial.orderIds) await createDraftInvoiceForOrderInTransaction(serial.tx as unknown as InvoiceTx, id)
  const batch = fixture(200)
  const result = await createOrderInvoiceDraftsBatch(batch.tx, batch.orderIds)
  assert.equal(result.created, 200)
  assert.deepEqual(batch.written.map(row => ({ ...row, name: '' })).sort(sortByOrder), serial.written.map(row => ({ ...row, name: '' })).sort(sortByOrder))
  assert.equal(new Set(batch.written.map(row => row.name)).size, 200)
  assert.ok(serial.calls() / batch.calls() >= 5)
  t.diagnostic(`Draft generation database calls: ${serial.calls()} serial, ${batch.calls()} batched; this does not measure elapsed time.`)
})

function sortByOrder(a: Record<string, unknown>, b: Record<string, unknown>) {
  return String(a.saleOrderIds).localeCompare(String(b.saleOrderIds))
}

test('a sales hold blocks linked invoicing and excludes the order from the draft batch', async () => {
  const { tx, orderIds, written } = fixture(2, ['order-0'])
  const ids = await invoiceSourceOrderIds(tx, [{ saleOrderIds: [], lines: [{ orderLineId: 'line-order-0' }] }])
  assert.deepEqual(ids, ['order-0'])
  await assert.rejects(assertReturnsResolved(tx, ids), { status: 409 })
  const result = await createOrderInvoiceDraftsBatch(tx, orderIds)
  assert.equal(result.created, 1)
  assert.deepEqual(result.deferred, ['order-0'])
  assert.deepEqual(written[0].saleOrderIds, ['order-1'])
})

test('a scanned receipt with a handwritten issue remains blocked until sales reviews it', async () => {
  const { tx, orderIds } = fixture(1)
  const paperTx = {
    ...tx,
    receiptManifestEntry: {
      findMany: async () => [{ orderId: orderIds[0], scannedAt: new Date() }],
      findFirst: async () => ({ orderCode: 'D-1' }),
    },
  } as unknown as Prisma.TransactionClient
  await assert.rejects(assertReturnsResolved(paperTx, orderIds), { status: 409 })
})

test('missing receipts and unresolved photo reports both block invoice generation', async () => {
  const { tx, orderIds } = fixture(2)
  const incomplete = {
    ...tx,
    returnIntake: {
      findFirst: async () => ({ id: 'photo' }),
      findMany: async () => [{ candidateOrderIds: [orderIds[1]] }],
    },
    receiptManifestEntry: {
      findMany: async () => [{ orderId: orderIds[0], orderCode: 'D-1', scannedAt: null }],
      findFirst: async () => null,
    },
  } as unknown as Prisma.TransactionClient
  await assert.rejects(assertReturnsResolved(incomplete, orderIds), /照片/)
  const result = await createOrderInvoiceDraftsBatch(incomplete, orderIds)
  assert.equal(result.created, 0)
  assert.deepEqual(result.deferred, orderIds)
})

test('dispatch snapshots preserve the original amounts after a retry', async () => {
  const { freezeReceiptManifest } = await import('../lib/receipt-manifest')
  const entries: Array<{ expectedAmount: number }> = []
  let inserted = false
  let amount = 100
  const tx = {
    receiptManifest: {
      createMany: async () => {
        if (inserted) return { count: 0 }
        inserted = true
        return { count: 1 }
      },
    },
    receiptManifestEntry: { createMany: async ({ data }: { data: typeof entries }) => entries.push(...data) },
    order: { findMany: async () => [{ id: 'order', code: 'D-1', restaurantName: 'Customer', totalAmount: amount }] },
    orderAdjustment: { groupBy: async () => [{ orderId: 'order', _sum: { amount: -5 } }] },
  } as unknown as Prisma.TransactionClient
  const trip = { id: 'trip', driverId: 'driver', driverName: 'Driver', vehiclePlate: 'PLATE', restaurants: [{ orderIds: ['order'] }] }
  await freezeReceiptManifest(tx, trip, new Date('2026-11-25T11:00:00Z'))
  amount = 125
  await freezeReceiptManifest(tx, trip, new Date('2026-11-25T13:00:00Z'))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].expectedAmount, 95)
})
