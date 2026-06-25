import { orderItemsFromLines } from '@/lib/order-items'
import { serializeApi } from '@/lib/api-serializer'

/**
 * 从波次生成司机行程(P0-2/A)
 * ================================================================================
 * 配送调度单一真相 = wave。Trip 只承载"司机执行 + 交账",在 wave「确认出发」时按波次
 * 生成一个 Trip(不再在订单确认时按单建)。司机身份取自 DriverSlot.userId(A2 绑定),
 * 司机端按 driverId 查自己的行程。driverName 仅作显示快照。
 */

// 接受事务句柄(项目内多处 prisma as any)
type TripTx = {
  pickingWave: { findUnique: (a: unknown) => Promise<{ id: string; name: string | null; orderIds: unknown; driverSlotId: string | null; driverName: string | null; waveType: string | null } | null> }
  driverSlot: { findUnique: (a: unknown) => Promise<{ userId: string | null; driverName: string; timeOfDay: string } | null> }
  order: { findMany: (a: unknown) => Promise<Array<{ id: string; restaurantId: string; restaurantName: string; totalAmount: unknown; lines: unknown[] }>> }
  customer: { findMany: (a: unknown) => Promise<Array<{ id: string; street: string; street2: string; city: string | null; zip: string; address: string }>> }
  trip: { create: (a: unknown) => Promise<{ id: string }> }
}

export async function createTripFromWave(tx: TripTx, waveId: string): Promise<{ id: string } | null> {
  const wave = await tx.pickingWave.findUnique({ where: { id: waveId } })
  if (!wave) return null
  const orderIds = (wave.orderIds as string[]) ?? []
  if (orderIds.length === 0) return null

  // 司机身份:优先 DriverSlot.userId(A2 绑定),名字用 slot 快照
  let driverId: string | null = null
  let driverName: string = wave.driverName ?? ''
  let timeSlot = 'AM'
  if (wave.driverSlotId) {
    const slot = await tx.driverSlot.findUnique({
      where: { id: wave.driverSlotId },
      select: { userId: true, driverName: true, timeOfDay: true },
    })
    driverId = slot?.userId ?? null
    driverName = slot?.driverName ?? driverName
    timeSlot = slot?.timeOfDay === 'pm' ? 'PM' : 'AM'
  }

  const orders = await tx.order.findMany({
    where: { id: { in: orderIds } },
    include: { lines: { orderBy: { sequence: 'asc' } } },
  })

  // 按餐馆聚合(一个波次可含多家餐馆)
  const grouped = new Map<string, { restaurantId: string; restaurantName: string; orderIds: string[]; items: unknown[] }>()
  let totalPayment = 0
  for (const o of orders) {
    totalPayment += Number(o.totalAmount)
    const g = grouped.get(o.restaurantId) ?? { restaurantId: o.restaurantId, restaurantName: o.restaurantName, orderIds: [], items: [] }
    g.orderIds.push(o.id)
    g.items.push(...orderItemsFromLines(serializeApi(o.lines) as Parameters<typeof orderItemsFromLines>[0]))
    grouped.set(o.restaurantId, g)
  }

  const custIds = [...grouped.keys()]
  const custs = await tx.customer.findMany({
    where: { id: { in: custIds } },
    select: { id: true, street: true, street2: true, city: true, zip: true, address: true },
  })
  const addrMap = new Map(custs.map((c) => {
    const parts = [c.street, c.street2, c.city, c.zip].filter(Boolean)
    return [c.id, parts.length > 0 ? parts.join(', ') : c.address] as const
  }))

  const restaurants = [...grouped.values()].map((g) => ({
    restaurantId: g.restaurantId,
    restaurantName: g.restaurantName,
    address: addrMap.get(g.restaurantId) ?? '',
    orderIds: g.orderIds,
    items: g.items,
    delivered: false,
    returns: [],
    pods: [],
    cargoVerified: false,
  }))

  return tx.trip.create({
    data: {
      waveId,
      name: wave.name ?? `${driverName} · ${restaurants.length}家餐馆`,
      driverId,
      driverName,
      timeSlot,
      status: 'PENDING',
      restaurants: restaurants as never,
      totalPayment: Math.round(totalPayment * 100) / 100,
    },
    select: { id: true },
  })
}
