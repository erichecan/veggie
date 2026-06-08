/**
 * Dispatch 打印数据加载（server-only）
 *
 * 按 deliveryDate + driverSlotId 查询 Orders，构造 TripPrintDataWire
 * 复用已有的 trip 打印模板（picking / delivery / summary）。
 */

import 'server-only'
import { prisma } from '@/lib/db'
import {
  buildLinesFromItems,
  type GoodsType,
  type TripCustomer,
  type TripOrder,
  type TripPrintDataWire,
} from './trip-common'

/** 单批次打印的最大订单数，超出则截断并在打印顶部提示 */
const MAX_PRINT_ORDERS = 50

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

/** 批次选择器：用 DriverSlot id，或回退到批次字符串 "2 pm AFZAAL"（无 DriverSlot 记录时） */
export interface DispatchSelector {
  driverSlotId?: string | null
  batchLabel?: string | null
}

export async function loadDispatchPrintData(
  date: string,
  selector: DispatchSelector,
  fromDate?: string,
): Promise<TripPrintDataWire | null> {
  // Resolve batch identity from either the DriverSlot record or the label string
  let slot = selector.driverSlotId
    ? await prisma.driverSlot.findUnique({ where: { id: selector.driverSlotId } })
    : null

  let batchNum: number
  let timeOfDay: string
  let driverName: string
  let slotLabel: string

  if (slot) {
    batchNum = slot.batchNum
    timeOfDay = slot.timeOfDay
    driverName = slot.driverName
    slotLabel = `${slot.batchNum} ${slot.timeOfDay} ${slot.driverName}`
  } else if (selector.batchLabel) {
    const parts = selector.batchLabel.trim().split(/\s+/)
    batchNum = parseInt(parts[0] ?? '0', 10) || 0
    timeOfDay = (parts[1] ?? '').toLowerCase()
    driverName = parts.slice(2).join(' ')
    slotLabel = selector.batchLabel
    // Resolve a matching slot so orders linked only by driverSlotId are still found
    slot = await prisma.driverSlot.findFirst({ where: { batchNum, timeOfDay, driverName } })
  } else {
    return null
  }

  const rangeStart = new Date(`${fromDate ?? date}T00:00:00.000Z`)
  const dayEnd = new Date(`${date}T23:59:59.999Z`)

  // Match by driverSlotId OR legacy deliveryBatch string (some orders only have the string)
  const batchMatch = slot
    ? [{ driverSlotId: slot.id }, { deliveryBatch: slotLabel }]
    : [{ deliveryBatch: slotLabel }]

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
        { OR: batchMatch },
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
        OR: batchMatch,
      },
      include: { lines: { orderBy: { sequence: 'asc' } } },
      orderBy: { restaurantName: 'asc' },
    })
  }

  if (orders.length === 0) return null

  // 截断保护：单批次累积大量历史订单时，避免一次渲染上千页发票
  const totalMatched = orders.length
  const truncated = totalMatched > MAX_PRINT_ORDERS
  if (truncated) orders = orders.slice(0, MAX_PRINT_ORDERS)

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
    // 优先用 OrderLine；为空时回退到旧版 items JSON（历史迁移订单两者皆空 → []）
    lines: o.lines.length > 0
      ? o.lines.map(l => ({
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
        }))
      : buildLinesFromItems(o.items),
  }))

  const timeSlotMap: Record<string, string> = { am: 'AM', pm: 'PM' }

  return {
    trip: {
      id: `dispatch-${slot?.id ?? slotLabel}-${date}`,
      name: `${driverName} #${batchNum} ${timeOfDay.toUpperCase()}`,
      timeSlot: timeSlotMap[timeOfDay] ?? timeOfDay,
      driverName: driverName,
      departTime: null,
      createdAt: new Date().toISOString(),
      notice: truncated
        ? `本批次共 ${totalMatched} 张订单，已截断显示前 ${MAX_PRINT_ORDERS} 张。请用日期过滤缩小范围。`
        : null,
    },
    orders: printOrders,
    customers,
  }
}
