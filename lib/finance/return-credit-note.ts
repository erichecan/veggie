import { recomputeInvoiceBalance } from '@/lib/finance/invoice-balance'
import { Prisma } from '@/lib/generated/prisma/client'
import { round2, toNum } from '@/lib/decimal-helpers'
import { nextSequenceName } from '@/lib/sequence-number'

export interface ReturnCreditNoteInput {
  sourceReturnId: string
  customerId: string
  customerName: string
  productId: string
  productName: string
  quantity: number
  /** Approved credit amount before tax. */
  amountExTax: number
  taxRate?: number | null
  reason?: string | null
  sourceOrderId?: string | null
  sourceTripId?: string | null
  sourceInvoiceId?: string | null
  sourceOrderLineId?: string | null
  sourceOrderCode?: string | null
}

/**
 * Only credit the quantity that was actually invoiced. Same-day returns reduce
 * deliveredQty and therefore the invoice generated later, but create no CN.
 */
export async function creditForInvoicedReturn(
  tx: Prisma.TransactionClient,
  input: { sourceReturnId: string; orderId: string; orderLineId: string; quantity: number; returnedAt: Date },
) {
  const invoices = await tx.invoice.findMany({
    where: { saleOrderIds: { has: input.orderId }, status: { in: ['POSTED', 'PAID'] } },
    select: { id: true, lines: true },
    orderBy: { createdAt: 'asc' },
  })
  const candidates = invoices.flatMap(invoice => {
    const lines = Array.isArray(invoice.lines) ? invoice.lines as Array<Record<string, unknown>> : []
    return lines.filter(line => String(line.orderLineId ?? '') === input.orderLineId)
      .map(line => ({ invoiceId: invoice.id, line }))
  })
  if (!candidates.length) return null

  const orderLine = await tx.orderLine.findUnique({
    where: { id: input.orderLineId },
    select: { productId: true },
  })
  if (!orderLine) return null
  const prior = await tx.creditNoteLine.aggregate({
    where: {
      sourceOrderId: input.orderId,
      productId: orderLine.productId,
      sourceReturnId: { not: null },
      OR: [{ sourceOrderLineId: input.orderLineId }, { sourceOrderLineId: null }],
      creditNote: { status: { in: ['DRAFT', 'CONFIRMED', 'SETTLED'] } },
    },
    _sum: { quantity: true },
  })
  const pendingRequests = await tx.creditNoteRequest.findMany({
    where: { sourceOrderId: input.orderId, sourceReturnId: { not: null }, status: 'PENDING' },
    select: { lines: true },
  })
  const pendingQuantity = pendingRequests.reduce((sum, request) => {
    const lines = Array.isArray(request.lines) ? request.lines as Array<Record<string, unknown>> : []
    return sum + lines.reduce((lineSum, line) => {
      const sameOrderLine = String(line.orderLineId ?? '') === input.orderLineId
      const legacyProductMatch = !line.orderLineId && String(line.productId ?? '') === orderLine.productId
      return lineSum + (sameOrderLine || legacyProductMatch ? toNum(line.quantity) : 0)
    }, 0)
  }, 0)
  let available = Math.max(0, input.quantity)
  let alreadyCredited = Number(prior._sum.quantity ?? 0) + pendingQuantity
  const outputs: Array<{ sourceInvoiceId: string; quantity: number; unitPrice: number; taxRate: number }> = []
  for (const candidate of candidates) {
    const lineQty = Number(candidate.line.qty ?? candidate.line.quantity ?? 0)
    const alreadyAllocatedToCredits = Math.min(alreadyCredited, lineQty)
    alreadyCredited -= alreadyAllocatedToCredits
    const remainingOnInvoice = Math.max(0, lineQty - alreadyAllocatedToCredits)
    const quantity = Math.min(available, remainingOnInvoice)
    if (quantity <= 0) continue
    outputs.push({
      sourceInvoiceId: candidate.invoiceId,
      quantity,
      unitPrice: Number(candidate.line.unitPrice ?? 0),
      taxRate: Number(candidate.line.taxRate ?? 0) > 1 ? Number(candidate.line.taxRate) / 100 : Number(candidate.line.taxRate ?? 0),
    })
    // One return has one idempotency key and therefore belongs to one CN/invoice.
    // If it spans invoices, finance can create a separate adjustment for the remainder.
    break
  }
  return outputs
}

