import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { postJournalEntry } from '@/lib/accounting'
import { round2, toNum } from '@/lib/decimal-helpers'
import { recomputeInvoiceBalance } from '@/lib/finance/invoice-balance'
import { paymentJournalByCode } from '@/lib/finance/payment-journals'

/** Register one customer receipt, allocate it across selected invoices, and post one balanced journal entry atomically. */
export async function POST(req: Request) {
  return withAuth(req, async user => {
    try {
      const data = await req.json()
      const invoiceIds: string[] = Array.from(new Set<string>((Array.isArray(data.invoiceIds) ? data.invoiceIds : []).map((id: unknown) => String(id).trim()).filter(Boolean)))
      const code = String(data.paymentJournalCode ?? '').trim().toUpperCase()
      const config = paymentJournalByCode(code)
      if (invoiceIds.length < 2 || invoiceIds.length > 100) return NextResponse.json({ error: '请选择 2 至 100 张发票' }, { status: 400 })
      if (!config) return NextResponse.json({ error: '收款账簿无效' }, { status: 400 })
      const journal = await prisma.paymentJournal.findUnique({ where: { code: config.code }, include: { account: { select: { code: true } } } })
      if (!journal?.active) return NextResponse.json({ error: '收款账簿未配置或已停用' }, { status: 503 })
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ANY(${invoiceIds}::text[]) ORDER BY id FOR UPDATE`
        const invoices = await tx.invoice.findMany({ where: { id: { in: invoiceIds } }, orderBy: { id: 'asc' } })
        if (invoices.length !== invoiceIds.length) throw Object.assign(new Error('部分发票不存在'), { status: 404 })
        if (invoices.some(i => !['POSTED', 'PAID'].includes(String(i.status)) || toNum(i.amountDue) <= 0)) {
          throw Object.assign(new Error('所选发票必须全部为已过账且尚有待收款'), { status: 400 })
        }
        const customerId = invoices[0].customerId
        if (invoices.some(i => i.customerId !== customerId)) throw Object.assign(new Error('一次合并收款只能选择同一客户的发票'), { status: 400 })
        const allocations = invoices.map(i => ({ invoice: i, amount: round2(toNum(i.amountDue)) }))
        const total = round2(allocations.reduce((sum, x) => sum + x.amount, 0))
        const note = data.note ? String(data.note).trim().slice(0, 500) : null
        const batch = await tx.paymentBatch.create({ data: {
          customerId, paymentJournalId: journal.id, amount: total, method: config.method,
          paidAt: data.paidAt ? new Date(data.paidAt) : new Date(), note,
          createdBy: user.name ?? user.email,
        } })
        const payments = []
        for (const { invoice, amount } of allocations) {
          const payment = await tx.payment.create({ data: {
            invoiceId: invoice.id, paymentBatchId: batch.id, customerId,
            paymentJournalId: journal.id, amount, method: config.method,
            paidAt: batch.paidAt, note: note ?? `Combined receipt ${batch.id}`, createdBy: user.name ?? user.email,
          } })
          payments.push(payment)
          await recomputeInvoiceBalance(tx, invoice.id)
        }
        const entry = await postJournalEntry(tx as never, {
          narration: `Combined customer receipt ${batch.id} for ${invoices.map(i => i.name).join(', ')}`,
          sourceType: 'payment_batch', sourceId: batch.id,
          lines: [
            { code: journal.account.code, debit: total, description: `${journal.name} - combined customer receipt` },
            ...allocations.map(({ invoice, amount }) => ({ code: '1100', credit: amount, description: `AR settle - ${invoice.name}`, partnerId: customerId })),
          ],
        }, user.userId)
        if (!entry) throw new Error('找不到收款或应收科目，合并收款已取消')
        return { batch, payments, invoices: await tx.invoice.findMany({ where: { id: { in: invoiceIds } } }), journalEntry: entry }
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'payment_batch', resourceId: result.batch.id,
        detail: `客户 ${result.batch.customerId} 合并收款 ${result.payments.length} 张发票，共 €${Number(result.batch.amount).toFixed(2)}` })
      return NextResponse.json(serializeApi(result), { status: 201 })
    } catch (error) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) return NextResponse.json({ error: err.message }, { status: err.status })
      console.error('[POST /api/payments/batch]', error)
      return NextResponse.json({ error: err.message ?? '合并收款失败' }, { status: 500 })
    }
  }, { require: 'finance.payment.create' })
}
