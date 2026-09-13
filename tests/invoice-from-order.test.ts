/**
 * 回归测试：发票生成把订单调整行（折扣/配送费/差价修正）折进金额与明细行。
 * Order.totalAmount 本身不含调整（SSOT 不变），发票是"客户要签字认账"的单据，
 * 必须把调整体现出来，否则客户永远收不到这笔账。见 lib/order-adjustments.ts。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDraftInvoiceForOrder } from '../lib/invoice-from-order'

function mockTx(opts: {
  orderLines: Array<{ id: string; productId: string; productName: string; spec: string | null; deliveredQty: number; unitPrice: number; taxRate: number | null }>
  adjustments: Array<{ id: string; type: string; label: string; amount: number }>
}) {
  const created: Array<Record<string, unknown>> = []
  return {
    tx: {
      invoice: {
        findFirst: async () => null,
        create: async (args: unknown) => {
          created.push((args as { data: Record<string, unknown> }).data)
          return { id: 'inv_1' }
        },
      },
      order: {
        findUnique: async () => ({
          restaurantId: 'cust_1',
          restaurantName: '张记餐厅',
          lines: opts.orderLines,
        }),
      },
      customer: { findUnique: async () => ({ name: '张记餐厅' }) },
      orderAdjustment: { findMany: async () => opts.adjustments },
    },
    created,
  }
}

test('无调整行：金额与旧行为一致', async () => {
  const { tx, created } = mockTx({
    orderLines: [{ id: 'l1', productId: 'p1', productName: '土豆', spec: null, deliveredQty: 10, unitPrice: 2, taxRate: 0 }],
    adjustments: [],
  })
  await createDraftInvoiceForOrder(tx, 'order_1')
  assert.equal(created.length, 1)
  assert.equal(created[0].subtotalExTax, 20)
  assert.equal(created[0].totalIncTax, 20)
  assert.equal(created[0].amountDue, 20)
  assert.equal((created[0].lines as unknown[]).length, 1)
})

test('折扣(负)+配送费(正)：计入总额，各自追加一条明细行', async () => {
  const { tx, created } = mockTx({
    orderLines: [{ id: 'l1', productId: 'p1', productName: '土豆', spec: null, deliveredQty: 10, unitPrice: 2, taxRate: 0 }],
    adjustments: [
      { id: 'a1', type: 'DISCOUNT', label: '9月促销折扣', amount: -5 },
      { id: 'a2', type: 'DELIVERY_FEE', label: '配送费', amount: 3 },
    ],
  })
  await createDraftInvoiceForOrder(tx, 'order_1')
  // 20(商品) - 5(折扣) + 3(配送费) = 18
  assert.equal(created[0].subtotalExTax, 18)
  assert.equal(created[0].totalIncTax, 18)
  assert.equal(created[0].amountDue, 18)
  const lines = created[0].lines as Array<Record<string, unknown>>
  assert.equal(lines.length, 3)
  const discountLine = lines.find(l => l.adjustmentType === 'DISCOUNT')
  const feeLine = lines.find(l => l.adjustmentType === 'DELIVERY_FEE')
  assert.equal(discountLine?.subtotalExTax, -5)
  assert.equal(discountLine?.productName, '9月促销折扣')
  assert.equal(feeLine?.subtotalExTax, 3)
  assert.equal(feeLine?.taxAmount, 0, '调整行不重新分摊税额')
})

test('赠品行(unitPrice=0)照常生成发票行但金额为 0', async () => {
  const { tx, created } = mockTx({
    orderLines: [{ id: 'l1', productId: 'p1', productName: '赠品样品', spec: null, deliveredQty: 5, unitPrice: 0, taxRate: 0 }],
    adjustments: [],
  })
  await createDraftInvoiceForOrder(tx, 'order_1')
  assert.equal(created[0].subtotalExTax, 0)
  assert.equal((created[0].lines as unknown[]).length, 1)
})

test('全部行 deliveredQty=0 时不生成发票，即使有调整行也不例外', async () => {
  const { tx, created } = mockTx({
    orderLines: [{ id: 'l1', productId: 'p1', productName: '土豆', spec: null, deliveredQty: 0, unitPrice: 2, taxRate: 0 }],
    adjustments: [{ id: 'a1', type: 'DELIVERY_FEE', label: '配送费', amount: 3 }],
  })
  const result = await createDraftInvoiceForOrder(tx, 'order_1')
  assert.equal(result, null)
  assert.equal(created.length, 0)
})
