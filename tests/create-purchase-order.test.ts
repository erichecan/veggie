/**
 * canBePurchased 准入闸门：createPurchaseOrder 是 POST /api/purchase-orders 和
 * "采购建议转采购单"共用的唯一创建入口，改这一处即可同时覆盖两条路径。
 * 用 mock tx，不碰真实 DB。
 *
 * ⛔ 20260901：canBePurchased 是 Product 直属标量字段（20260825 ProductTemplate
 * 并入 Product 时移过来的），不再嵌套在 template 关联下——之前 mock 还按旧结构
 * 造数据，跟改完的源码（读 p.canBePurchased）对不上，测试才会"漏检"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPurchaseOrder } from '../lib/create-purchase-order'

function mockTx(
  products: Array<{ id: string; name: string; canBePurchased: boolean; vendorTaxRate?: number | null }>,
  opts: { maxPoNo?: number | null; supplierVendorTax?: number | null } = {},
) {
  return {
    product: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        products
          .filter(p => where.id.in.includes(p.id))
          .map(p => ({ id: p.id, name: p.name, canBePurchased: p.canBePurchased, vendorTaxRate: p.vendorTaxRate ?? null })),
    },
    customer: { findUnique: async () => ({ vendorTaxRate: opts.supplierVendorTax ?? null }) },
    // 编号取现有最大号 +1(SELECT MAX(...))
    $queryRawUnsafe: async () => [{ max: opts.maxPoNo ?? null }],
    purchaseOrder: {
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
  // Prisma 默认值是 true；mock 里模拟"字段未取到"这种边界情况，不应误伤
  const tx = {
    product: { findMany: async () => [{ id: 'p1', name: '洋葱', canBePurchased: undefined }] },
    customer: { findUnique: async () => null },
    $queryRawUnsafe: async () => [{ max: null }],
    purchaseOrder: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'po_test', ...data }),
    },
  }
  const po = await createPurchaseOrder(tx, {
    supplierId: 'sup_1',
    lines: [{ productId: 'p1', productName: '洋葱', orderedQty: 10, unitCost: 2 }],
  })
  assert.equal(po.id, 'po_test')
})

test('编号取现有最大号 +1：删过草稿(PO-00003 不在了，最大是 00004)也不会撞号', async () => {
  const tx = mockTx([{ id: 'p1', name: '洋葱', canBePurchased: true }], { maxPoNo: 4 })
  const po = await createPurchaseOrder(tx, { supplierId: 'sup_1', lines: [{ productId: 'p1', orderedQty: 1, unitCost: 2 }] })
  assert.equal((po as unknown as { name: string }).name, 'PO-00005')
})

test('不传税率：按商品 Vendor Taxes 带出，商品没设再用供应商的', async () => {
  const tx = mockTx([
    { id: 'zero', name: '改成 0% 的商品', canBePurchased: true, vendorTaxRate: 0 },
    { id: 'none', name: '没设税率的商品', canBePurchased: true, vendorTaxRate: null },
  ], { supplierVendorTax: 0.23 })
  const po = await createPurchaseOrder(tx, {
    supplierId: 'sup_1',
    lines: [{ productId: 'zero', orderedQty: 1, unitCost: 10 }, { productId: 'none', orderedQty: 1, unitCost: 10 }],
  }) as unknown as { lines: { create: Array<{ taxRate: number }> } }
  assert.deepEqual(po.lines.create.map(l => l.taxRate), [0, 23])
})
