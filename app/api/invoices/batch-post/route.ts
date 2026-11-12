import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { postInvoiceToJournal } from '@/lib/accounting'
import { writebackInvoicedQty } from '@/lib/invoice-invoiced-qty'
import { serializeApi } from '@/lib/api-serializer'

/** Batch posting is atomic: every selected invoice posts, or none of them do. */
export async function POST(req: Request) {
  return withAuth(req, async user => {
    try {
      const data = await req.json()
      const ids: string[] = Array.from(new Set<string>((Array.isArray(data.invoiceIds) ? data.invoiceIds : []).map((id: unknown) => String(id).trim()).filter(Boolean)))
      if (ids.length < 1 || ids.length > 100) return NextResponse.json({ error: '请选择 1 至 100 张发票' }, { status: 400 })
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`
        const invoices = await tx.invoice.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } })
        if (invoices.length !== ids.length) throw Object.assign(new Error('部分发票不存在'), { status: 404 })
        const invalid = invoices.find(invoice => invoice.status !== 'DRAFT')
        if (invalid) throw Object.assign(new Error(`${invalid.name} 不是草稿，未执行批量过账`), { status: 409 })
        const posted = []
        for (const invoice of invoices) {
          const entry = await postInvoiceToJournal(tx as never, invoice, user.userId)
          if (!entry) throw new Error(`发票 ${invoice.name} 未能生成总账凭证，已取消整批操作`)
          const updated = await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'POSTED', postedAt: new Date().toISOString() } })
          await writebackInvoicedQty(tx as never, invoice.lines, invoice.saleOrderIds)
          posted.push({ invoice: updated, entry })
        }
        return posted
      })
      await Promise.all(result.map(({ invoice, entry }) => writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'invoice', resourceId: invoice.id,
        detail: `发票 ${invoice.name} 批量过账${entry ? `，凭证 ${entry.name}` : ''}`,
        changes: { status: { before: 'DRAFT', after: 'POSTED' } },
      })))
      return NextResponse.json(serializeApi({ posted: result.length, invoices: result.map(x => x.invoice) }))
    } catch (error) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) return NextResponse.json({ error: err.message }, { status: err.status })
      console.error('[POST /api/invoices/batch-post]', error)
      return NextResponse.json({ error: err.message ?? '批量过账失败' }, { status: 500 })
    }
  }, { require: 'finance.invoice.pay' })
}
