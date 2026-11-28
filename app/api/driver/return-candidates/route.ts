
import { apiRouteErrorResponse } from '@/lib/api-route-error'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { RETURNS_FLOOR_DATE } from '@/lib/accounting/returns-constants'

/** Search only the signed-in driver's delivered orders for a known-source return. */
export async function GET(req: Request) {
  return withAuth(req, async user => {
    try {
      const q = new URL(req.url).searchParams.get('q')?.trim().slice(0, 120) ?? ''
      if (q.length < 2) return NextResponse.json([])

      const trips = await prisma.trip.findMany({
        where: { driverId: user.userId },
        select: { id: true, status: true, restaurants: true },
      })
      const tripIdsByOrder = new Map<string, string[]>()
      const activeTripIdByOrder = new Map<string, string>()
      for (const trip of trips) {
        const ids = Array.isArray(trip.restaurants)
          ? [...new Set((trip.restaurants as Array<{ orderIds?: string[] }>).flatMap(stop => stop.orderIds ?? []))]
          : []
        for (const id of ids) {
          tripIdsByOrder.set(id, [...(tripIdsByOrder.get(id) ?? []), trip.id])
          if (!activeTripIdByOrder.has(id) && ['VERIFYING', 'IN_PROGRESS', 'COMPLETED'].includes(String(trip.status))) activeTripIdByOrder.set(id, trip.id)
        }
      }
      const assignedOrderIds = [...tripIdsByOrder.keys()]
      const orders = await prisma.order.findMany({
        where: {
          status: { in: ['IN_DELIVERY', 'COMPLETED', 'LOCKED'] },
          deliveryDate: { gte: new Date(`${RETURNS_FLOOR_DATE}T00:00:00Z`) },
          OR: [
            { driverSlot: { userId: user.userId } },
            ...(assignedOrderIds.length ? [{ id: { in: assignedOrderIds } }] : []),
          ],
          restaurantName: { contains: q, mode: 'insensitive' },
        },
        orderBy: [{ deliveryDate: 'desc' }, { restaurantName: 'asc' }],
        take: 60,
        select: {
          id: true, code: true, restaurantId: true, restaurantName: true, deliveryDate: true, status: true,
          lines: { orderBy: { sequence: 'asc' }, select: { id: true, productId: true, productName: true, spec: true, orderedQty: true, deliveredQty: true, uomName: true } },
        },
      })
      const lineIds = orders.flatMap(order => order.lines.map(line => line.id))
      const returns = lineIds.length ? await prisma.orderReturn.findMany({
        where: { orderLineId: { in: lineIds }, OR: [
          { status: { in: ['WAREHOUSE_PENDING', 'PENDING_REVIEW'] } },
          { status: 'APPROVED', workflowVersion: 2 },
          { status: 'SETTLED', workflowVersion: 2 },
        ] },
        select: { orderLineId: true, status: true, quantity: true, warehouseAcceptedQuantity: true, approvedQuantity: true, preservedOriginalOrder: true },
      }) : []
      const byLine = new Map<string, typeof returns>()
      for (const row of returns) {
        if (!row.orderLineId) continue
        byLine.set(row.orderLineId, [...(byLine.get(row.orderLineId) ?? []), row])
      }

      return NextResponse.json(orders.map(order => ({
        id: order.id,
        code: order.code,
        restaurantId: order.restaurantId,
        restaurantName: order.restaurantName,
        deliveryDate: order.deliveryDate?.toISOString().slice(0, 10) ?? null,
        status: order.status,
        lines: order.lines.map(line => {
          const history = byLine.get(line.id) ?? []
          const reserved = history.filter(row => ['WAREHOUSE_PENDING', 'PENDING_REVIEW', 'APPROVED'].includes(String(row.status)))
            .reduce((sum, row) => sum + Number(row.warehouseAcceptedQuantity ?? row.quantity), 0)
          const settled = history.filter(row => row.status === 'SETTLED')
          const uncreditedPhysical = Math.max(0, settled.reduce((sum, row) => sum + Number(row.warehouseAcceptedQuantity ?? 0) - Number(row.approvedQuantity ?? 0), 0))
          const preserved = settled.filter(row => row.preservedOriginalOrder).reduce((sum, row) => sum + Number(row.approvedQuantity ?? 0), 0)
          const delivered = Number(line.deliveredQty)
          const capacity = delivered > 0 ? delivered : order.status === 'IN_DELIVERY' && activeTripIdByOrder.has(order.id) ? Number(line.orderedQty) : 0
          return {
            id: line.id, productId: line.productId, productName: line.productName,
            spec: line.spec, uomName: line.uomName,
            remainingQty: Math.max(0, capacity - reserved - uncreditedPhysical - preserved),
          }
        }).filter(line => line.remainingQty > 0.0005),
      })).filter(order => order.lines.length > 0))
    } catch (error) {
      console.error('[GET /api/driver/return-candidates]', error)
      return apiRouteErrorResponse(error, '获取可登记订单失败')
    }
  }, { require: 'dispatch.trip.report_return' })
}
