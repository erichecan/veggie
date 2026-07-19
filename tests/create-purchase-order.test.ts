/**
 * canBePurchased 准入闸门：createPurchaseOrder 是 POST /api/purchase-orders 和
 * "采购建议转采购单"共用的唯一创建入口，改这一处即可同时覆盖两条路径。
 * 用 mock tx，不碰真实 DB。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPurchaseOrder } from '../lib/create-purchase-order'

function mockTx(products: Array<{ id: string; name: string; canBePurchased: boolean }>) {
  return {
    product: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        products
          .filter(p => where.id.in.includes(p.id))
          .map(p => ({ id: p.id, name: p.name, template: { canBePurchased: p.canBePurchased } })),
    },
    purchaseOrder: {
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'po_test', ...data }),
    },
  }
}

test('包含不可采购商品的行 → 抛出 400 错误，不创建 PO', async () => {
  const tx = mockTx([{ id: 'p1', name: '洋葱', canBePurchased: false }])
  await assert.rejects(
    () => createPurchaseOrder(tx, {
      supplierId: 'sup_1',
      lines: [{ productId: 'p1', productName: '洋葱', orderedQty: 10, unitCost: 2 }],
    }),
    (err: unknown) => {
      assert.match((err as Error).message, /洋葱/)
      assert.equal((err as { status?: number }).status, 400)
      return true
    },
  )
})

test('全部商品可采购 → 正常创建 PO', async () => {
  const tx = mockTx([{ id: 'p1', name: '洋葱', canBePurchased: true }])
  const po = await createPurchaseOrder(tx, {
    supplierId: 'sup_1',
    lines: [{ productId: 'p1', productName: '洋葱', orderedQty: 10, unitCost: 2 }],
  })
  assert.equal(po.id, 'po_test')
})

test('商品模板缺失 canBePurchased 字段（undefined）→ 默认放行', async () => {
  // Prisma 默认值是 true；mock 里模拟"没查到 template"这种边界情况，不应误伤
  const tx = {
    product: { findMany: async () => [{ id: 'p1', name: '洋葱', template: null }] },
    purchaseOrder: {
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'po_test', ...data }),
    },
  }
  const po = await createPurchaseOrder(tx, {
    supplierId: 'sup_1',
    lines: [{ productId: 'p1', productName: '洋葱', orderedQty: 10, unitCost: 2 }],
  })
  assert.equal(po.id, 'po_test')
})
