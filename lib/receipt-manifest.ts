import type { Prisma } from '@/lib/generated/prisma/client'
import { toDayKey } from '@/lib/analytics/metrics'
import { round2 } from '@/lib/decimal-helpers'

type Tx = Prisma.TransactionClient
type TripSnapshot = { id: string; restaurants: unknown; driverId: string | null; driverName: string | null; vehiclePlate: string | null }

export async function freezeReceiptManifest(tx: Tx, trip: TripSnapshot, departedAt: Date) {
  const created = await tx.receiptManifest.createMany({
    data: { tripId: trip.id, businessDate: toDayKey(departedAt), departedAt, driverId: trip.driverId, driverName: trip.driverName, vehiclePlate: trip.vehiclePlate },
    skipDuplicates: true,
  })
  if (!created.count) return
  const stops = Array.isArray(trip.restaurants) ? trip.restaurants as Array<{ orderIds?: string[] }> : []
  const ids = [...new Set(stops.flatMap(stop => stop.orderIds ?? []))]
  if (!ids.length) return
  const [orders, adjustments] = await Promise.all([
    tx.order.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, restaurantName: true, totalAmount: true } }),
    tx.orderAdjustment.groupBy({ by: ['orderId'], where: { orderId: { in: ids } }, _sum: { amount: true } }),
  ])
  const totals = new Map(adjustments.map(row => [row.orderId, Number(row._sum.amount ?? 0)]))
  await tx.receiptManifestEntry.createMany({ data: orders.map(order => ({
    tripId: trip.id, orderId: order.id, orderCode: order.code, customerName: order.restaurantName,
    expectedAmount: round2(Number(order.totalAmount) + (totals.get(order.id) ?? 0)),
  })) })
}

/** The caller holds order locks. A driver report submitted later cannot erase a detection. */
export async function markUnreportedReceiptIssues(tx: Tx, orderIds: string[], tripId?: string | null) {
  if (!orderIds.length) return
  const candidates = await tx.receiptManifestEntry.findMany({
    where: { orderId: { in: orderIds }, unreportedDetectedAt: null, ...(tripId ? { tripId } : {}) },
    select: { tripId: true, orderId: true, manifest: { select: { driverId: true, departedAt: true } } },
    orderBy: { manifest: { departedAt: 'desc' } },
  })
  if (!candidates.length) return
  const entries = new Map<string, typeof candidates[number]>()
  for (const entry of candidates) if (!entries.has(entry.orderId)) entries.set(entry.orderId, entry)
  const returns = await tx.orderReturn.findMany({
    where: { orderId: { in: [...entries.keys()] }, sourceTripId: { not: null } },
    select: { id: true, orderId: true, sourceTripId: true, registeredById: true },
  })
  const photos = returns.length ? await tx.returnIntake.findMany({
    where: { sourceType: 'DRIVER', orderReturnId: { in: returns.map(ret => ret.id) } },
    select: { orderReturnId: true },
  }) : []
  const photoReports = new Set(photos.map(row => row.orderReturnId))
  const driverReports = new Set(returns.filter(ret => {
    const entry = entries.get(ret.orderId)
    return entry?.tripId === ret.sourceTripId && (entry?.manifest.driverId === ret.registeredById || photoReports.has(ret.id))
  }).map(ret => ret.orderId))
  const detected = [...entries.values()].filter(entry => !driverReports.has(entry.orderId))
  if (!detected.length) return
  const grouped = new Map<string, string[]>()
  for (const entry of detected) {
    const list = grouped.get(entry.tripId) ?? []
    list.push(entry.orderId)
    grouped.set(entry.tripId, list)
  }
  await tx.receiptManifestEntry.updateMany({
    where: { unreportedDetectedAt: null, OR: [...grouped].map(([candidateTrip, ids]) => ({ tripId: candidateTrip, orderId: { in: ids } })) },
    data: { unreportedDetectedAt: new Date() },
  })
}
