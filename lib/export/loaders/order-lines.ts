/** 销售单「全字段导出」取数 —— where 复用 lib/orders-query.ts，与列表 API 同一份；
 * buildOrdersWhere 原生支持 ?ids=，多选导出不用像采购单那样再手动拼一次。*/
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { attachWaveDisplay } from '@/lib/wave-assign'
import { buildOrdersWhere } from '@/lib/orders-query'
import { formatDriverSlotFromOrder } from '@/lib/driver-slot'
import { computeOrderTotals } from '@/lib/order-totals'
import type { ExportLoadContext, ExportLoadResult } from '../registry'
import type { OrderLineExportRow } from '../columns/order-lines'
import type { OrderExportRow } from '../columns/orders'

export async function loadOrderLinesForExport(ctx: ExportLoadContext): Promise<ExportLoadResult<OrderLineExportRow>> {
  const where = await buildOrdersWhere(ctx.request, ctx.searchParams)
  // ⛔ 这里导出的是行级数据：route 里 `total > rows.length` 判断截断时两边必须是同一个
  // 单位（行数 vs 行数），不能用订单数当 total —— 订单数远小于行数，会导致截断判断
  // 几乎永远不触发，用户下载到不完整的 CSV 却拿不到任何提示（静默丢数据）。
  // 没有行的订单在下面 flatMap 里兜底成 1 行占位，这里的 zeroLineOrders 就是把它们
  // 按同样的口径补回「总行数」。
  const [totalLines, zeroLineOrders, rawOrders] = await Promise.all([
    prisma.orderLine.count({ where: { order: where } }),
    prisma.order.count({ where: { ...where, lines: { none: {} } } }),
    prisma.order.findMany({
      where,
      orderBy: [{ deliveryDate: 'asc' }, { code: 'asc' }],
      take: ctx.limit,
      include: { lines: { orderBy: { sequence: 'asc' } }, salesUser: { select: { id: true, name: true } } },
    }),
  ])
  const total = totalLines + zeroLineOrders

  const orders = await attachWaveDisplay(serializeApi(rawOrders)) as unknown as OrderExportRow[]

  const rows: OrderLineExportRow[] = orders.flatMap(o => {
    const totals = computeOrderTotals(o)
    const lines = o.lines ?? []
    const header = {
      id: o.id,
      code: o.code,
      status: o.status,
      restaurantName: o.restaurantName,
      salesmanName: o.salesUser?.name ?? '',
      driverLabel: formatDriverSlotFromOrder(o) || '',
      quotationDate: o.quotationDate,
      deliveryDate: o.deliveryDate,
      paymentMethod: o.paymentMethod,
      internalNote: o.internalNote,
      externalNote: o.externalNote,
      untaxed: totals.untaxed,
      tax: totals.tax,
      total: totals.total,
      lineCount: lines.length,
    }
    return (lines.length ? lines : [null]).map(line => ({
      ...header,
      productName: line?.productName ?? '',
      spec: line?.spec ?? '',
      note: line?.note ?? '',
      uomName: line?.uomName ?? '',
      quantity: line?.orderedQty,
      unitPrice: line?.unitPrice,
      taxRate: line?.taxRate,
      isGift: line?.isGift ?? false,
      lineSubtotal: line?.subtotal,
    }))
  })

  return { rows, total }
}
