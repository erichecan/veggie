import { createOrderInvoiceDraftsBatch } from '@/lib/invoice-from-order'
import type { Prisma } from '@/lib/generated/prisma/client'
import { round2, toNum } from '@/lib/decimal-helpers'
import { nextSequenceName } from '@/lib/sequence-number'
import { applyReturnOrderLineReduction, syncOrderGoodsReturnStatus } from '@/lib/returns-engine'
import { createDraftCreditNotesForReturns } from '@/lib/finance/return-credit-note'
import { postCreditNoteToJournal } from '@/lib/accounting'
import { disposeQuarantinedReturn, receivedReturnQuantity, reverseDuplicateReturnIntake } from '@/lib/return-quarantine'
import { SCRAP_REASONS } from '@/lib/scrap-reasons'

type Tx = Prisma.TransactionClient
type Actor = { userId: string; name?: string | null; email: string }
export { returnError, lockReturnOrders, assertReturnsResolved } from '@/lib/return-invoice-guard'
import { returnError, lockReturnOrders } from '@/lib/return-invoice-guard'

export async function maybeInvoiceAfterReturn(tx: Tx, orderId: string) {
  await createOrderInvoiceDraftsBatch(tx, [orderId])
}

export async function reviewOrderReturn(tx: Tx, id: string, input: {
  action: 'approve' | 'reject'; approvedQuantity?: number; note?: string; exchangeOrderId?: string; disposition?: 'SELLABLE' | 'SCRAP'; scrapReason?: string; reviewOutcome?: string; scrapQuantity?: number; creditAmountExTax?: number
}, actor: Actor) {
  const initial = await tx.orderReturn.findUnique({ where: { id }, select: { orderId: true } })
  if (!initial) returnError('退货记录不存在', 404)
  await lockReturnOrders(tx, [initial.orderId])
  const ret = await tx.orderReturn.findUniqueOrThrow({ where: { id }, include: { order: true, orderLine: true } })
  if (ret.status !== 'PENDING_REVIEW') returnError('退货不在待销售审核状态，请刷新')
  const outcome = input.reviewOutcome
  const outcomes = ['ALL_SELLABLE', 'ALL_SCRAP', 'PARTIAL_SCRAP', 'INSPECTION', 'SHORTAGE', 'CUSTOMER_DISCOUNT', 'COMPANY_FULL', 'PRICE_ONLY', 'NO_GOODS', 'REJECTED', 'DUPLICATE']
  if (outcome && !outcomes.includes(outcome)) returnError('退货审核结论无效', 400)
  if (input.action === 'approve' && ['REJECTED', 'DUPLICATE'].includes(outcome ?? '')) returnError('请使用驳回或合并操作', 400)
  if (outcome === 'INSPECTION' && input.action === 'approve') {
    if (!input.note?.trim()) returnError('请填写待质检说明', 400)
    const orderReturn = await tx.orderReturn.update({ where: { id }, data: { reviewOutcome: outcome, salesNote: input.note.trim() } })
    return { orderReturn, creditNoteRequests: [] }
  }
  if (input.action === 'reject') {
    if (!input.note?.trim()) returnError('拒绝退货必须填写原因', 400)
    let duplicateOfReturnId: string | undefined
    if (outcome === 'DUPLICATE') {
      const candidates = await tx.orderReturn.findMany({
        where: { id: { not: id }, orderLineId: ret.orderLineId, orderId: ret.orderId, status: { not: 'REJECTED' } },
        orderBy: { createdAt: 'asc' }, take: 2, select: { id: true },
      })
      if (candidates.length !== 1) returnError('未找到唯一原退货登记，请先确认重复记录对应的原单')
      duplicateOfReturnId = candidates[0].id
      await reverseDuplicateReturnIntake(tx, ret, actor)
    } else if (ret.workflowVersion === 2 && ret.disposition && receivedReturnQuantity(ret) > 0) {
      await disposeQuarantinedReturn(tx, ret, actor, { releaseSellable: true })
    }
    await tx.orderReturn.update({ where: { id }, data: { status: 'REJECTED', reviewOutcome: outcome ?? 'REJECTED', duplicateOfReturnId, salesNote: input.note.trim(), approvedById: actor.userId, approvedByName: actor.name, approvedAt: new Date() } })
    if (!(await hasPostedReturnInvoice(tx, ret.orderId))) await syncOrderGoodsReturnStatus(tx, [{ orderId: ret.orderId, status: 'REJECTED', productName: ret.productName, quantity: toNum(ret.quantity) }], actor)
    await maybeInvoiceAfterReturn(tx, ret.orderId)
    return { orderReturn: await tx.orderReturn.findUnique({ where: { id } }), creditNoteRequests: [] }
  }
  if (!ret.disposition || !ret.warehouseVerifiedAt || ret.warehouseAcceptedQuantity == null) returnError('仓库须先确认实收数量、质量和货物去向')
  const disposition = outcome === 'ALL_SCRAP' ? 'SCRAP' : ['ALL_SELLABLE', 'PARTIAL_SCRAP'].includes(outcome ?? '') ? 'SELLABLE' : input.disposition ?? ret.disposition
  if (disposition !== 'SELLABLE' && disposition !== 'SCRAP') returnError('请选择可再售或报废', 400)
  const physicalQuantity = receivedReturnQuantity(ret)
  const scrapQuantity = outcome === 'PARTIAL_SCRAP' ? Number(input.scrapQuantity) : disposition === 'SCRAP' ? physicalQuantity : 0
  if (!Number.isFinite(scrapQuantity) || scrapQuantity < 0 || Math.abs(scrapQuantity * 1000 - Math.round(scrapQuantity * 1000)) > 0.00001 || scrapQuantity > physicalQuantity || (outcome === 'PARTIAL_SCRAP' && (scrapQuantity <= 0 || scrapQuantity >= physicalQuantity))) returnError('部分报废数量须大于 0 且小于实收数量', 400)
  const scrapReason = scrapQuantity > 0 ? input.scrapReason || ret.scrapReason || 'CUSTOMER_RETURN_DAMAGED' : null
  if (scrapReason && !SCRAP_REASONS.some(reason => reason === scrapReason)) returnError('报废原因无效', 400)
  if (await tx.stockMove.findFirst({ where: { sourceId: id, sourceType: 'ORDER_RETURN_SCRAP' }, select: { id: true } }) && scrapQuantity !== (ret.scrapQuantity == null ? physicalQuantity : toNum(ret.scrapQuantity))) returnError('该退货已记报损，不能改动已报损数量')
  if (!ret.orderLine) returnError('缺少原订单行，须先核对历史退货来源')
  const received = toNum(ret.warehouseAcceptedQuantity)
  const quantity = input.approvedQuantity == null ? received : Number(input.approvedQuantity)
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > received || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.00001) returnError('批准数量须大于 0、不超过仓库实收数量，最多三位小数', 400)
  if (quantity < received && !input.note?.trim()) returnError('部分批准须填写原因', 400)
  const invoices = await tx.invoice.findMany({ where: { saleOrderIds: { has: ret.orderId }, status: { in: ['DRAFT', 'POSTED', 'PAID'] } }, select: { lines: true, status: true } })
  const red = invoices.some(invoice => invoice.status !== 'DRAFT')
  const billedLines = invoices.flatMap(invoice => Array.isArray(invoice.lines) ? invoice.lines as Array<Record<string, unknown>> : []).filter(row => String(row.orderLineId ?? '') === ret.orderLineId)
  const unitPrice = billedLines.length ? toNum(billedLines[0].unitPrice) : toNum(ret.unitPrice ?? ret.orderLine.unitPrice)
  const rawTax = billedLines.length ? toNum(billedLines[0].taxRate) : toNum(ret.orderLine.taxRate)
  const taxRate = rawTax > 1 ? rawTax / 100 : rawTax
  if (!red && billedLines.some(row => Math.abs(toNum(row.unitPrice) - unitPrice) > 0.005 || Math.abs((toNum(row.taxRate) > 1 ? toNum(row.taxRate) / 100 : toNum(row.taxRate)) - taxRate) > 0.00001)) returnError('同一订单行有不同发票价格或税率，请会计先核对来源后分别处理')
  const requestedAmount = ['CUSTOMER_DISCOUNT', 'PRICE_ONLY', 'NO_GOODS'].includes(outcome ?? '') && !red ? input.creditAmountExTax : undefined
  const fullAmount = round2(quantity * unitPrice)
  if (['CUSTOMER_DISCOUNT', 'PRICE_ONLY', 'NO_GOODS'].includes(outcome ?? '') && !red && (typeof requestedAmount !== 'number' || !Number.isFinite(requestedAmount) || requestedAmount <= 0 || requestedAmount >= 1e10 || (outcome === 'CUSTOMER_DISCOUNT' && requestedAmount > fullAmount))) returnError('请填写有效的未税折让金额', 400)
  const subtotalExTax = round2(requestedAmount ?? fullAmount), taxAmount = round2(subtotalExTax * taxRate)
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
    requestedById: actor.userId, requestedByName: actor.name, totalIncTax: red ? 0 : round2(subtotalExTax + taxAmount),
    lines: [{ orderLineId: ret.orderLineId, sourceReturnId: `ORDER_RETURN:${id}`, productId: ret.productId, productName: ret.productName, quantity, unitPrice: red ? 0 : subtotalExTax / quantity, taxRate, discountAmount: 0, subtotalExTax: red ? 0 : subtotalExTax, taxAmount: red ? 0 : taxAmount, subtotalIncTax: red ? 0 : round2(subtotalExTax + taxAmount), reason: ret.reason ?? '' }],
  }
  const request = previous ? await tx.creditNoteRequest.update({ where: { id: previous.id }, data: requestData }) : await tx.creditNoteRequest.create({ data: requestData })
  const updated = await tx.orderReturn.update({ where: { id }, data: {
    workflowVersion: 2, status: 'APPROVED', approvedQuantity: quantity, disposition, scrapReason, scrapQuantity, reviewOutcome: outcome,
    refundAmount: red ? null : subtotalExTax, salesNote: input.note?.trim() || null,
    approvedById: actor.userId, approvedByName: actor.name, approvedAt: new Date(),
    ...(ret.actionType === 'exchange' ? { exchangeOrderId: input.exchangeOrderId?.trim() || null } : {}),
  } })
  if (scrapQuantity > 0) await disposeQuarantinedReturn(tx, { ...ret, ...updated }, actor, { releaseSellable: false })
  return { orderReturn: updated, creditNoteRequests: [request] }
}

