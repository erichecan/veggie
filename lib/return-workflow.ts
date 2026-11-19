import { createDraftInvoiceForOrderInTransaction, type InvoiceTx } from '@/lib/invoice-from-order'
import type { Prisma } from '@/lib/generated/prisma/client'
import { round2, toNum } from '@/lib/decimal-helpers'
import { nextSequenceName } from '@/lib/sequence-number'
import { buildReturnStockMoves, postReturnStockMoves, applyReturnOrderLineReduction, syncOrderGoodsReturnStatus } from '@/lib/returns-engine'
import { reduceDraftInvoiceForReturn, createDraftCreditNotesForReturns } from '@/lib/finance/return-credit-note'
import { postCreditNoteToJournal } from '@/lib/accounting'

type Tx = Prisma.TransactionClient
type Actor = { userId: string; name?: string | null; email: string }
export { returnError, lockReturnOrders, assertReturnsResolved } from '@/lib/return-invoice-guard'
import { returnError, lockReturnOrders } from '@/lib/return-invoice-guard'

export async function maybeInvoiceAfterReturn(tx: Tx, orderId: string) {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { returnStatus: true, status: true } })
  if (order?.returnStatus !== 'RETURNED' || order.status !== 'COMPLETED') return
  const pending = await tx.orderReturn.count({ where: { orderId, OR: [{ status: { in: ['WAREHOUSE_PENDING', 'PENDING_REVIEW'] } }, { status: 'APPROVED', workflowVersion: 2 }] } })
  if (!pending) await createDraftInvoiceForOrderInTransaction(tx as unknown as InvoiceTx, orderId)
}

export async function reviewOrderReturn(tx: Tx, id: string, input: {
  action: 'approve' | 'reject'; approvedQuantity?: number; note?: string; exchangeOrderId?: string
}, actor: Actor) {
  const initial = await tx.orderReturn.findUnique({ where: { id }, select: { orderId: true } })
  if (!initial) returnError('退货记录不存在', 404)
  await lockReturnOrders(tx, [initial.orderId])
  const ret = await tx.orderReturn.findUniqueOrThrow({ where: { id }, include: { order: true, orderLine: true } })
  if (ret.status !== 'PENDING_REVIEW') returnError('退货不在待销售审核状态，请刷新')
  if (input.action === 'reject') {
    if (!input.note?.trim()) returnError('拒绝退货必须填写原因', 400)
    await tx.orderReturn.update({ where: { id }, data: { status: 'REJECTED', salesNote: input.note.trim(), approvedById: actor.userId, approvedByName: actor.name, approvedAt: new Date() } })
    await syncOrderGoodsReturnStatus(tx, [{ orderId: ret.orderId, status: 'REJECTED', productName: ret.productName, quantity: toNum(ret.quantity) }], actor)
    await maybeInvoiceAfterReturn(tx, ret.orderId)
    return { orderReturn: await tx.orderReturn.findUnique({ where: { id } }), creditNoteRequests: [] }
  }
  if (!ret.disposition || !ret.warehouseVerifiedAt || ret.warehouseAcceptedQuantity == null) returnError('仓库须先确认实收数量、质量和货物去向')
  if (!ret.orderLine) returnError('缺少原订单行，须先核对历史退货来源')
  const received = toNum(ret.warehouseAcceptedQuantity)
  const quantity = input.approvedQuantity == null ? received : Number(input.approvedQuantity)
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > received || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.00001) returnError('批准数量须大于 0、不超过仓库实收数量，最多三位小数', 400)
  if (quantity < received && !input.note?.trim()) returnError('部分批准须填写原因', 400)
  const invoices = await tx.invoice.findMany({ where: { saleOrderIds: { has: ret.orderId }, status: { in: ['DRAFT', 'POSTED', 'PAID'] } }, select: { lines: true } })
  const billedLines = invoices.flatMap(invoice => Array.isArray(invoice.lines) ? invoice.lines as Array<Record<string, unknown>> : []).filter(row => String(row.orderLineId ?? '') === ret.orderLineId)
  const unitPrice = billedLines.length ? toNum(billedLines[0].unitPrice) : toNum(ret.unitPrice ?? ret.orderLine.unitPrice)
  const rawTax = billedLines.length ? toNum(billedLines[0].taxRate) : toNum(ret.orderLine.taxRate)
  const taxRate = rawTax > 1 ? rawTax / 100 : rawTax
  if (billedLines.some(row => Math.abs(toNum(row.unitPrice) - unitPrice) > 0.005 || Math.abs((toNum(row.taxRate) > 1 ? toNum(row.taxRate) / 100 : toNum(row.taxRate)) - taxRate) > 0.00001)) returnError('同一订单行有不同发票价格或税率，请会计先核对来源后分别处理')
  const subtotalExTax = round2(quantity * unitPrice), taxAmount = round2(subtotalExTax * taxRate)
  const prefix = `CNR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`
  const previous = await tx.creditNoteRequest.findUnique({ where: { sourceReturnId: `ORDER_RETURN:${id}` } })
  if (previous && previous.status !== 'REJECTED') returnError('退货申请已提交会计')
  const requestData = {
    name: previous?.name ?? await nextSequenceName(tx, 'CreditNoteRequest', prefix, 4),
    customerId: ret.order.restaurantId, customerName: ret.order.restaurantName,
    sourceOrderId: ret.orderId, sourceOrderCode: ret.order.code ?? ret.orderId,
    sourceReturnId: `ORDER_RETURN:${id}`, reason: input.note?.trim() || ret.reason || '退货申请',
    status: 'PENDING', reviewedById: null, reviewedByName: null, reviewedAt: null, reviewNote: null,
    requestedById: actor.userId, requestedByName: actor.name, totalIncTax: round2(subtotalExTax + taxAmount),
    lines: [{ orderLineId: ret.orderLineId, sourceReturnId: `ORDER_RETURN:${id}`, productId: ret.productId, productName: ret.productName, quantity, unitPrice, taxRate, discountAmount: 0, subtotalExTax, taxAmount, subtotalIncTax: round2(subtotalExTax + taxAmount), reason: ret.reason ?? '' }],
  }
  const request = previous ? await tx.creditNoteRequest.update({ where: { id: previous.id }, data: requestData }) : await tx.creditNoteRequest.create({ data: requestData })
  const updated = await tx.orderReturn.update({ where: { id }, data: {
    workflowVersion: 2, status: 'APPROVED', approvedQuantity: quantity,
    refundAmount: subtotalExTax, salesNote: input.note?.trim() || null,
    approvedById: actor.userId, approvedByName: actor.name, approvedAt: new Date(),
    ...(ret.actionType === 'exchange' ? { exchangeOrderId: input.exchangeOrderId?.trim() || null } : {}),
  } })
  return { orderReturn: updated, creditNoteRequests: [request] }
}

