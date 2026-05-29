/**
 * Trip 打印数据加载（server-only）
 *
 * 仅供 /api/trips/[id]/print-data 调用。不要从客户端组件 import 本文件
 * （会把 Prisma 拖进 client bundle 导致打包失败）。
 *
 * 链路：Trip.restaurants (JSON) → orderIds[] → Order(+lines) → Customer + Uom.goodsType
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

/**
 * 取 Uom.goodsType 映射。
 * DB 列还没同步时不会报错，全部返回 null（拣货单会归入「未分类」组）。
 */
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
    console.warn('[trip-print] Uom.goodsType column not available, all items will be 未分类:', (e as Error).message)
  }
  return map
}

/** Server-only：拼装一份完整的 trip 打印数据。给 API route 调用 */
export async function loadTripPrintData(tripId: string): Promise<TripPrintDataWire | null> {
  const trip = await prisma.trip.findUnique({ where: { id: tripId } })
  if (!trip) return null

  const restaurants = Array.isArray(trip.restaurants)
    ? (trip.restaurants as Array<{ orderIds?: string[] }>)
    : []
  const orderIds = restaurants.flatMap(r => r.orderIds ?? [])

  const orders = orderIds.length > 0
    ? await prisma.order.findMany({
        where: { id: { in: orderIds } },
        include: { lines: { orderBy: { sequence: 'asc' } } },
        orderBy: { restaurantName: 'asc' },
      })
    : []

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

  return {
    trip: {
      id: trip.id,
      name: trip.name,
      timeSlot: trip.timeSlot,
      driverName: trip.driverName,
      departTime: trip.departTime,
      createdAt: trip.createdAt.toISOString(),
    },
    orders: printOrders,
    customers,
  }
}
