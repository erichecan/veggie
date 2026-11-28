
import { apiRouteErrorResponse } from '@/lib/api-route-error'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { createOrderReturn, OrderReturnInputError } from '@/lib/order-returns'

/** Register a known-source historical return from the driver's customer search. */
export async function POST(req: Request) {
  return withAuth(req, async user => {
    try {
      const body = await req.json() as {
        orderId?: string; orderLineId?: string; quantity?: number
        reason?: string; photo?: string; lateReportNote?: string
      }
      if (!body.orderId || !body.orderLineId || !Number.isFinite(body.quantity) || Number(body.quantity) <= 0) {
        return NextResponse.json({ error: '请选择订单商品并填写有效数量' }, { status: 400 })
      }
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
      const photo = typeof body.photo === 'string' ? body.photo.trim() : ''
      const lateReportNote = typeof body.lateReportNote === 'string' ? body.lateReportNote.trim().slice(0, 500) : ''
      if (!reason) return NextResponse.json({ error: '请填写退货原因' }, { status: 400 })
      if (!/^data:image\/(?:jpeg|png|webp);base64,/.test(photo) || photo.length > 8_000_000) return NextResponse.json({ error: '请上传有效的现场照片' }, { status: 400 })

      const [order, trips] = await Promise.all([
        prisma.order.findUnique({ where: { id: body.orderId }, select: {
          id: true, code: true, status: true, driverSlot: { select: { userId: true } },
        } }),
        prisma.trip.findMany({ where: { driverId: user.userId }, select: { id: true, status: true, restaurants: true } }),
      ])
      if (!order) return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      const linkedTrips = trips.filter(trip => Array.isArray(trip.restaurants) &&
        (trip.restaurants as Array<{ orderIds?: string[] }>).some(stop => stop.orderIds?.includes(order.id)))
      if (order.driverSlot?.userId !== user.userId && linkedTrips.length === 0) {
        return NextResponse.json({ error: '只能登记分配给自己的配送订单' }, { status: 403 })
      }
      if (!['IN_DELIVERY', 'COMPLETED', 'LOCKED'].includes(String(order.status))) {
        return NextResponse.json({ error: '只能登记已出车订单的退货' }, { status: 400 })
      }
      if (['COMPLETED', 'LOCKED'].includes(String(order.status)) && !lateReportNote) {
        return NextResponse.json({ error: '已完成订单需要填写补报原因' }, { status: 400 })
      }

      const line = await prisma.orderLine.findFirst({ where: { id: body.orderLineId, orderId: order.id }, select: { id: true, productName: true } })
      if (!line) return NextResponse.json({ error: '商品不属于所选订单' }, { status: 404 })
      const sourceTrip = linkedTrips.find(trip => ['VERIFYING', 'IN_PROGRESS', 'COMPLETED'].includes(String(trip.status)))
      const created = await prisma.$transaction(tx => createOrderReturn(tx, {
        orderId: order.id,
        orderLineId: line.id,
        quantity: Number(body.quantity),
        reason,
        photo,
        lateReportNote: lateReportNote || undefined,
        returnKind: order.status === 'IN_DELIVERY' ? 'CURRENT' : 'HISTORICAL',
        sourceTripId: sourceTrip?.id,
      }, user))

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'order_return', resourceId: created.id,
        detail: `司机按客户查单登记退货: ${order.code ?? order.id} — ${created.productName} × ${body.quantity}`,
      })
      return NextResponse.json({ id: created.id, status: created.status, productName: created.productName }, { status: 201 })
    } catch (error) {
      if (error instanceof OrderReturnInputError) return NextResponse.json({ error: error.message }, { status: error.status })
      console.error('[POST /api/driver/returns]', error)
      return apiRouteErrorResponse(error, '退货登记失败')
    }
  }, { require: 'dispatch.trip.report_return' })
}
