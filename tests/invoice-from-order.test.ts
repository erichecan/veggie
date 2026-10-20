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

// ─ 20261020：发票号按数字取最大号 + 撞号重试（调度台「标记完成」后草稿发票静默没生成）
const ONE_LINE = [{ id: 'l1', productId: 'p1', productName: '土豆', spec: null, deliveredQty: 1, unitPrice: 2, taxRate: 0 }]

test('真实客户端走数字最大号：SQL 只认 INV-纯数字，结果补到 5 位', async () => {
  const { tx, created } = mockTx({ orderLines: ONE_LINE, adjustments: [] })
  const sqls: unknown[][] = []
  const real = { ...tx, $queryRawUnsafe: async (...args: unknown[]) => { sqls.push(args); return [{ max: 148286 }] } }
  await createDraftInvoiceForOrder(real, 'order_1')
  assert.equal(created[0].name, 'INV-148287')
  assert.match(String(sqls[0][0]), /\^\[0-9\]\{1,9\}\$/)
  assert.equal(sqls[0][1], 'INV-')
})

test('撞唯一约束（并发取到同一个号）就重新取号，第二次成功', async () => {
  const { tx, created } = mockTx({ orderLines: ONE_LINE, adjustments: [] })
  let max = 7
  let calls = 0
  const real = {
    ...tx,
    $queryRawUnsafe: async () => [{ max: max++ }],
    invoice: {
      ...tx.invoice,
      create: async (args: unknown) => {
        if (calls++ === 0) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
        return tx.invoice.create(args)
      },
    },
  }
  await createDraftInvoiceForOrder(real, 'order_1')
  assert.equal(calls, 2)
  assert.equal(created[0].name, 'INV-00009')
})

test('非撞号错误不重试，原样抛出', async () => {
  const { tx } = mockTx({ orderLines: ONE_LINE, adjustments: [] })
  let calls = 0
  const real = {
    ...tx,
    $queryRawUnsafe: async () => [{ max: 1 }],
    invoice: { ...tx.invoice, create: async () => { calls++; throw new Error('boom') } },
  }
  await assert.rejects(createDraftInvoiceForOrder(real, 'order_1'), /boom/)
  assert.equal(calls, 1)
})

test('账期取客户档案并推出到期日（不再写死 monthly、到期日为空）', async () => {
  const { tx, created } = mockTx({ orderLines: ONE_LINE, adjustments: [] })
  const real = { ...tx, customer: { findUnique: async () => ({ name: '张记餐厅', paymentTerm: 'weekly' }) } }
  await createDraftInvoiceForOrder(real, 'order_1')
  assert.equal(created[0].paymentTerms, 'weekly')
  assert.match(String(created[0].dueDate), /^\d{4}-\d{2}-\d{2}$/)
})