/** Keep an unposted auto-draft invoice in sync with a same-day return quantity correction. */
export async function reduceDraftInvoiceForReturn(
  tx: Prisma.TransactionClient,
  input: { orderId: string; orderLineId: string; quantity: number },
) {
  const drafts = await tx.invoice.findMany({
    where: { saleOrderIds: { has: input.orderId }, status: 'DRAFT' },
    select: { id: true, lines: true },
  })
  const results = []
  for (const invoice of drafts) {
    const rows = Array.isArray(invoice.lines) ? invoice.lines as Array<Record<string, unknown>> : []
    let remaining = input.quantity
    let changed = false
    const updated = rows.flatMap(line => {
      if (String(line.orderLineId ?? '') !== input.orderLineId || remaining <= 0) return [line]
      const oldQty = Number(line.qty ?? line.quantity ?? 0)
      const reduce = Math.min(oldQty, remaining)
      const qty = round2(oldQty - reduce)
      remaining -= reduce
      changed = true
      const unitPrice = Number(line.unitPrice ?? 0)
      const taxRateRaw = Number(line.taxRate ?? 0)
      const taxRate = taxRateRaw > 1 ? taxRateRaw / 100 : taxRateRaw
      const subtotalExTax = round2(qty * unitPrice)
      const taxAmount = round2(subtotalExTax * taxRate)
      if (qty <= 0) return []
      return [{ ...line, qty, ...(line.quantity == null ? {} : { quantity: qty }), subtotalExTax, taxAmount, subtotalIncTax: round2(subtotalExTax + taxAmount) }]
    })
    if (!changed) continue
    const subtotalExTax = round2(updated.reduce((sum, line) => sum + Number(line.subtotalExTax ?? 0), 0))
    const totalTax = round2(updated.reduce((sum, line) => sum + Number(line.taxAmount ?? 0), 0))
    const totalIncTax = round2(updated.reduce((sum, line) => sum + Number(line.subtotalIncTax ?? 0), 0))
    results.push(await tx.invoice.update({ where: { id: invoice.id }, data: {
      lines: updated as never, subtotalExTax, totalTax, totalIncTax,
    }, select: { id: true } }))
    await recomputeInvoiceBalance(tx, invoice.id)
  }
  return results
}