/** Finance approval is the sole v2 stock/quantity/CN commit point. Caller holds Order + request locks. */
export async function finalizeOrderReturn(tx: Tx, id: string, actor: Actor, approvedPricing: { unitPrice: number; taxRate: number }) {
  const ret = await tx.orderReturn.findUniqueOrThrow({ where: { id }, include: { order: true, orderLine: true } })
  if (ret.workflowVersion !== 2 || ret.status !== 'APPROVED' || ret.settledAt) returnError('退货已处理或属于旧流程，不能重复执行')
  const line = ret.orderLine
  if (!line || !ret.disposition || ret.warehouseAcceptedQuantity == null || ret.approvedQuantity == null) returnError('退货验收或销售审批资料不完整')
  if (ret.order.status !== 'COMPLETED') returnError('请先由司机或配送调度确认完成配送，再确认退货')
  const quantity = toNum(ret.approvedQuantity)
  if (quantity > toNum(line.deliveredQty) + 0.0005) returnError('批准退货数量超过剩余实送数量，请核对原订单')
  const productId = ret.actualReturnedProductId ?? ret.productId
  const stockQuantity = productId === ret.productId ? toNum(ret.warehouseAcceptedQuantity) : toNum(ret.actualReturnedStockQuantity)
  if (!(stockQuantity > 0)) returnError('实际退回商品缺少基础单位数量')
  const invoices = await tx.invoice.findMany({ where: { saleOrderIds: { has: ret.orderId }, status: { in: ['POSTED', 'PAID'] } }, orderBy: { createdAt: 'asc' } })
  // Allocate exactly across posted invoice lines. Never infer a match by product alone.
  const prior = await tx.creditNoteLine.findMany({ where: { sourceOrderLineId: line.id, sourceReturnId: { not: null }, creditNote: { status: { in: ['DRAFT', 'CONFIRMED', 'SETTLED'] } } }, select: { quantity: true, creditNote: { select: { sourceInvoiceId: true } } } })
  let remaining = quantity
  const creditNotes = []
  for (const invoice of invoices) {
    const rows = Array.isArray(invoice.lines) ? invoice.lines as Array<Record<string, unknown>> : []
    const matches = rows.filter(row => String(row.orderLineId ?? '') === line.id)
    if (matches.length > 1) returnError('同张发票同一订单行存在多个价格明细，请会计先核对')
    const invoiced = matches.reduce((sum, row) => sum + toNum(row.qty ?? row.quantity), 0)
    const used = prior.filter(row => row.creditNote.sourceInvoiceId === invoice.id).reduce((sum, row) => sum + toNum(row.quantity), 0)
    let available = Math.max(0, invoiced - used)
    for (const row of matches) {
      const qty = Math.min(remaining, available, toNum(row.qty ?? row.quantity))
      if (!(qty > 0)) continue
      if (Math.abs(toNum(row.unitPrice) - approvedPricing.unitPrice) > 0.005) returnError('原发票单价与销售退货申请不一致，请先核对原单价格')
      const rawTax = toNum(row.taxRate), taxRate = rawTax > 1 ? rawTax / 100 : rawTax
      if (Math.abs(taxRate - approvedPricing.taxRate) > 0.00001) returnError('原发票税率与销售申请不一致，请重新审核')
      const created = await createDraftCreditNotesForReturns(tx, [{
        sourceReturnId: `ORDER_RETURN:${id}:INVOICE:${invoice.id}`, customerId: ret.order.restaurantId,
        customerName: ret.order.restaurantName, productId: ret.productId, productName: ret.productName,
        quantity: qty, amountExTax: round2(qty * toNum(row.unitPrice)), taxRate,
        sourceOrderId: ret.orderId, sourceOrderLineId: line.id, sourceInvoiceId: invoice.id,
        sourceTripId: ret.sourceTripId, reason: ret.salesNote || ret.reason,
      }], actor.userId)
      for (const cn of created) {
        const full = await tx.creditNote.update({ where: { id: cn.id }, data: { status: 'CONFIRMED' } })
        const accountCodes = ['1100', '4000', ...(toNum(full.totalTax) > 0 ? ['2200'] : [])]
        const accountCount = await tx.account.count({ where: { code: { in: accountCodes } } })
        if (accountCount !== accountCodes.length) returnError('会计科目未配置完整，本次退货确认已全部回滚')
        const journal = await postCreditNoteToJournal(tx as never, full, actor.userId)
        if (!journal) returnError('会计科目未配置，未生成凭证；本次退货确认已全部回滚')
        creditNotes.push(cn)
      }
      remaining = Math.round((remaining - qty) * 1000) / 1000
      available -= qty
    }
  }
  // Posted invoices without exact source lines must be reconciled, never silently under-credit.
  if (invoices.length && remaining > 0.0005) returnError('已过账发票缺少足够的原订单行可贷记数量，请会计核对发票来源；未调整库存')
  await postReturnStockMoves(tx, buildReturnStockMoves({
    productId, productName: ret.actualReturnedProductName ?? ret.productName, quantity: stockQuantity,
    disposition: ret.disposition, scrapReason: ret.scrapReason ?? undefined, reason: ret.warehouseNote ?? undefined,
    uomId: productId === ret.productId ? line.uomId : null,
    partnerId: ret.order.restaurantId, partnerName: ret.order.restaurantName,
    sourceType: 'ORDER_RETURN', sourceId: id, sourceRef: ret.order.code,
  }), actor)
  const stockRows = await tx.stockMove.findMany({ where: { sourceId: id, sourceType: { in: ['ORDER_RETURN', 'ORDER_RETURN_SCRAP'] } }, select: { id: true, sourceType: true, value: true } })
  for (const sourceType of ['ORDER_RETURN', 'ORDER_RETURN_SCRAP']) {
    const rows = stockRows.filter(row => row.sourceType === sourceType)
    if (rows.reduce((sum, row) => sum + toNum(row.value), 0) > 0.005) {
      const journal = await tx.journalEntry.findFirst({ where: { sourceType: 'stock_move', sourceId: { in: rows.map(row => row.id) }, status: 'POSTED' }, select: { id: true } })
      if (!journal) returnError('库存估值科目未配置，退货库存及财务确认已全部回滚')
    }
  }
  await applyReturnOrderLineReduction(tx, [{ orderId: ret.orderId, orderLineId: line.id, productId: ret.productId, reduceQty: quantity }])
  if (!invoices.length) {
    const drafts = await tx.invoice.findMany({ where: { saleOrderIds: { has: ret.orderId }, status: 'DRAFT' }, select: { lines: true } })
    for (const draft of drafts) for (const row of (Array.isArray(draft.lines) ? draft.lines as Array<Record<string, unknown>> : [])) if (String(row.orderLineId ?? '') === line.id) {
      const tax = toNum(row.taxRate) > 1 ? toNum(row.taxRate) / 100 : toNum(row.taxRate)
      if (Math.abs(toNum(row.unitPrice) - approvedPricing.unitPrice) > 0.005 || Math.abs(tax - approvedPricing.taxRate) > 0.00001) returnError('草稿价格或税率已变化，请销售重新审核')
    }
    await reduceDraftInvoiceForReturn(tx, { orderId: ret.orderId, orderLineId: line.id, quantity })
  }
  await syncOrderGoodsReturnStatus(tx, [{ orderId: ret.orderId, status: 'APPROVED', productName: ret.productName, quantity, disposition: ret.disposition }], actor)
  await tx.orderReturn.update({ where: { id }, data: { status: 'SETTLED', settledAt: new Date() } })
  if (!invoices.length) await maybeInvoiceAfterReturn(tx, ret.orderId)
  return { creditNote: creditNotes[0] ?? null, creditNotes, orderId: ret.orderId }
}