export async function hasPostedReturnInvoice(tx: Tx, orderId: string) {
  return Boolean(await tx.invoice.findFirst({
    where: { saleOrderIds: { has: orderId }, status: { in: ['POSTED', 'PAID'] } },
    select: { id: true },
  }))
}

async function reduceDraftInvoiceLineQuantity(tx: Tx, orderId: string, orderLineId: string, reduceQty: number) {
  const drafts = await tx.invoice.findMany({
    where: { saleOrderIds: { has: orderId }, status: 'DRAFT' },
    select: { id: true, lines: true, amountPaid: true },
  })
  let remainingAcrossDrafts = reduceQty
  for (const invoice of drafts) {
    const rows = Array.isArray(invoice.lines) ? invoice.lines as Array<Record<string, unknown>> : []
    const updatedRows = rows.map(row => {
      if (String(row.orderLineId ?? '') !== orderLineId || remainingAcrossDrafts <= 0) return row
      const oldQty = toNum(row.qty ?? row.quantity)
      const reduction = Math.min(oldQty, remainingAcrossDrafts)
      const qty = Math.max(0, oldQty - reduction)
      remainingAcrossDrafts = Math.max(0, remainingAcrossDrafts - reduction)
      const unitPrice = toNum(row.unitPrice)
      const rawTaxRate = toNum(row.taxRate)
      const taxRate = rawTaxRate > 1 ? rawTaxRate / 100 : rawTaxRate
      const subtotalExTax = round2(qty * unitPrice)
      const taxAmount = round2(subtotalExTax * taxRate)
      return { ...row, qty, subtotalExTax, taxAmount, subtotalIncTax: round2(subtotalExTax + taxAmount) }
    })
    const subtotalExTax = round2(updatedRows.reduce((sum, row) => sum + toNum(row.subtotalExTax), 0))
    const totalTax = round2(updatedRows.reduce((sum, row) => sum + toNum(row.taxAmount), 0))
    const totalIncTax = round2(subtotalExTax + totalTax)
    await tx.invoice.update({ where: { id: invoice.id }, data: {
      lines: updatedRows as never, subtotalExTax, totalTax, totalIncTax,
      amountDue: round2(totalIncTax - toNum(invoice.amountPaid)),
    } })
  }
  if (remainingAcrossDrafts > 0.0005) returnError('草稿发票中的原订单行数量不足以同步退货，请会计先核对发票')
}

