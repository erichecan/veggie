/**
 * 订单/报价单导出取数 —— where 复用 lib/orders-query.ts 的 buildOrdersWhere，
 * 与 GET /api/orders 和既有的 /api/orders/export-csv 同一份。
 */
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { attachWaveDisplay } from '@/lib/wave-assign'
import { buildOrdersWhere } from '@/lib/orders-query'
import type { ExportLoadContext, ExportLoadResult } from '../registry'
import type { OrderExportRow } from '../columns/orders'

export async function loadOrdersForExport(
  ctx: ExportLoadContext,
): Promise<ExportLoadResult<OrderExportRow>> {
  // buildOrdersWhere 需要原始 Request 来做行级隔离；这里把 user 已解析的结果透给它
  const where = await buildOrdersWhere(ctx.request, ctx.searchParams)

  const [total, rawOrders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy: [{ deliveryDate: 'asc' }, { code: 'asc' }],
      take: ctx.limit,
      include: {
        lines: { orderBy: { sequence: 'asc' } },
        salesUser: { select: { id: true, name: true } },
      },
    }),
  ])

  // 司机列的 SSOT 是所属 wave 派生的结果，不是 Order.driverSlotId ——
  // 直接读那一列会印出旧司机（20260801 的教训，发票 PDF 与日报都踩过）
  const rows = await attachWaveDisplay(serializeApi(rawOrders)) as unknown as OrderExportRow[]
  return { rows, total }
}
