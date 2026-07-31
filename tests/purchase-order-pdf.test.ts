/**
 * renderPurchaseOrderHtml 是 PO 打印页和"发送邮件"PDF 附件共用的渲染函数，
 * 纯字符串输出，不碰 DB/文件系统，用假数据直接测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderPurchaseOrderHtml, type PurchaseOrderPdfData, type PurchaseOrderPdfSupplier } from '../lib/purchase-order-pdf'

function samplePo(status: string): PurchaseOrderPdfData {
  return {
    name: 'PO-00042',
    status,
    supplierId: 'sup_1',
    orderDate: '2026-07-30T00:00:00.000Z',
    createdAt: '2026-07-30T00:00:00.000Z',
    expectedDate: null,
    notes: null,
    subtotalExTax: 100,
    totalTax: 10,
    totalIncTax: 110,
    lines: [
      { productName: '西兰花', uomName: 'kg', orderedQty: 20, unitCost: 5, taxRate: 10, subtotalIncTax: 110 },
    ],
  }
}

const sampleSupplier: PurchaseOrderPdfSupplier = {
  name: 'Green Farm Ltd', street: '1 Market St', city: 'Dublin', zip: 'D01', phone: '011', vatNumber: 'IE123',
}

test('DRAFT 状态 → 文档标题为 REQUEST FOR QUOTATION', () => {
  const html = renderPurchaseOrderHtml(samplePo('DRAFT'), sampleSupplier)
  assert.match(html, /REQUEST FOR QUOTATION/)
})

test('非 DRAFT 状态（如 SENT）→ 文档标题为 PURCHASE ORDER', () => {
  const html = renderPurchaseOrderHtml(samplePo('SENT'), sampleSupplier)
  assert.match(html, /PURCHASE ORDER/)
  assert.doesNotMatch(html, /REQUEST FOR QUOTATION/)
})

test('包含供应商名称与行项目商品名', () => {
  const html = renderPurchaseOrderHtml(samplePo('DRAFT'), sampleSupplier)
  assert.match(html, /Green Farm Ltd/)
  assert.match(html, /西兰花/)
})

test('supplier 为 null 时不抛错，用 supplierId 兜底展示', () => {
  const po = samplePo('DRAFT')
  assert.doesNotThrow(() => renderPurchaseOrderHtml(po, null))
  assert.match(renderPurchaseOrderHtml(po, null), /sup_1/)
})
