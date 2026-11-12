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
    const rows = groups.get(input.customerId) ?? []
    rows.push(input)
    groups.set(input.customerId, rows)
  }

  const created = []
  const today = new Date()
  const datePrefix = `CN-${today.toISOString().slice(0, 10).replace(/-/g, '')}-`

  for (const [customerId, rows] of groups) {
    // Serialize same-day number allocation inside this transaction.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${datePrefix}))`
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
