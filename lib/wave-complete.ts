import { prisma } from '@/lib/db'
import { recalcTripDriverCommission } from '@/lib/commission'
import { completeDeliveredOrders, describeFailures, type CompleteOrdersResult } from '@/lib/delivery-complete'

export type CompleteWaveResult =
  | { ok: true; waveId: string; waveName: string | null; completedIds: string[]; failures: CompleteOrdersResult['failures']; tripIds: string[] }
  | { ok: false; reason: 'not-found' | 'not-dispatched' | 'already-completed' }

/** Complete a dispatched wave once; shared by the operator API and nightly job. */
export async function completeWaveDelivery(
  waveId: string,
  actor: { userId?: string | null; name?: string | null } = {},
): Promise<CompleteWaveResult> {
  const wave = await prisma.pickingWave.findUnique({ where: { id: waveId } })
  if (!wave) return { ok: false, reason: 'not-found' }
  if (!wave.dispatchedAt) return { ok: false, reason: 'not-dispatched' }

  const claim = await prisma.pickingWave.updateMany({
    where: { id: waveId, dispatchedAt: { not: null }, completedAt: null },
    data: { completedAt: new Date() },
  })
  if (claim.count === 0) return { ok: false, reason: 'already-completed' }

  const orderIds = wave.orderIds
  const { completedIds, failures } = await completeDeliveredOrders(orderIds, {
    reason: '波次自动/人工完成配送',
    userId: actor.userId,
    createdBy: actor.name,
  })

  const trips = await prisma.trip.findMany({
    where: { waveId, status: { not: 'COMPLETED' } },
    select: { id: true },
  })
  const tripIds = trips.map(t => t.id)
  if (tripIds.length > 0) {
    await prisma.trip.updateMany({ where: { id: { in: tripIds } }, data: { status: 'COMPLETED' } })
    for (const tripId of tripIds) {
      await recalcTripDriverCommission(tripId, prisma).catch(e => console.error('[wave complete: trip commission]', e))
    }
  }

  return { ok: true, waveId, waveName: wave.name, completedIds, failures, tripIds }
}

export { describeFailures }