export async function confirmReturnCredit(tx: Tx, id: string, userId: string) {
  const note = await tx.creditNote.update({ where: { id }, data: { status: 'CONFIRMED' } })
  const codes = ['1100', '4000', ...(toNum(note.totalTax) > 0 ? ['2200'] : [])]
  const accountCount = await tx.account.count({ where: { code: { in: codes } } })
  if (accountCount !== codes.length) returnError('会计科目未配置完整，未开具贷记单')
  const journal = await postCreditNoteToJournal(tx as never, note, userId)
  if (!journal) returnError('未生成贷记凭证，贷记单未生效')
}

/** Caller holds the order and credit request locks. */

export async function finalizeOrderReturn(tx: Tx, id: string, actor: Actor, approvedPricing: { unitPrice: number; taxRate: number; creditAmountExTax?: number }) {
  const ret = await tx.orderReturn.findUniqueOrThrow({ where: { id }, include: { order: true, orderLine: true } })
  if (ret.workflowVersion !== 2 || ret.status !== 'APPROVED' || ret.settledAt) returnError('退货已处理或属于旧流程，不能重复执行')
  const line = ret.orderLine
  if (!line || !ret.disposition || ret.warehouseAcceptedQuantity == null || ret.approvedQuantity == null) returnError('退货验收或销售审批资料不完整')
  if (ret.order.status !== 'COMPLETED' && ret.order.status !== 'LOCKED') returnError('请先由司机或配送调度确认完成配送，再确认退货')
  const quantity = toNum(ret.approvedQuantity)
  if (quantity > toNum(line.deliveredQty) + 0.0005) returnError('批准退货数量超过剩余实送数量，请核对原订单')
  const invoices = await tx.invoice.findMany({ where: { saleOrderIds: { has: ret.orderId }, status: { in: ['POSTED', 'PAID'] } }, orderBy: { createdAt: 'asc' } })
  const red = invoices.length > 0
  const amount = approvedPricing.creditAmountExTax
  if (red && (amount == null || !Number.isFinite(amount) || amount <= 0 || amount >= 1e10 || Math.abs(amount - round2(amount)) > 0.000001)) {
    returnError('请由会计填写有效的贷记未税金额，最多两位小数', 400)
  }
  let allocatedAmount = 0
  // Allocate exactly across posted invoice lines. Never infer a match by product alone.
  const prior = await tx.creditNoteLine.findMany({ where: { sourceOrderLineId: line.id, sourceReturnId: { not: null }, NOT: { sourceReturnId: { startsWith: 'HISTORICAL_COMPLAINT:' } }, creditNote: { status: { in: ['DRAFT', 'CONFIRMED', 'SETTLED'] } } }, select: { quantity: true, creditNote: { select: { sourceInvoiceId: true } } } })
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
      const rawTax = toNum(row.taxRate), taxRate = rawTax > 1 ? rawTax / 100 : rawTax
      const cumulativeAmount = round2(amount! * (quantity - remaining + qty) / quantity)
      const amountExTax = round2(cumulativeAmount - allocatedAmount)
      if (amountExTax <= 0) returnError('贷记金额不足以分配到各原发票')
      allocatedAmount = cumulativeAmount
      const created = await createDraftCreditNotesForReturns(tx, [{
        sourceReturnId: `ORDER_RETURN:${id}:INVOICE:${invoice.id}`, customerId: ret.order.restaurantId,
        customerName: ret.order.restaurantName, productId: ret.productId, productName: ret.productName,
        quantity: qty, amountExTax, taxRate,
        sourceOrderId: ret.orderId, sourceOrderLineId: line.id, sourceInvoiceId: invoice.id,
        sourceTripId: ret.sourceTripId, reason: ret.salesNote || ret.reason,
      }], actor.userId)
      for (const cn of created) await confirmReturnCredit(tx, cn.id, actor.userId)
      creditNotes.push(...created)
      remaining = Math.round((remaining - qty) * 1000) / 1000
      available -= qty
    }
  }
  // Posted invoices without exact source lines must be reconciled, never silently under-credit.
  if (invoices.length && remaining > 0.0005) returnError('已过账发票缺少足够的原订单行可贷记数量，请会计核对发票来源；未开具贷记单')
  // An unbilled return is reconciled against the eventual invoice quantity. A
  // Credit Note here would double-count the return (net quantity plus credit).
  // Only returns against a posted invoice create a financial credit above.
  await disposeQuarantinedReturn(tx, ret, actor, { releaseSellable: true })
  const sameProductReturned = !ret.actualReturnedProductId || ret.actualReturnedProductId === line.productId
  if (!red && sameProductReturned) {
    await applyReturnOrderLineReduction(tx, [{
      orderId: ret.orderId, orderLineId: line.id, productId: line.productId, reduceQty: quantity,
    }])
    await reduceDraftInvoiceLineQuantity(tx, ret.orderId, line.id, quantity)
  }
  if (!red) await syncOrderGoodsReturnStatus(tx, [{ orderId: ret.orderId, status: 'APPROVED', productName: ret.productName, quantity, disposition: ret.disposition }], actor)
  await tx.orderReturn.update({ where: { id }, data: { status: 'SETTLED', settledAt: new Date(), preservedOriginalOrder: red || !sameProductReturned, ...(red ? { refundAmount: amount } : {}) } })
  return { creditNote: creditNotes[0] ?? null, creditNotes, orderId: ret.orderId }
}
