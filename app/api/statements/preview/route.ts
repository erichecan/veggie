import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import { orderIncTaxTotal } from '@/lib/order-items'
import { addBusinessDays, BUSINESS_TIMEZONE } from '@/lib/analytics/metrics'
import { reconcileStatement, paymentSource, paymentConfirmationId, resolveStatementPeriod, summarizeStatement, StatementInputError } from '@/lib/finance/statement'

const BILLABLE_STATUSES = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED', 'LOCKED']
const round2 = (amount: number) => Math.round(amount * 100) / 100

/** Live customer ledger preview. This is deliberately read-only; it does not create a Statement row. */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const params = new URL(req.url).searchParams
      const customerId = params.get('customerId')
      const startInput = params.get('periodStart')
      const endInput = params.get('periodEnd')
      if (!customerId || !startInput || !endInput) {
        return NextResponse.json({ error: '请选择客户并填写开始、结束日期' }, { status: 400 })
      }
      let period
      try { period = resolveStatementPeriod(startInput, endInput) }
      catch (e) {
        if (e instanceof StatementInputError) return NextResponse.json({ error: e.message }, { status: 400 })
        throw e
      }

      const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true } })
      if (!customer) return NextResponse.json({ error: '客户不存在' }, { status: 404 })

      const orderSelect = { id: true, code: true, status: true, confirmationDate: true, deliveryDate: true, lines: { select: { subtotal: true, taxRate: true } } }
      const [priorStatement, priorOrders, priorPayments, priorCredits, orderRows, paymentRows, creditRows, openInvoices] = await Promise.all([
        prisma.statement.findFirst({ where: { customerId, periodEnd: { lt: period.start } }, orderBy: { periodEnd: 'desc' }, select: { closingBalance: true } }),
        prisma.order.findMany({ where: { restaurantId: customerId, status: { in: BILLABLE_STATUSES as never[] }, deliveryDate: { lt: period.start } }, select: { lines: { select: { subtotal: true, taxRate: true } } } }),
        prisma.payment.findMany({ where: { customerId, paidAt: { lt: period.start } }, select: { amount: true } }),
        prisma.creditNote.findMany({ where: { customerId, status: { in: ['CONFIRMED', 'APPLIED'] }, creditDate: { lt: period.start } }, select: { totalIncTax: true } }),
        prisma.order.findMany({ where: { restaurantId: customerId, status: { in: BILLABLE_STATUSES as never[] }, deliveryDate: { gte: period.start, lt: period.endExclusive } }, orderBy: { deliveryDate: 'asc' }, select: orderSelect }),
        prisma.payment.findMany({ where: { customerId, paidAt: { gte: period.start, lt: period.endExclusive } }, orderBy: { paidAt: 'asc' }, select: { id: true, invoiceId: true, amount: true, method: true, paidAt: true, note: true, createdBy: true } }),
        prisma.creditNote.findMany({ where: { customerId, status: { in: ['CONFIRMED', 'APPLIED'] }, creditDate: { gte: period.start, lt: period.endExclusive } }, orderBy: { creditDate: 'asc' }, select: { id: true, name: true, creditDate: true, subtotalExTax: true, totalTax: true, totalIncTax: true, notes: true, lines: { select: { sourceOrderId: true } } } }),
        prisma.invoice.findMany({ where: { customerId, status: 'POSTED', amountDue: { gt: 0 } }, select: { name: true, dueDate: true, amountDue: true } }),
      ])

      const openingBalance = priorStatement
        ? toNum(priorStatement.closingBalance)
        : round2(priorOrders.reduce((s, o) => s + orderIncTaxTotal(o.lines), 0) - priorPayments.reduce((s, p) => s + toNum(p.amount), 0) - priorCredits.reduce((s, c) => s + toNum(c.totalIncTax), 0))

      const paymentInvoiceIds = [...new Set(paymentRows.map(p => p.invoiceId).filter((id): id is string => id != null))]
      const invoiceNames = paymentInvoiceIds.length ? await prisma.invoice.findMany({ where: { id: { in: paymentInvoiceIds } }, select: { id: true, name: true } }) : []
      const invoiceById = new Map(invoiceNames.map(i => [i.id, i.name]))
      const linkedInvoices = orderRows.length ? await prisma.invoice.findMany({ where: { saleOrderIds: { hasSome: orderRows.map(o => o.id) } }, select: { name: true, createdAt: true, postedAt: true, saleOrderIds: true } }) : []
      const invoicesByOrder = new Map<string, Array<{ name: string; issueDate: Date }>>()
      for (const invoice of linkedInvoices) for (const orderId of invoice.saleOrderIds) {
        if (!orderRows.some(o => o.id === orderId)) continue
        const rows = invoicesByOrder.get(orderId) ?? []
        rows.push({ name: invoice.name, issueDate: invoice.postedAt ? new Date(invoice.postedAt) : invoice.createdAt })
        invoicesByOrder.set(orderId, rows)
      }

      const orders = orderRows.map(o => ({ id: o.id, code: o.code, status: o.status, confirmationDate: o.confirmationDate, deliveryDate: o.deliveryDate, incTaxTotal: orderIncTaxTotal(o.lines), invoices: invoicesByOrder.get(o.id) ?? [] }))
      const payments = paymentRows.map(p => ({ id: p.id, invoiceId: p.invoiceId, invoiceName: p.invoiceId ? invoiceById.get(p.invoiceId) ?? null : null, amount: toNum(p.amount), method: p.method, paidAt: p.paidAt, note: p.note, createdBy: p.createdBy, source: paymentSource(p.note), confirmationId: paymentConfirmationId(p.note) }))
      const credits = creditRows.map(c => ({ id: c.id, name: c.name, creditDate: c.creditDate, amount: toNum(c.totalIncTax), subtotalExTax: toNum(c.subtotalExTax), tax: toNum(c.totalTax), notes: c.notes, sourceOrderIds: [...new Set(c.lines.map(l => l.sourceOrderId).filter((id): id is string => id != null))] }))
      const summary = summarizeStatement(openingBalance, orders, payments, credits)
      const reconciliation = reconcileStatement({ stored: summary, orders, payments, credits })

      const today = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
      const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unknown: 0 }
      const overdueInvoices = openInvoices.map(invoice => {
        const dueDate = invoice.dueDate?.slice(0, 10) ?? null
        const days = dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86400000) : null
        const bucket = days === null ? 'unknown' : days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus'
        buckets[bucket] += toNum(invoice.amountDue)
        return { name: invoice.name, dueDate, amountDue: toNum(invoice.amountDue), overdueDays: days }
      })

      return NextResponse.json(serializeApi({
        id: 'live-preview', customerId, customerName: customer.name,
        periodStart: period.start, periodEnd: period.endLabel, createdAt: new Date(), sentAt: null, status: 'preview',
        ...summary, orders, payments, credits, reconciliation, missingOrderIds: [],
        aging: { totalOutstanding: round2(openInvoices.reduce((s, i) => s + toNum(i.amountDue), 0)), buckets, invoices: overdueInvoices },
      }))
    } catch (error) {
      console.error('[GET /api/statements/preview]', error)
      return NextResponse.json({ error: '查询客户交易明细失败' }, { status: 500 })
    }
  }, { require: 'finance.statement.read' })
}
