
import { apiRouteErrorResponse } from '@/lib/api-route-error'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import { orderIncTaxTotal } from '@/lib/order-items'
import { addBusinessDays } from '@/lib/analytics/metrics'
import { resolvePortalOwnerIds } from '@/lib/customer-portal-auth'

/** Read only an issued statement owned by the authenticated restaurant account. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async user => {
    try {
      const { id } = await params
      const ownerIds = await resolvePortalOwnerIds(user.userId, user.customerId)
      const statement = await prisma.statement.findFirst({ where: { id, customerId: { in: ownerIds }, status: 'sent' } })
      if (!statement) return NextResponse.json({ error: '对账单不存在' }, { status: 404 })
      const endExclusive = addBusinessDays(statement.periodEnd, 1)
      const [orders, payments, credits] = await Promise.all([
        prisma.order.findMany({ where: { id: { in: statement.orderIds }, restaurantId: { in: ownerIds } }, orderBy: { deliveryDate: 'asc' }, select: {
          id: true, code: true, deliveryDate: true, lines: { select: { subtotal: true, taxRate: true } },
        } }),
        prisma.payment.findMany({ where: { customerId: { in: ownerIds }, paidAt: { gte: statement.periodStart, lt: endExclusive } }, orderBy: { paidAt: 'asc' }, select: {
          id: true, amount: true, paidAt: true, method: true, invoice: { select: { name: true } },
        } }),
        prisma.creditNote.findMany({ where: { id: { in: statement.creditNoteIds }, customerId: { in: ownerIds } }, orderBy: { creditDate: 'asc' }, select: {
          id: true, name: true, creditDate: true, totalIncTax: true,
        } }),
      ])
      return NextResponse.json(serializeApi({
        id: statement.id, customerName: statement.customerName, periodStart: statement.periodStart, periodEnd: statement.periodEnd,
        openingBalance: statement.openingBalance, totalSales: statement.totalSales, totalPayments: statement.totalPayments,
        totalCredits: statement.totalCredits, closingBalance: statement.closingBalance,
        orders: orders.map(order => ({ id: order.id, code: order.code, deliveryDate: order.deliveryDate, amount: orderIncTaxTotal(order.lines) })),
        payments: payments.map(payment => ({ id: payment.id, date: payment.paidAt, method: payment.method, invoiceName: payment.invoice?.name ?? null, amount: toNum(payment.amount) })),
        credits: credits.map(credit => ({ id: credit.id, name: credit.name, date: credit.creditDate, amount: toNum(credit.totalIncTax) })),
      }))
    } catch (error) {
      console.error('[GET /api/customer-portal/statements/[id]]', error)
      return apiRouteErrorResponse(error, '获取对账单明细失败')
    }
  }, { require: 'portal.self.access' })
}
