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
import { pickLargestPack } from '@/lib/pack-split'
import {
  buildLinesFromItems,
  type GoodsType,
  type TripCustomer,
  type TripOrder,
  type TripPrintDataWire,
} from './trip-common'
import { loadInvoiceNoMap } from './invoice-lookup'
import { fetchProductSequences } from '@/lib/print/product-sequence'
import { getOrderWaveDisplayMap } from '@/lib/wave-assign'

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

/**
 * OrderLine.uomId 历史全空，goodsType 判断实际靠这个兜底：
 * 按 productId 找到商品所属 ProductTemplate.uomId，再查其 goodsType。
 */
async function loadProductGoodsTypeMap(productIds: string[]): Promise<Map<string, GoodsType>> {
  const map = new Map<string, GoodsType>()
  if (productIds.length === 0) return map
  try {
    const rows = await prisma.$queryRaw<Array<{ id: string; goodsType: string | null }>>`
      SELECT p.id, u."goodsType"
      FROM "Product" p
      LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
      LEFT JOIN "Uom" u ON u.id = pt."uomId"
      WHERE p.id = ANY(${productIds})
    `
    for (const r of rows) {
      const g = r.goodsType
      map.set(r.id, g === 'BULK' || g === 'LOOSE' ? g : null)
    }
  } catch (e) {
    console.warn('[trip-print] ProductTemplate.uomId goodsType fallback not available:', (e as Error).message)
  }
  return map
}

/**
 * 箱规：商品挂的可售单位里 factor 最大的那个大单位（ProductSaleUom）。
 * 取最大是因为拣货能整托搬就不该拆成箱（见 lib/pack-split.ts: pickLargestPack）。
 *
 * ⚠️ 实测（20260811）：测试库 ProductSaleUom **0 行** —— 没有任何商品配了可售单位，
 * 于是拆箱对现有数据全部返回 null，纸面与改动前一模一样。这不是代码问题，是
 * 主数据没录。生产库需同样核对。
 */
async function loadPackSpecMap(productIds: string[]): Promise<Map<string, { factor: number; caseUomName: string; baseUomName: string }>> {
  const map = new Map<string, { factor: number; caseUomName: string; baseUomName: string }>()
  if (productIds.length === 0) return map
  try {
    const rows = await prisma.$queryRaw<Array<{ productId: string; uomName: string; factor: string; baseName: string | null }>>`
      SELECT psu."productId",
             u.name          AS "uomName",
             u.factor::text  AS factor,
             base.name       AS "baseName"
      FROM "ProductSaleUom" psu
      JOIN "Uom" u ON u.id = psu."uomId"
      LEFT JOIN "Product" p ON p.id = psu."productId"
      LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
      LEFT JOIN "Uom" base ON base.id = pt."uomId"
      WHERE psu."productId" = ANY(${productIds}) AND psu.active = true
    `
    const byProduct = new Map<string, typeof rows>()
    for (const r of rows) {
      const arr = byProduct.get(r.productId) ?? []
      arr.push(r)
      byProduct.set(r.productId, arr)
    }
    for (const [pid, arr] of byProduct) {
      const spec = pickLargestPack(
        arr.map((r) => ({ name: r.uomName, factor: Number(r.factor), type: 'BIGGER' })),
        arr[0]?.baseName ?? '',
      )
      if (spec) map.set(pid, spec)
    }
  } catch (e) {
    console.warn('[trip-print] ProductSaleUom pack spec not available:', (e as Error).message)
  }
  return map
}

/** Server-only：拼装一份完整的 trip 打印数据。给 API route 调用 */
export async function loadTripPrintData(tripId: string): Promise<TripPrintDataWire | null> {
  const trip = await prisma.trip.findUnique({ where: { id: tripId } })
  if (!trip) return null

  const restaurants = Array.isArray(trip.restaurants)
    ? (trip.restaurants as Array<{
        restaurantId?: string
        restaurantName?: string
        orderIds?: string[]
        delivered?: boolean
        payment?: number
        signature?: string | null
        signerName?: string | null
        signedAt?: string | null
      }>)
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
  const productIds = [...new Set(
    orders.flatMap(o => o.lines).map(l => l.productId).filter((x): x is string => !!x),
  )]
  const [goodsTypeMap, productGoodsTypeMap, packSpecMap, invoiceNoMap, waveDisplayMap, productSeqMap] = await Promise.all([
    loadGoodsTypeMap(uomIds),
    loadProductGoodsTypeMap(productIds),
    loadPackSpecMap(productIds),
    loadInvoiceNoMap(orders.map(o => o.id)),
    getOrderWaveDisplayMap(orders.map(o => o.id)),
    // 打印顺序按商品 sequence（客户要求 2026-08-18）。模板是纯字符串拼接、
    // 拿不到数据库，所以在这里附到行上。见 lib/print/line-sort.ts
    fetchProductSequences(productIds),
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
          note: l.note ?? null,
          packSpec: packSpecMap.get(l.productId) ?? null,
          orderedQty: toNum(l.orderedQty),
          unitPrice: toNum(l.unitPrice),
          taxRate: toNum(l.taxRate),
          subtotal: toNum(l.subtotal),
        }))
      : buildLinesFromItems(o.items),
  }))

  return {
    trip: {
      id: trip.id,
      name: trip.name,
      timeSlot: trip.timeSlot,
      driverName: trip.driverName,
      // Trip 实体没有批次号概念(一趟车可能横跨多个托盘),留 null——模板据此省略,不拼进司机身份
      batchNum: null,
      departTime: trip.departTime,
      createdAt: trip.createdAt.toISOString(),
    },
    orders: printOrders,
    customers,
    // 客户签收单要用的签收记录。签名图是 base64，只在需要时随打印数据一起下发
    signoffs: restaurants.map(r => ({
      restaurantId: r.restaurantId ?? '',
      restaurantName: r.restaurantName ?? '',
      orderIds: r.orderIds ?? [],
      delivered: r.delivered === true,
      payment: typeof r.payment === 'number' ? r.payment : null,
      signature: r.signature ?? null,
      signerName: r.signerName ?? null,
      signedAt: r.signedAt ?? null,
    })),
  }
}
