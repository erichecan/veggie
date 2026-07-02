/**
 * Dispatch 打印数据加载（server-only）
 *
 * 按 deliveryDate + driverSlotId 查询 Orders，构造 TripPrintDataWire
 * 复用已有的 trip 打印模板（picking / delivery / summary）。
 */

import 'server-only'
import { prisma } from '@/lib/db'
import { dateOnlyUTC } from '@/lib/wave-assign'
import {
  buildLinesFromItems,
  type GoodsType,
  type TripCustomer,
  type TripOrder,
  type TripPrintDataWire,
} from './trip-common'

/** 单批次打印的最大订单数，超出则截断并在打印顶部提示 */
const MAX_PRINT_ORDERS = 50
/** 整日全部批次打印的最大订单数（拣货单截断会丢商品，上限放宽） */
const MAX_PRINT_ORDERS_ALL = 200

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

async function loadProductTypeMap(productIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>()
  if (productIds.length === 0) return map
  try {
    const rows = await prisma.$queryRaw<Array<{ id: string; type: string | null }>>`
      SELECT p.id, pt.type
      FROM "Product" p
      LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
      WHERE p.id = ANY(${productIds})
    `
    for (const r of rows) {
      map.set(r.id, r.type ?? null)
    }
  } catch (e) {
    console.warn('[dispatch-print] ProductTemplate.type not available:', (e as Error).message)
  }
  return map
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

/** 批次选择器：用 DriverSlot id，或回退到批次字符串 "2 pm AFZAAL"；两者皆空 = 整日全部批次 */
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
  let allBatches = false

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
    // 整日全部批次模式（打印中心「全部打印」入口）
    allBatches = true
    batchNum = 0
    timeOfDay = ''
    driverName = ''
    slotLabel = '全部批次'
  }

  const rangeStart = new Date(`${fromDate ?? date}T00:00:00.000Z`)
  const dayEnd = new Date(`${date}T23:59:59.999Z`)
  const statusFilter: Array<'CONFIRMED' | 'WAVE_ASSIGNED' | 'IN_DELIVERY' | 'COMPLETED'> = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED']

  // SSOT: 订单归属批次以 PickingWave.orderIds 为准（P0-1），driverSlotId/deliveryBatch 是历史遗留兜底字段。
  // 拖拽调度台只写 wave.orderIds，不回填 Order.driverSlotId，所以必须先查 wave。
  // 见 lib/wave-assign.ts、docs/20260624-data-ownership-audit.md。
  let orders: Awaited<ReturnType<typeof prisma.order.findMany<{ include: { lines: true } }>>> = []
  if (allBatches) {
    // 当天所有波次的订单 ∪ 当天 deliveryDate 的订单（含未分配批次）
    const waves = await prisma.pickingWave.findMany({
      where: { waveDate: dateOnlyUTC(new Date(`${date}T00:00:00.000Z`)) },
      select: { orderIds: true },
    })
    const waveOrderIds = [...new Set(waves.flatMap(w => w.orderIds))]
    orders = await prisma.order.findMany({
      where: {
        status: { in: statusFilter },
        OR: [
          ...(waveOrderIds.length > 0 ? [{ id: { in: waveOrderIds } }] : []),
          { deliveryDate: { gte: rangeStart, lte: dayEnd } },
        ],
      },
      include: { lines: { orderBy: { sequence: 'asc' } } },
      orderBy: { restaurantName: 'asc' },
    })
  } else if (slot) {
    const wave = await prisma.pickingWave.findUnique({
      where: { waveDate_driverSlotId: { waveDate: dateOnlyUTC(new Date(`${date}T00:00:00.000Z`)), driverSlotId: slot.id } },
    })
    if (wave && wave.orderIds.length > 0) {
      orders = await prisma.order.findMany({
        where: { id: { in: wave.orderIds }, status: { in: statusFilter } },
        include: { lines: { orderBy: { sequence: 'asc' } } },
        orderBy: { restaurantName: 'asc' },
      })
    }
  }

  // Fallback: legacy orders without a wave record — match by driverSlotId / deliveryBatch string
  if (!allBatches && orders.length === 0) {
    const batchMatch = slot
      ? [{ driverSlotId: slot.id }, { deliveryBatch: slotLabel }]
      : [{ deliveryBatch: slotLabel }]

    orders = await prisma.order.findMany({
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

    // Fallback further: ignore date filter entirely (deliveryDate=null orders created on another day)
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
  }

  if (orders.length === 0) return null

  // 截断保护：单批次累积大量历史订单时，避免一次渲染上千页发票
  const maxOrders = allBatches ? MAX_PRINT_ORDERS_ALL : MAX_PRINT_ORDERS
  const totalMatched = orders.length
  const truncated = totalMatched > maxOrders
  if (truncated) orders = orders.slice(0, maxOrders)

  const customerIds = [...new Set(orders.map(o => o.restaurantId))]
  const customerRows = customerIds.length > 0
    ? await prisma.customer.findMany({ where: { id: { in: customerIds } } })
    : []

  const uomIds = [...new Set(
    orders.flatMap(o => o.lines).map(l => l.uomId).filter((x): x is string => !!x),
  )]
  const productIds = [...new Set(
    orders.flatMap(o => o.lines).map(l => l.productId).filter((x): x is string => !!x),
  )]
  const [goodsTypeMap, productTypeMap] = await Promise.all([
    loadGoodsTypeMap(uomIds),
    loadProductTypeMap(productIds),
  ])

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
    externalNote: c.externalNote ?? null,
  }))

  const printOrders: TripOrder[] = orders.map(o => ({
    id: o.id,
    code: o.code,
    customerId: o.restaurantId,
    customerName: o.restaurantName,
    totalAmount: toNum(o.totalAmount),
    internalNote: o.internalNote,
    externalNote: o.externalNote,
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
          productType: productTypeMap.get(l.productId) ?? null,
          note: l.note ?? null,
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
      id: allBatches ? `dispatch-all-${date}` : `dispatch-${slot?.id ?? slotLabel}-${date}`,
      name: allBatches ? `全部批次 ${date}` : `${driverName} #${batchNum} ${timeOfDay.toUpperCase()}`,
      timeSlot: timeSlotMap[timeOfDay] ?? timeOfDay,
      driverName: driverName,
      departTime: null,
      createdAt: new Date().toISOString(),
      notice: truncated
        ? `本批次共 ${totalMatched} 张订单，已截断显示前 ${maxOrders} 张。请用日期过滤缩小范围。`
        : null,
    },
    orders: printOrders,
    customers,
  }
}
