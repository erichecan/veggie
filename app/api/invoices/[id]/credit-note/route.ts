import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'
import { nextSequenceName } from '@/lib/sequence-number'

/** Create a blank editable credit-note draft linked to a posted invoice for reference. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async user => {
    const { id } = await params
    try {
      const created = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`
        const invoice = await tx.invoice.findUnique({ where: { id } })
        if (!invoice) throw Object.assign(new Error('发票不存在'), { status: 404 })
        if (!['POSTED', 'PAID'].includes(String(invoice.status))) {
          throw Object.assign(new Error('只有已过账或已付款的发票可以创建贷记单'), { status: 409 })
        }

        const date = new Date()
        const prefix = `CN-${date.toISOString().slice(0, 10).replace(/-/g, '')}-`
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`
        const name = await nextSequenceName(tx, 'CreditNote', prefix, 4)

        return tx.creditNote.create({
          data: {
            name,
            customerId: invoice.customerId,
            customerName: invoice.customerName,
            creditDate: date,
            currency: 'EUR',
            subtotalExTax: 0,
            totalTax: 0,
            totalIncTax: 0,
            status: 'DRAFT',
            notes: null,
            createdBy: user.userId,
            sourceInvoiceId: invoice.id,
          },
          include: { lines: true, sourceInvoice: { select: { id: true, name: true } } },
        })
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'credit-note', resourceId: created.id,
        detail: `从发票 ${created.sourceInvoice?.name ?? id} 创建空白贷记单草稿 ${created.name} — ${created.customerName}`,
      })
      return NextResponse.json(serializeApi(created), { status: 201 })
    } catch (error) {
      const status = Number((error as { status?: number })?.status) || 500
      if (status === 500) console.error('[POST /api/invoices/[id]/credit-note]', error)
      return NextResponse.json({ error: error instanceof Error && status !== 500 ? error.message : '创建贷记单失败' }, { status })
    }
  }, { require: 'finance.credit_note.create' })
}
