import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { isRowVisible, salesRowScope } from '@/lib/row-scope'

type Context = { params: Promise<{ id: string }> }

const invoiceSummarySelect = {
  id: true,
  name: true,
  customerId: true,
  saleOrderIds: true,
  totalIncTax: true,
  status: true,
  createdAt: true,
} as const

/** Link an existing same-customer invoice to this order without changing invoice amounts/status. */
export async function POST(req: Request, { params }: Context) {
  const { id } = await params
  return withAuth(req, async user => {
    try {
      const body = await req.json()
      const invoiceId = String(body.invoiceId ?? '').trim()
      if (!invoiceId) return NextResponse.json({ error: '请选择发票' }, { status: 400 })

      const [order, invoice] = await Promise.all([
        prisma.order.findUnique({
          where: { id },
          select: {
            id: true, restaurantId: true, restaurantName: true,
            salesUserId: true, createdById: true, salesUser: { select: { managerId: true } },
          },
        }),
        prisma.invoice.findUnique({ where: { id: invoiceId }, select: invoiceSummarySelect }),
      ])
      if (!order) return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      if (!invoice) return NextResponse.json({ error: '发票不存在' }, { status: 404 })
      if (!isRowVisible(order, salesRowScope(user), record => (record as { createdById?: string | null }).createdById === user.userId)) {
        return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      }
      if (!order.restaurantId || invoice.customerId !== order.restaurantId) {
        return NextResponse.json({ error: '只能关联同一客户的发票' }, { status: 400 })
      }
      if (invoice.saleOrderIds.includes(id)) return NextResponse.json(serializeApi(invoice))

      const updated = await prisma.invoice.update({
        where: { id: invoice.id },
        data: { saleOrderIds: [...invoice.saleOrderIds, id] },
        select: invoiceSummarySelect,
      })
      await writeLog({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        action: 'UPDATE',
        resource: 'invoice',
        resourceId: invoice.id,
        detail: `将发票 ${invoice.name} 关联到订单 ${order.restaurantName ?? id}`,
      })
      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[POST /api/orders/[id]/invoices]', error)
      return NextResponse.json({ error: '关联发票失败' }, { status: 500 })
    }
  }, { require: 'sales.order.update' })
}
