import type { Prisma } from '@/lib/generated/prisma/client'
type Tx = Prisma.TransactionClient

export function returnError(message: string, status = 409): never { throw Object.assign(new Error(message), { status }) }

/** Same lock order at every invoice/return entry: Order (sorted), then return/request/invoice. */
export async function lockReturnOrders(tx: Tx, ids: string[]) {
  if (!ids.length) return
  const sorted = [...new Set(ids)].sort()
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ANY(${sorted}::text[]) ORDER BY id FOR UPDATE`
}
export async function assertReturnReviewComplete(tx: Pick<Tx, 'orderReturn' | 'returnIntake'>, orderIds: string[]) {
  if (!orderIds.length) return
  const pending = await tx.orderReturn.findFirst({
    where: { orderId: { in: orderIds }, status: { in: ['WAREHOUSE_PENDING', 'PENDING_REVIEW'] } },
    select: { productName: true },
  })
  if (pending) returnError(`商品「${pending.productName}」的退货尚未完成仓库或销售审核，暂不能核销或开票。请电话联系处理人。`)
  const photo = await tx.returnIntake.findFirst({
    where: { candidateOrderIds: { hasSome: orderIds }, status: { in: ['OPEN', 'CUSTOMER_IDENTIFIED'] } }, select: { id: true },
  })
  if (photo) returnError('司机已上报退货照片，销售尚未确认对应订单，暂不能核销或开票。')
}

export async function assertReceiptIssuesResolved(tx: Pick<Tx, 'order' | 'receiptManifestEntry'>, orderIds: string[]) {
  if (!orderIds.length) return
  const receipts = await tx.receiptManifestEntry.findMany({
    where: { orderId: { in: orderIds } }, select: { orderId: true, orderCode: true, scannedAt: true },
  })
  const returned = new Set(receipts.filter(row => row.scannedAt).map(row => row.orderId))
  const missing = receipts.find(row => !returned.has(row.orderId))
  if (missing) returnError(`签收单${missing.orderCode ? ` ${missing.orderCode}` : ''}尚未在应回清单扫码确认，暂不能核销或开票。`)
  const paper = await tx.receiptManifestEntry.findFirst({
    where: { orderId: { in: orderIds }, paperIssue: { not: null }, paperReviewedAt: null }, select: { orderCode: true },
  })
  if (paper) returnError(`签收单${paper.orderCode ? ` ${paper.orderCode}` : ''}有手写问题待销售审核，暂不能核销或开票。`)
  await assertLegacyReceiptReviewComplete(tx, orderIds)
}

export async function assertLegacyReceiptReviewComplete(tx: Pick<Tx, 'order'>, orderIds: string[]) {
  if (!orderIds.length) return
  const issue = await tx.order.findFirst({
    where: { id: { in: orderIds }, returnStatus: 'ISSUE' }, select: { code: true },
  })
  if (issue) returnError(`回单${issue.code ? ` ${issue.code}` : ''}尚待销售确认，暂不能重置、核销或开票。`)
}

export async function assertReturnsResolved(tx: Pick<Tx, 'order' | 'orderReturn' | 'returnIntake' | 'creditNoteRequest' | 'receiptManifestEntry'>, orderIds: string[]) {
  if (!orderIds.length) return
  await assertReturnReviewComplete(tx, orderIds)
  await assertReceiptIssuesResolved(tx, orderIds)
  const pending = await tx.orderReturn.findFirst({
    where: { orderId: { in: orderIds }, status: 'APPROVED', workflowVersion: 2 },
    select: { productName: true },
  })
  if (pending) returnError(`商品「${pending.productName}」的退货尚待会计处理，暂不能开票或过账`)

  const pendingCreditRequest = await tx.creditNoteRequest.findFirst({
    where: { sourceOrderId: { in: orderIds }, status: 'PENDING' },
    select: { name: true },
  })
  if (pendingCreditRequest) returnError(`销售贷记申请 ${pendingCreditRequest.name} 尚待会计处理，暂不能开票或过账`)
}

export async function invoiceSourceOrderIds(
  tx: Pick<Tx, 'orderLine'>,
  invoices: ReadonlyArray<{ saleOrderIds: readonly string[]; lines: unknown }>,
) {
  const ids = new Set(invoices.flatMap(invoice => invoice.saleOrderIds))
  const lineIds = new Set<string>()
  for (const invoice of invoices) {
    if (!Array.isArray(invoice.lines)) continue
    for (const line of invoice.lines) {
      if (!line || typeof line !== 'object') continue
      if (typeof line.orderId === 'string' && line.orderId.trim()) ids.add(line.orderId.trim())
      if (typeof line.orderLineId === 'string' && line.orderLineId.trim()) lineIds.add(line.orderLineId.trim())
    }
  }
  if (lineIds.size) {
    const lines = await tx.orderLine.findMany({ where: { id: { in: [...lineIds] } }, select: { orderId: true } })
    for (const line of lines) ids.add(line.orderId)
  }
  return [...ids]
}

/** Call after locking the source orders, then the invoice rows. Retry if a concurrent edit added sources. */
export async function assertInvoiceReturnsResolved(
  tx: Pick<Tx, 'orderLine' | 'order' | 'orderReturn' | 'returnIntake' | 'creditNoteRequest' | 'receiptManifestEntry'>,
  invoices: ReadonlyArray<{ saleOrderIds: readonly string[]; lines: unknown }>,
  lockedOrderIds: string[],
) {
  const currentIds = await invoiceSourceOrderIds(tx, invoices)
  const locked = new Set(lockedOrderIds)
  if (currentIds.some(id => !locked.has(id))) returnError('发票关联订单已变更，请刷新后重试')
  await assertReturnsResolved(tx, currentIds)
}
