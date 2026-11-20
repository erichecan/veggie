import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

function dublinDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** Delivery manifest used by warehouse staff for next-morning vehicle reconciliation. */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const date = new URL(req.url).searchParams.get('date')
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return NextResponse.json({ error: '请提供有效的配送日期' }, { status: 400 })
      }

      const trips = await prisma.trip.findMany({
        where: { status: { in: ['IN_PROGRESS', 'COMPLETED'] } },
        orderBy: { createdAt: 'desc' },
        take: 2000,
      })
      const waveIds = [...new Set(trips.filter(trip => !trip.departTime && trip.waveId).map(trip => trip.waveId!))]
      const waves = waveIds.length
        ? await prisma.pickingWave.findMany({ where: { id: { in: waveIds } }, select: { id: true, dispatchedAt: true } })
        : []
      const dispatchedAt = new Map(waves.map(wave => [wave.id, wave.dispatchedAt]))
      const dayTrips = trips.filter(trip => dublinDate(
        trip.departTime ?? (trip.waveId ? dispatchedAt.get(trip.waveId) ?? trip.createdAt : trip.createdAt),
      ) === date)
      const orderIds = [...new Set(dayTrips.flatMap(trip => {
        const stops = Array.isArray(trip.restaurants) ? trip.restaurants as Array<{ orderIds?: string[] }> : []
        return stops.flatMap(stop => stop.orderIds ?? [])
      }))]
      const orders = orderIds.length ? await prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: {
          id: true,
          code: true,
          lines: { orderBy: { sequence: 'asc' }, select: { id: true, productId: true, productName: true, orderedQty: true, deliveredQty: true, uomName: true } },
        },
      }) : []
      const orderById = new Map(orders.map(order => [order.id, order]))
      const result = dayTrips.map(trip => {
        const stops = Array.isArray(trip.restaurants)
          ? trip.restaurants as Array<{ restaurantId: string; restaurantName: string; orderIds?: string[] }>
          : []
        const deliveredAt = trip.departTime ?? (trip.waveId ? dispatchedAt.get(trip.waveId)?.toISOString() : null) ?? trip.createdAt.toISOString()
        return {
          tripId: trip.id,
          tripName: trip.name ?? trip.id,
          deliveredAt,
          driverName: trip.driverName ?? '—',
          vehiclePlate: trip.vehiclePlate,
          stops: stops.map(stop => ({
            customerId: stop.restaurantId,
            customerName: stop.restaurantName,
            orders: (stop.orderIds ?? []).map(id => orderById.get(id)).filter((order): order is NonNullable<typeof order> => Boolean(order)).map(order => ({
              orderId: order.id,
              orderCode: order.code ?? order.id,
              products: order.lines.filter(line => Number(line.deliveredQty) > 0).map(line => ({
                orderLineId: line.id,
                productId: line.productId,
                productName: line.productName,
                orderedQuantity: Number(line.orderedQty),
                deliveredQuantity: Number(line.deliveredQty),
                unitName: line.uomName,
              })),
            })).filter(order => order.products.length > 0),
          })).filter(stop => stop.orders.length > 0),
        }
      }).filter(trip => trip.stops.length > 0)

      return NextResponse.json(serializeApi({ date, trips: result }))
    } catch (error) {
      console.error('[GET /api/order-returns/delivery-checklist]', error)
      return NextResponse.json({ error: '获取配送核对清单失败' }, { status: 500 })
    }
  }, { require: 'dispatch.goods_return.warehouse_verify' })
}
