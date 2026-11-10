import type { Prisma } from '@/lib/generated/prisma/client'
import { assignOrderToWave } from '@/lib/wave-assign'
import { syncOrderStock } from '@/lib/order-stock'

type Tx = Prisma.TransactionClient

export interface ConfirmationActor {
  userId: string
  name?: string | null
  email?: string | null
}

export class OrderConfirmationError extends Error {
  status: number
  constructor(message: string, status = 409) {
    super(message)
    this.name = 'OrderConfirmationError'
    this.status = status
  }
}

/**
 * The single business entry point for confirming orders.
 * Call only inside the caller's transaction so state, wave/pallet, stock
 * reconciliation, delivery slip, and order audit either all commit or all roll back.
 */
export async function confirmOrdersInTransaction(
  tx: Tx,
  orderIds: string[],
  actor: ConfirmationActor,
  options: { allowAlreadyConfirmed?: boolean } = {},
) {
  const ids = [...new Set(orderIds)].sort()
  if (ids.length === 0) throw new OrderConfirmationError('没有可确认的订单', 400)

  // Stable lock order prevents two overlapping bulk confirmations from deadlocking.
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ANY(${ids}) ORDER BY "id" FOR UPDATE`
  const orders = await tx.order.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      code: true,
      status: true,
      confirmationDate: true,
      deliveryDate: true,
      driverSlotId: true,
      restaurantId: true,
      restaurantName: true,
      totalAmount: true,
    },
    orderBy: { id: 'asc' },
  })
  if (orders.length !== ids.length) throw new OrderConfirmationError('所选订单中有记录不存在', 404)

  const alreadyConfirmed = new Set<string>()
  for (const order of orders) {
    if (order.status === 'PENDING') continue
    if (options.allowAlreadyConfirmed && ['CONFIRMED', 'WAVE_ASSIGNED'].includes(String(order.status))) {
      alreadyConfirmed.add(order.id)
      continue
    }
    throw new OrderConfirmationError(`订单 ${order.code ?? order.id} 当前状态为 ${order.status}，不能确认`)
  }

  const now = new Date()
  const confirmed: Array<{ id: string; status: string; waveId: string | null }> = []
  for (const order of orders) {
    const wasAlreadyConfirmed = alreadyConfirmed.has(order.id)
    const updated = wasAlreadyConfirmed
      ? order
      : await tx.order.update({
          where: { id: order.id },
          data: { status: 'CONFIRMED', confirmationDate: now },
        })

    let waveId: string | null = null
    if (order.driverSlotId) {
      const assignment = await assignOrderToWave(order.id, order.driverSlotId, tx)
      if (!assignment) {
        throw new OrderConfirmationError(`订单 ${order.code ?? order.id} 的预安排司机批次无效，确认已取消`)
      }
      waveId = assignment.waveId
    }

    // Confirming creates forecast demand from order status; it does not ship
    // stock. Keep the stock ledger aligned in this transaction for legacy rows.
    await syncOrderStock(tx, order.id, {
      reason: '订单确认库存对账',
      userId: actor.userId,
      createdBy: actor.name ?? actor.email ?? null,
    })

    await tx.deliverySlip.upsert({
      where: { orderId: order.id },
      create: {
        orderId: order.id,
        customerId: order.restaurantId,
        customerName: order.restaurantName,
        deliveryDate: order.deliveryDate,
      },
      update: {
        customerId: order.restaurantId,
        customerName: order.restaurantName,
        deliveryDate: order.deliveryDate,
      },
    })

    if (!wasAlreadyConfirmed) {
      await tx.orderAuditLog.create({
        data: {
          orderId: order.id,
          userId: actor.userId,
          action: 'confirmed',
          totalBefore: Number(order.totalAmount),
          totalAfter: Number(order.totalAmount),
          changedFields: {
            status: { before: order.status, after: waveId ? 'WAVE_ASSIGNED' : 'CONFIRMED' },
            confirmationDate: { before: order.confirmationDate, after: now.toISOString() },
          },
        },
      })
    }

    // assignOrderToWave moves the status to WAVE_ASSIGNED when a slot is present.
    confirmed.push({ id: updated.id, status: waveId ? 'WAVE_ASSIGNED' : String(order.status === 'WAVE_ASSIGNED' ? 'WAVE_ASSIGNED' : 'CONFIRMED'), waveId })
  }
  return confirmed
}