/** Create a Sales-review request for an invoiced return; Finance creates the CN after review. */
export async function createReturnCreditNoteRequest(
  tx: Prisma.TransactionClient,
  input: {
    sourceReturnId: string; customerId: string; customerName: string; orderId: string; orderCode?: string;
    orderLineId: string;
    invoiceId: string; productId: string; productName: string; quantity: number;
    unitPrice: number; taxRate: number; reason: string;
  },
  user: { userId: string; name?: string | null },
) {
  const prior = await tx.creditNoteRequest.findUnique({ where: { sourceReturnId: input.sourceReturnId }, select: { id: true, name: true } })
  if (prior) return prior
  const now = new Date()
  const prefix = `CNR-${now.toISOString().slice(0, 10).replace(/-/g, '')}-`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`
  const name = await nextSequenceName(tx, 'CreditNoteRequest', prefix, 4)
  const subtotalExTax = round2(input.quantity * input.unitPrice)
  const taxAmount = round2(subtotalExTax * input.taxRate)
  const totalIncTax = round2(subtotalExTax + taxAmount)
  return tx.creditNoteRequest.create({
    data: {
      name, customerId: input.customerId, customerName: input.customerName,
      sourceOrderId: input.orderId, sourceOrderCode: input.orderCode ?? input.orderId, sourceInvoiceId: input.invoiceId,
      sourceReturnId: input.sourceReturnId, requestDate: now,
      reason: input.reason || '退货验收通过', status: 'PENDING',
      requestedById: user.userId, requestedByName: user.name,
      totalIncTax, lines: [{
        productId: input.productId, productName: input.productName,
        orderLineId: input.orderLineId,
        sourceReturnId: input.sourceReturnId,
        quantity: input.quantity, unitPrice: input.unitPrice, taxRate: input.taxRate,
        discountAmount: 0, subtotalExTax, taxAmount, subtotalIncTax: totalIncTax,
        reason: input.reason || '退货验收通过',
      }] as never,
    },
  })
}

/**
 * Create draft credit notes for approved returns, grouped by customer within this
 * approval operation. A unique sourceReturnId on each line makes retries safe.
 * The notes stay DRAFT: confirming them remains an accounting action.
 */
export async function createDraftCreditNotesForReturns(
  tx: Prisma.TransactionClient,
  inputs: ReturnCreditNoteInput[],
  createdBy: string,
) {
  const valid = inputs.filter(i => i.quantity > 0 && i.amountExTax > 0.005)
  if (valid.length === 0) return []

  const priorLines = await tx.creditNoteLine.findMany({
    where: { sourceReturnId: { in: valid.map(i => i.sourceReturnId) } },
    select: { sourceReturnId: true },
  })
  const alreadyCreated = new Set(priorLines.map(l => l.sourceReturnId))
  const pending = valid.filter(i => !alreadyCreated.has(i.sourceReturnId))
  if (pending.length === 0) return []

  const groups = new Map<string, ReturnCreditNoteInput[]>()
  for (const input of pending) {
    const groupKey = `${input.customerId}:${input.sourceInvoiceId ?? ''}`
    const rows = groups.get(groupKey) ?? []
    rows.push(input)
    groups.set(groupKey, rows)
  }

  const created = []
  const today = new Date()
  const datePrefix = `CN-${today.toISOString().slice(0, 10).replace(/-/g, '')}-`

  for (const [, rows] of groups) {
    const customerId = rows[0].customerId
    // Serialize same-day number allocation inside this transaction.
    // The lock function returns PostgreSQL `void`; executeRaw avoids Prisma's
    // result deserialization error while keeping the lock inside this transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${datePrefix}))`
    const name = await nextSequenceName(tx, 'CreditNote', datePrefix, 4)
    let subtotalExTax = 0
    let totalTax = 0
    const lineData = rows.map((row, sequence) => {
      const amount = round2(row.amountExTax)
      const taxRate = toNum(row.taxRate ?? 0)
      const taxAmount = round2(amount * taxRate)
      subtotalExTax += amount
      totalTax += taxAmount
      return {
        productId: row.productId,
        productName: row.productName,
        quantity: row.quantity,
        // For a partial refund, the effective unit price keeps the line total equal
        // to the approved amount while retaining the original returned quantity.
        unitPrice: round2(amount / row.quantity),
        taxRate,
        subtotalExTax: amount,
        taxAmount,
        subtotalIncTax: round2(amount + taxAmount),
        reason: row.reason ?? '退换货审核通过',
        sourceOrderId: row.sourceOrderId ?? null,
        sourceOrderLineId: row.sourceOrderLineId ?? null,
        sourceTripId: row.sourceTripId ?? null,
        sourceReturnId: row.sourceReturnId,
        sequence,
      }
    })
    subtotalExTax = round2(subtotalExTax)
    totalTax = round2(totalTax)

    const note = await tx.creditNote.create({
      data: {
        name,
        customerId,
        customerName: rows[0].customerName,
        creditDate: today,
        currency: 'EUR',
        subtotalExTax,
        totalTax,
        totalIncTax: round2(subtotalExTax + totalTax),
        status: 'DRAFT',
        sourceInvoiceId: rows[0].sourceInvoiceId ?? null,
        notes: `退换货审核自动生成草稿，待财务核对确认（${rows.length} 项）`,
        createdBy,
        lines: { create: lineData },
      },
      select: { id: true, name: true, customerName: true, totalIncTax: true },
    })
    created.push(note)
  }
  return created
}
