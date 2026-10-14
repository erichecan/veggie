import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { allocateCreditNoteToInvoice, refundCreditNote } from '@/lib/finance/credit-note-allocation'

/**
 * POST /api/credit-notes/:id/allocations —— 贷记单的去向（20261014 复式改造 L1）
 *   { kind: 'INVOICE', invoiceId, amount, note? }  抵扣一张发票
 *   { kind: 'REFUND', amount, method, note? }       退款给客户（出凭证 Dr AR / Cr Bank）
 * 规则与记账方式见 lib/finance/credit-note-allocation.ts。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const kind = String(data.kind ?? 'INVOICE').toUpperCase()
      const amount = Number(data.amount)
      const note = data.note ? String(data.note).trim().slice(0, 500) : null
      const actor = { userId: user.userId, name: user.name, email: user.email }

      if (kind === 'INVOICE') {
        const invoiceId = String(data.invoiceId ?? '').trim()
        if (!invoiceId) return NextResponse.json({ error: 'invoiceId 必填' }, { status: 400 })
        const r = await prisma.$transaction(tx => allocateCreditNoteToInvoice(tx, { creditNoteId: id, invoiceId, amount, note, actor }))
        await writeLog({
          userId: user.userId, userEmail: user.email, userName: user.name,
          action: 'UPDATE', resource: 'credit-note', resourceId: id,
          detail: `${r.creditNoteName} 抵扣发票 ${r.invoiceName} €${amount.toFixed(2)}（剩余 €${r.remaining.toFixed(2)}）`,
        })
        return NextResponse.json(serializeApi(r), { status: 201 })
      }
      if (kind === 'REFUND') {
        const method = String(data.method ?? 'transfer').toLowerCase()
        const r = await prisma.$transaction(tx => refundCreditNote(tx, { creditNoteId: id, amount, method, note, actor }))
        await writeLog({
          userId: user.userId, userEmail: user.email, userName: user.name,
          action: 'UPDATE', resource: 'credit-note', resourceId: id,
          detail: `${r.creditNoteName} 退款 €${amount.toFixed(2)}（${method}）${r.journalEntry ? ` · 凭证 ${r.journalEntry.name}` : ''}`,
        })
        return NextResponse.json(serializeApi(r), { status: 201 })
      }
      return NextResponse.json({ error: 'kind 只能是 INVOICE 或 REFUND' }, { status: 400 })
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      console.error('[POST /api/credit-notes/[id]/allocations]', error)
      return NextResponse.json({ error: '贷记单抵扣失败' }, { status: 500 })
    }
  }, { require: 'finance.credit_note.update' })
}
