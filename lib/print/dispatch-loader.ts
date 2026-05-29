/**
 * Dispatch 打印数据加载（server-only）
 *
 * 按 deliveryDate + driverSlotId 查询 Orders，构造 TripPrintDataWire
 * 复用已有的 trip 打印模板（picking / delivery / summary）。
 */

import 'server-only'
import { prisma } from '@/lib/db'
import type {
  GoodsType,
  TripCustomer,
  TripOrder,
  TripPrintDataWire,
} from './trip-common'

const toNum = (v: unknown): number => {
  if (v == null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'string') return Number(v)
  if (typeof v === 'object' && v !== null && 'toNumber' in v && typeof (v as { toNumber: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber()
  }
  return Number(v)
}

const toIso = (v: unknown): string | null => {
  if (!v) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  return null
}

async function loadGoodsTypeMap(uomIds: string[]): Promise<Map<string, GoodsType>> {
  const map = new Map<string, GoodsType>()
  if (uomIds.length === 0) return map
  try {
    const rows = await prisma.$queryRaw<Array<{ id: string; goodsType: string | null }>>`
      SELECT id, "goodsType" FROM "Uom" WHERE id = ANY(${uomIds})
    `
    for (const r of rows) {
      const g = r.goodsType
      map.set(r.id, g === 'BULK' || g === 'LOOSE' ? g : null)
    }
  } catch (e) {
    console.warn('[dispatch-print] Uom.goodsType column not available:', (e as Error).message)
  }
  return map
}

export async function loadDispatchPrintData(
  date: string,
  driverSlotId: string,
  fromDate?: string,
): Promise<TripPrintDataWire | null> {
  const slot = await prisma.driverSlot.findUnique({ where: { id: driverSlotId } })
  if (!slot) return null

  const rangeStart = new Date(`${fromDate ?? date}T00:00:00.000Z`)
  const dayEnd = new Date(`${date}T23:59:59.999Z`)

  // Match by driverSlotId OR legacy deliveryBatch string (some orders only have the string)
  const slotLabel = `${slot.batchNum} ${slot.timeOfDay} ${slot.driverName}`

  const statusFilter: Array<'CONFIRMED' | 'WAVE_ASSIGNED' | 'IN_DELIVERY' | 'COMPLETED'> = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED']

  // Try with date filter first (deliveryDate or createdAt), fall back to no date filter
  let orders = await prisma.order.findMany({
    where: {
      status: { in: statusFilter },
      AND: [
        {
          OR: [
            { deliveryDate: { gte: rangeStart, lte: dayEnd } },
            { deliveryDate: null, createdAt: { gte: rangeStart, lte: dayEnd } },
          ],
        },
        {
          OR: [
            { driverSlotId },
            { deliveryBatch: slotLabel },
          ],
        },
      ],
    },
    include: { lines: { orderBy: { sequence: 'asc' } } },
    orderBy: { restaurantName: 'asc' },
  })

  // Fallback: if no orders found with date filter, load all orders for this slot
  // (many orders have deliveryDate=null and may have been created on a different day)
  if (orders.length === 0) {
    orders = await prisma.order.findMany({
      where: {
        status: { in: statusFilter },
        OR: [
          { driverSlotId },
          { deliveryBatch: slotLabel },
        ],
      },
      include: { lines: { orderBy: { sequence: 'asc' } } },
      orderBy: { restaurantName: 'asc' },
    })
  }

  if (orders.length === 0) return null

  const customerIds = [...new Set(orders.map(o => o.restaurantId))]
  const customerRows = customerIds.length > 0
    ? await prisma.customer.findMany({ where: { id: { in: customerIds } } })
    : []

  const uomIds = [...new Set(
    orders.flatMap(o => o.lines).map(l => l.uomId).filter((x): x is string => !!x),
  )]
  const goodsTypeMap = await loadGoodsTypeMap(uomIds)

  const customers: TripCustomer[] = customerRows.map(c => ({
    id: c.id,
    name: c.name,
    street: c.street ?? '',
    street2: c.street2 ?? '',
    city: c.city ?? null,
    state: c.state ?? '',
    zip: c.zip ?? '',
    country: c.country ?? '',
    phone: c.phone ?? '',
    vatNumber: c.vatNumber ?? '',
    paymentTerm: c.paymentTerm ?? '',
  }))

  const printOrders: TripOrder[] = orders.map(o => ({
    id: o.id,
    code: o.code,
    customerId: o.restaurantId,
    customerName: o.restaurantName,
    totalAmount: toNum(o.totalAmount),
    internalNote: o.internalNote,
    deliveryDate: toIso(o.deliveryDate),
    lines: o.lines.map(l => ({
      productId: l.productId,
      productName: l.productName,
      spec: l.spec ?? null,
      uomId: l.uomId,
      uomName: l.uomName,
      goodsType: l.uomId ? (goodsTypeMap.get(l.uomId) ?? null) : null,
      orderedQty: toNum(l.orderedQty),
      unitPrice: toNum(l.unitPrice),
      taxRate: toNum(l.taxRate),
      subtotal: toNum(l.subtotal),
    })),
  }))

  const timeSlotMap: Record<string, string> = { am: 'AM', pm: 'PM' }

  return {
    trip: {
      id: `dispatch-${driverSlotId}-${date}`,
      name: `${slot.driverName} #${slot.batchNum} ${slot.timeOfDay.toUpperCase()}`,
      timeSlot: timeSlotMap[slot.timeOfDay] ?? slot.timeOfDay,
      driverName: slot.driverName,
      departTime: null,
      createdAt: new Date().toISOString(),
    },
    orders: printOrders,
    customers,
  }
}
