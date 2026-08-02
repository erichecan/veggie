/**
 * 「日报/明细清单/商品×星期汇总」服务端 PDF 的数据加载（server-only）。
 * 跟 SalesStats.tsx（销售统计屏幕预览）用同一套筛选口径：状态限定
 * CONFIRMED/WAVE_ASSIGNED/IN_DELIVERY/COMPLETED，按 deliveryDate 拉单，
 * 司机/AM-PM/批次/星期/分类/商品/客户/业务员全部在这一层统一过滤，
 * 保证屏幕「筛选结果」预览跟打印出来的份数、金额完全对得上（所见即所打）。
 */
import 'server-only'
import { prisma } from '@/lib/db'
import { formatDriverSlotFromOrder, parseDriverSlotKey } from '@/lib/driver-slot'
import { attachWaveDisplay } from '@/lib/wave-assign'
import { dayOfWeek, type ReportLine } from './day-wise-report-template'
import type { Order } from '@/lib/types'

export interface DayWiseReportParams {
  fromDate: string
  toDate: string
  customerIds: string[]
  productNames: string[]
  drivers: string[]
  times: string[]
  batchNums: number[]
  weekdays: number[]
  categoryIds: string[]
  salesUserId: string
}

const STATUS_FILTER = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED'] as const

export async function loadDayWiseReportData(p: DayWiseReportParams): Promise<{ lines: ReportLine[]; orders: Order[] }> {
  const where: Record<string, unknown> = {
    status: { in: STATUS_FILTER },
    deliveryDate: {
      gte: new Date(`${p.fromDate}T00:00:00.000Z`),
      lte: new Date(`${p.toDate}T23:59:59.999Z`),
    },
  }
  if (p.customerIds.length > 0) where.restaurantId = { in: p.customerIds }
  if (p.salesUserId) where.salesUserId = p.salesUserId
  // 订单级粗筛：订单里至少一行命中所选分类即可，行级精确过滤见下方按 categoryByProductId 二次过滤
  if (p.categoryIds.length > 0) where.lines = { some: { product: { categoryId: { in: p.categoryIds } } } }

  const rawOrders = await prisma.order.findMany({
    where,
    include: { lines: { orderBy: { sequence: 'asc' } } },
    orderBy: { restaurantName: 'asc' },
  })

  // SSOT(P0-1): 司机/AM-PM/批次筛选与输出行的司机显示都必须走 wave 派生真相,
  // 否则调度台拖拽改派过的单会按下单意向列(order.driverSlotId)被筛掉或印错司机。
  await attachWaveDisplay(rawOrders as unknown as { id: string; deliveryBatchDisplay?: string | null }[])

  // 分类精确过滤需要商品的真实 categoryId（订单行只存 productName 快照），
  // 顺带取 sequence 供「按目录顺序排序」选项用
  const productIds = [...new Set(rawOrders.flatMap(o => o.lines.map(l => l.productId).filter(Boolean)))] as string[]
  const products = productIds.length > 0
    ? await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, categoryId: true, sequence: true },
      })
    : []
  const productMap = new Map(products.map(pr => [pr.id, pr]))

  const categorySet = new Set(p.categoryIds)
  const filteredOrders = rawOrders.filter(order => {
    if (p.drivers.length > 0 || p.times.length > 0 || p.batchNums.length > 0) {
      const parsed = parseDriverSlotKey(formatDriverSlotFromOrder(order as unknown as Order))
      if (p.drivers.length > 0 && !p.drivers.includes(parsed.driver)) return false
      if (p.times.length > 0 && !p.times.includes(parsed.time)) return false
      if (p.batchNums.length > 0 && !p.batchNums.includes(parsed.num)) return false
    }
    if (p.weekdays.length > 0) {
      const date = (order.deliveryDate ?? order.createdAt).toISOString().slice(0, 10)
      if (!p.weekdays.includes(dayOfWeek(date))) return false
    }
    return true
  })

  const lines: ReportLine[] = []
  for (const order of filteredOrders) {
    const date = (order.deliveryDate ?? order.createdAt).toISOString().slice(0, 10)
    for (const l of order.lines) {
      if (p.productNames.length > 0 && !p.productNames.includes(l.productName)) continue
      const prod = l.productId ? productMap.get(l.productId) : undefined
      if (categorySet.size > 0 && !categorySet.has(prod?.categoryId ?? '')) continue
      lines.push({
        date,
        customerId: order.restaurantId,
        customerName: order.restaurantName,
        productName: l.productName,
        qty: Number(l.orderedQty),
        unitPrice: Number(l.unitPrice),
        amount: Number(l.subtotal),
        taxRate: Number(l.taxRate ?? 0),
        orderCode: order.code ?? '',
        deliveryBatch: formatDriverSlotFromOrder(order as unknown as Order),
        productSequence: prod?.sequence ?? 0,
      })
    }
  }

  return { lines, orders: filteredOrders as unknown as Order[] }
}
