/**
 * Dispatch 打印数据加载（server-only）
 *
 * 按 deliveryDate + driverSlotId 查询 Orders，构造 TripPrintDataWire
 * 复用已有的 trip 打印模板（picking / delivery / summary）。
 */

import 'server-only'
import { prisma } from '@/lib/db'
import { dateOnlyUTC, getOrderWaveDisplayMap } from '@/lib/wave-assign'
import {
  buildLinesFromItems,
  type GoodsType,
  type TripCustomer,
  type TripOrder,
  type TripPrintDataWire,
} from './trip-common'
import { loadInvoiceNoMap } from './invoice-lookup'
import { fetchProductSequences } from './product-sequence'
import { uomConversionKey } from './uom-conversion'
import { loadUomConversionMap } from './uom-conversion-loader'
import {
  type PrintContentFilter,
  describePrintFilter,
  filterPrintLines,
  hasContentFilter,
  keepPrintOrder,
  parseIdListParam,
} from './print-filters'

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
      SELECT p.id, p.type
      FROM "Product" p
      WHERE p.id = ANY(${productIds})
    `
    for (const r of rows) {
      map.set(r.id, r.type ?? null)
    }
  } catch (e) {
    console.warn('[dispatch-print] Product.type not available:', (e as Error).message)
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

/**
 * OrderLine.uomId 历史全空，goodsType 判断实际靠这个兜底：
 * 按 productId 找到商品的 Product.uomId，再查其 goodsType。
 * 与 loadProductTypeMap 是同一个 join 模式，只是多连一层 Uom。
 */
async function loadProductGoodsTypeMap(productIds: string[]): Promise<Map<string, GoodsType>> {
  const map = new Map<string, GoodsType>()
  if (productIds.length === 0) return map
  try {
    const rows = await prisma.$queryRaw<Array<{ id: string; goodsType: string | null }>>`
      SELECT p.id, u."goodsType"
      FROM "Product" p
      LEFT JOIN "Uom" u ON u.id = p."uomId"
      WHERE p.id = ANY(${productIds})
    `
    for (const r of rows) {
      const g = r.goodsType
      map.set(r.id, g === 'BULK' || g === 'LOOSE' ? g : null)
    }
  } catch (e) {
    console.warn('[dispatch-print] Product.uomId goodsType fallback not available:', (e as Error).message)
  }
  return map
}

/**
 * 批次选择器（优先级从高到低）：
 * - waveIds 非空 → 多批次筛选打印（打印中心筛选后「打印筛选结果」）
 * - driverSlotId / batchLabel → 单批次
 * - 三者皆空 → 整日全部批次
 *
 * 以上是「线路」维度（挑哪几趟车）。customerIds / productIds 是在取到的这批订单里
 * 再挑内容，两者正交、可任意组合（台账 D3）。
 */
export interface DispatchSelector extends PrintContentFilter {
  driverSlotId?: string | null
  batchLabel?: string | null
  waveIds?: string[] | null
}

/**
 * 三个打印接口（print-data / picking-pdf / summary-pdf）参数完全一致，
 * 解析放在这里统一一份 —— 之前是三处各抄一遍，加一个参数就要改三处，
 * 漏改任一处的表现是「预览筛了、PDF 没筛」，而且不会报错。
 */
export function parseDispatchSelector(searchParams: URLSearchParams): DispatchSelector {
  return {
    driverSlotId: searchParams.get('driverSlotId'),
    batchLabel: searchParams.get('batchLabel'),
    waveIds: parseIdListParam(searchParams.get('waveIds')),
    customerIds: parseIdListParam(searchParams.get('customerIds')),
    productIds: parseIdListParam(searchParams.get('productIds')),
  }
}

export async function loadDispatchPrintData(
  date: string,
  selector: DispatchSelector,
  fromDate?: string,
): Promise<TripPrintDataWire | null> {
  const selectedWaveIds = (selector.waveIds ?? []).filter(Boolean)
  const multiMode = selectedWaveIds.length > 0

  // Resolve batch identity from either the DriverSlot record or the label string
  let slot = (!multiMode && selector.driverSlotId)
    ? await prisma.driverSlot.findUnique({ where: { id: selector.driverSlotId } })
    : null

  let batchNum: number
  let timeOfDay: string
  let driverName: string
  let slotLabel: string
  let allBatches = false

  if (multiMode) {
    // 多批次筛选：不解析单一 slot 身份，命名走「筛选批次」
    batchNum = 0
    timeOfDay = ''
    driverName = ''
    slotLabel = '筛选批次'
  } else if (slot) {
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
  if (multiMode) {
    // 筛选打印：只取选中波次的订单（union orderIds），与打印中心屏幕上可见批次一致
    const waves = await prisma.pickingWave.findMany({
      where: { id: { in: selectedWaveIds } },
      select: { orderIds: true },
    })
    const ids = [...new Set(waves.flatMap(w => w.orderIds))]
    orders = ids.length > 0
      ? await prisma.order.findMany({
          where: { id: { in: ids }, status: { in: statusFilter } },
          include: { lines: { orderBy: { sequence: 'asc' } } },
          orderBy: { restaurantName: 'asc' },
        })
      : []
  } else if (allBatches) {
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
    // 单批次打印 = 打印这一辆车里、这一个托盘(batchNum)装的订单，不是整个波次(可能横跨多个托盘)。
    // 波次现在按「司机+时段」聚合(见 lib/wave-assign.ts)，批次号对应的是波次下的某个 Pallet。
    const wave = await prisma.pickingWave.findFirst({
      where: { waveDate: dateOnlyUTC(new Date(`${date}T00:00:00.000Z`)), driverName, timeOfDay },
      orderBy: { createdAt: 'desc' },
    })
    if (wave) {
      const pallet = await prisma.pallet.findUnique({ where: { waveId_seq: { waveId: wave.id, seq: batchNum } } })
      const palletOrderIds = [
        ...new Set(((pallet?.items as Array<{ orderId: string }>) ?? []).map((it) => it.orderId)),
      ]
      if (palletOrderIds.length > 0) {
        orders = await prisma.order.findMany({
          where: { id: { in: palletOrderIds }, status: { in: statusFilter } },
          include: { lines: { orderBy: { sequence: 'asc' } } },
          orderBy: { restaurantName: 'asc' },
        })
      }
    }
  }

  // Fallback: legacy orders without a wave record — match by driverSlotId / deliveryBatch string
  // 多批次筛选模式走精确 wave.orderIds，不套用单批次兜底
  if (!allBatches && !multiMode && orders.length === 0) {
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

  // 内容筛选（客户 / 商品）——必须在截断之前做，否则会先截掉 200 张再从中筛，
  // 用户按商品筛出来的结果会莫名其妙地少。前端预览走的是同一组纯函数（print-filters.ts）。
  const contentFiltered = hasContentFilter(selector)
  if (contentFiltered) {
    orders = orders
      .map(o => ({ ...o, lines: filterPrintLines(o.lines, selector) }))
      .filter(o => keepPrintOrder({ customerId: o.restaurantId, lines: o.lines }, selector))
    if (orders.length === 0) return null
  }

  // 截断保护：单批次累积大量历史订单时，避免一次渲染上千页发票
  const maxOrders = (allBatches || multiMode) ? MAX_PRINT_ORDERS_ALL : MAX_PRINT_ORDERS
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
  const [goodsTypeMap, productTypeMap, productGoodsTypeMap, invoiceNoMap, waveDisplayMap, productSeqMap, uomConversionMap] = await Promise.all([
    loadGoodsTypeMap(uomIds),
    loadProductTypeMap(productIds),
    loadProductGoodsTypeMap(productIds),
    loadInvoiceNoMap(orders.map(o => o.id)),
    // 筛选打印/全部打印可能横跨多个司机,trip 级 driverName 是空的——每单实际司机身份
    // 只能按单查(与销售单列表司机列同一 SSOT),见 TripOrder.driverBatchLabel。
    getOrderWaveDisplayMap(orders.map(o => o.id)),
    // 打印顺序按商品 sequence（客户要求 2026-08-18）。模板拿不到数据库，在这里附上。
    fetchProductSequences(productIds),
    loadUomConversionMap(orders.flatMap(o => o.lines).map(l => ({ productId: l.productId, uomId: l.uomId }))),
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

  // 商品筛选把行砍掉之后，订单级 totalAmount 就不再等于纸面上那几行的和 ——
  // 汇总单读的正是这个字段，不重算会印出「只列 2 行、金额却是全单」的自相矛盾单据。
  // 口径与 OrderLine.subtotal 一致（税前，SSOT 见 docs/20260701）。
  const lineFiltered = (selector.productIds ?? []).filter(Boolean).length > 0
  const orderTotal = (o: (typeof orders)[number]): number =>
    lineFiltered ? o.lines.reduce((s, l) => s + toNum(l.subtotal), 0) : toNum(o.totalAmount)

  const printOrders: TripOrder[] = orders.map(o => ({
    id: o.id,
    code: o.code,
    customerId: o.restaurantId,
    customerName: o.restaurantName,
    totalAmount: orderTotal(o),
    internalNote: o.internalNote,
    externalNote: o.externalNote,
    deliveryNote: (o as { deliveryNote?: string | null }).deliveryNote ?? null,
    deliveryDate: toIso(o.deliveryDate),
    invoiceNo: invoiceNoMap.get(o.id) ?? null,
    driverBatchLabel: waveDisplayMap[o.id] ?? null,
    // 优先用 OrderLine；为空时回退到旧版 items JSON（历史迁移订单两者皆空 → []）
    lines: o.lines.length > 0
      ? o.lines.map(l => ({
          productId: l.productId,
          productName: l.productName,
          productSequence: productSeqMap.get(l.productId) ?? null,
          spec: l.spec ?? null,
          uomId: l.uomId,
          uomName: l.uomName,
          // OrderLine.uomId 历史全空，先看行级 uom，没有再回退到商品自己的 uom
          goodsType: (l.uomId ? goodsTypeMap.get(l.uomId) : null) ?? productGoodsTypeMap.get(l.productId) ?? null,
          productType: productTypeMap.get(l.productId) ?? null,
          note: l.note ?? null,
          uomConversion: uomConversionMap.get(uomConversionKey(l.productId, l.uomId)) ?? null,
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
      id: multiMode ? `dispatch-filtered-${date}` : allBatches ? `dispatch-all-${date}` : `dispatch-${slot?.id ?? slotLabel}-${date}`,
      name: multiMode ? `筛选批次 ${date}` : allBatches ? `全部批次 ${date}` : `${driverName} #${batchNum} ${timeOfDay.toUpperCase()}`,
      timeSlot: timeSlotMap[timeOfDay] ?? timeOfDay,
      driverName: driverName,
      // 筛选打印/全部打印可能横跨多个司机的托盘,没有唯一批次号——留 null,模板据此省略,
      // 不再显示 name 里的"筛选批次"占位文案(客户反馈)。单批次/按标签两条路径都已解析出
      // 确定的 batchNum,可以放心带出去。
      batchNum: (multiMode || allBatches) ? null : batchNum,
      departTime: null,
      createdAt: new Date().toISOString(),
      // 截断与筛选可能同时发生；两条都得说，只说一条会让人以为纸面就是全部
      notice: [
        truncated
          ? `本批次共 ${totalMatched} 张订单，已截断显示前 ${maxOrders} 张。请用日期过滤缩小范围。`
          : null,
        describePrintFilter(selector, {
          customers: customerIds.length,
          products: new Set(orders.flatMap(o => o.lines).map(l => l.productId)).size,
        }),
      ].filter(Boolean).join(' ') || null,
    },
    orders: printOrders,
    customers,
  }
}
