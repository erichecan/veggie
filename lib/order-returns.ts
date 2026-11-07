import type { Prisma } from '@/lib/generated/prisma/client'

type Tx = Prisma.TransactionClient

export class OrderReturnInputError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'OrderReturnInputError'
    this.status = status
  }
}

export interface CreateOrderReturnInput {
  orderId: string
  orderLineId: string
  quantity: number
  reason?: string
  actionType?: 'return' | 'exchange'
  exchangeOrderId?: string
  sourceTripId?: string
  photo?: string
  lateReportNote?: string
}

/**
 * Write both manual and driver reports into OrderReturn, tied to one exact order line.
 * The order row lock serializes competing registrations and approval-side reductions.
 */
export async function createOrderReturn(tx: Tx, input: CreateOrderReturnInput, actor: { userId: string; name?: string | null }) {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new OrderReturnInputError('退货数量必须是大于 0 的有效数字')
  }
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${input.orderId} FOR UPDATE`
  const order = await tx.order.findUnique({
    where: { id: input.orderId },
    select: { id: true, code: true, status: true, restaurantId: true, restaurantName: true },
  })
  if (!order) throw new OrderReturnInputError('订单不存在', 404)

  let trip: { id: string; status: string; restaurants: unknown } | null = null
  if (input.sourceTripId) {
    trip = await tx.trip.findUnique({ where: { id: input.sourceTripId }, select: { id: true, status: true, restaurants: true } })
    if (!trip) throw new OrderReturnInputError('行程不存在', 404)
    if (!['VERIFYING', 'IN_PROGRESS', 'COMPLETED'].includes(String(trip.status))) {
      throw new OrderReturnInputError(`当前行程状态 ${trip.status} 不允许提交退货`)
    }
    const stops = Array.isArray(trip.restaurants) ? trip.restaurants as Array<{ restaurantId?: string; orderIds?: string[] }> : []
    if (!stops.some(stop => stop.restaurantId === order.restaurantId && (stop.orderIds ?? []).includes(order.id))) {
      throw new OrderReturnInputError('该订单不属于当前司机行程', 403)
    }
  } else if (!['IN_DELIVERY', 'COMPLETED'].includes(String(order.status))) {
    throw new OrderReturnInputError(`订单状态 ${order.status} 还没送达，不能登记退货`)
  }

  const line = await tx.orderLine.findFirst({
    where: { id: input.orderLineId, orderId: input.orderId },
    select: { id: true, productId: true, productName: true, unitPrice: true, orderedQty: true, deliveredQty: true },
  })
  if (!line) throw new OrderReturnInputError('订单行不属于这张订单或已不存在', 404)

  const reserved = await tx.orderReturn.aggregate({
    where: { orderLineId: line.id, status: { in: ['WAREHOUSE_PENDING', 'PENDING_REVIEW'] } },
    _sum: { quantity: true },
  })
  // A driver may report during delivery before deliveredQty is finalized; only then use orderedQty
  // as a temporary ceiling. Once any delivered quantity is known, both entry points share it.
  const delivered = Number(line.deliveredQty)
  const capacity = delivered > 0 ? delivered : input.sourceTripId ? Number(line.orderedQty) : 0
  const remaining = Math.max(0, capacity - Number(reserved._sum.quantity ?? 0))
  if (input.quantity > remaining + 0.0005) {
    throw new OrderReturnInputError(`退货数量不能超过该订单行可退数量 ${remaining}`)
  }

  return tx.orderReturn.create({
    data: {
      orderId: order.id,
      orderLineId: line.id,
      sourceTripId: input.sourceTripId,
      productId: line.productId,
      productName: line.productName,
      quantity: input.quantity,
      unitPrice: line.unitPrice,
      reason: input.reason?.trim() || undefined,
      actionType: input.actionType ?? 'return',
      exchangeOrderId: input.actionType === 'exchange' ? input.exchangeOrderId?.trim() || undefined : undefined,
      photo: input.photo?.trim() || undefined,
      lateReportNote: input.lateReportNote?.trim() || undefined,
      registeredById: actor.userId,
      registeredByName: actor.name,
    },
  })
}
