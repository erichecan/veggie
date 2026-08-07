/**
 * GET /api/orders/export-csv
 *
 * 「销售单列表」页会计导出：吃跟列表页完全相同的筛选参数(buildOrdersWhere，与
 * GET /api/orders 共用同一套筛选口径)，按当前筛选结果导出 CSV。
 * ?kind=summary（默认）→ 订单汇总一行/单；?kind=detail → 产品明细一行/商品行。
 * 硬上限 EXPORT_ROW_LIMIT 条订单，避免无日期范围时把全库订单一次性拉出来拖垮内存/数据库。
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { attachWaveDisplay } from '@/lib/wave-assign'
import { buildOrdersWhere } from '@/lib/orders-query'
import { buildCsv, csvResponseHeaders } from '@/lib/export/csv'
import { ORDER_SUMMARY_HEADERS, ORDER_DETAIL_HEADERS, buildOrderSummaryRows, buildOrderDetailRows } from '@/lib/export/order-export-rows'
import type { Order } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['OPERATOR', 'BOSS', 'DRIVER', 'FINANCE', 'SALES']
const EXPORT_ROW_LIMIT = 20000

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const { searchParams } = new URL(req.url)
    const kind = searchParams.get('kind') === 'detail' ? 'detail' : 'summary'
    const where = await buildOrdersWhere(req, searchParams)

    const totalMatching = await prisma.order.count({ where })
    const truncated = totalMatching > EXPORT_ROW_LIMIT

    const rawOrders = await prisma.order.findMany({
      where,
      orderBy: [{ deliveryDate: 'asc' }, { code: 'asc' }],
      take: EXPORT_ROW_LIMIT,
      include: {
        lines: { orderBy: { sequence: 'asc' } },
        salesUser: { select: { id: true, name: true } },
      },
    })

    const orders = await attachWaveDisplay(serializeApi(rawOrders)) as unknown as (Order & { salesUser?: { name: string } | null })[]

    const today = new Date().toISOString().slice(0, 10)
    if (kind === 'detail') {
      const csv = buildCsv(ORDER_DETAIL_HEADERS, buildOrderDetailRows(orders))
      return new NextResponse(csv, { headers: csvResponseHeaders(`订单产品明细-${today}.csv`) })
    }

    const csv = buildCsv(ORDER_SUMMARY_HEADERS, buildOrderSummaryRows(orders))
    const res = new NextResponse(csv, { headers: csvResponseHeaders(`订单汇总-${today}.csv`) })
    if (truncated) res.headers.set('X-Export-Truncated', String(totalMatching))
    return res
  }, { require: 'sales.order.export' })
}
