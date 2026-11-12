import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { postJournalEntry } from '@/lib/accounting'

/** Reverse the immutable posted ledger entries and return an unpaid invoice to draft. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async user => {
    try {
      const { id } = await params
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`
        const invoice = await tx.invoice.findUnique({ where: { id }, include: { supersededBy: { select: { id: true } } } })
        if (!invoice) throw Object.assign(new Error('发票不存在'), { status: 404 })
        if (invoice.status !== 'POSTED') throw Object.assign(new Error('只有已过账发票可以退回草稿'), { status: 409 })
        if (invoice.supersededBy) throw Object.assign(new Error('已被新发票取代的发票不能退回草稿'), { status: 409 })
        const [paymentCount, allocationCount] = await Promise.all([
          tx.payment.count({ where: { invoiceId: id } }),
          tx.creditNoteAllocation.count({ where: { invoiceId: id, kind: 'INVOICE' } }),
        ])
        if (paymentCount || allocationCount || Number(invoice.writeOffAmount) > 0) {
          throw Object.assign(new Error('已有收款、贷记单抵扣或抹零的发票不能退回草稿；请先按财务冲正流程处理'), { status: 409 })
        }
        const entries = await tx.journalEntry.findMany({
          where: { sourceType: 'invoice', sourceId: id, status: 'POSTED' },
          include: { lines: { include: { account: { select: { code: true } } } } },
        })
        const reversals = []
        for (const entry of entries) {
          const reversal = await postJournalEntry(tx as never, {
            narration: `Reversal of ${entry.name} — invoice ${invoice.name} reset to draft`,
            sourceType: 'invoice_reset', sourceId: id,
            lines: entry.lines.map(line => ({
              code: line.account.code,
              debit: Number(line.credit),
              credit: Number(line.debit),
              description: `Reversal ${entry.name}: ${line.description ?? invoice.name}`,
              partnerId: line.partnerId,
            })),
          }, user.userId)
          if (!reversal) throw new Error(`无法冲销凭证 ${entry.name}，发票保持原状态`)
          reversals.push(reversal.name)
        }
        const updated = await tx.invoice.update({ where: { id }, data: { status: 'DRAFT', postedAt: null, paidAt: null } })
        return { invoice: updated, reversals }
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'invoice', resourceId: id,
        detail: `发票 ${result.invoice.name} 退回草稿${result.reversals.length ? `，冲销凭证 ${result.reversals.join(', ')}` : ''}`,
        changes: { status: { before: 'POSTED', after: 'DRAFT' } } })
      return NextResponse.json({ invoice: result.invoice, reversalEntries: result.reversals })
    } catch (error) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) return NextResponse.json({ error: err.message }, { status: err.status })
      console.error('[POST /api/invoices/:id/reset-to-draft]', error)
      return NextResponse.json({ error: err.message ?? '发票退回草稿失败' }, { status: 500 })
    }
  }, { require: 'finance.invoice.update' })
}
