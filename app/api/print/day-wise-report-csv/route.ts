/**
 * GET /api/print/day-wise-report-csv
 *
 * 「日销售管理中心 → 销售统计」会计导出：跟 day-wise-report-pdf 用同一套
 * loadDayWiseReportData() + 筛选参数(from/to/customerIds/...)，保证屏幕预览/PDF/CSV
 * 三者口径完全一致（所见即所导）。
 * ?kind=summary（默认）→ 订单汇总一行/单，列同「日报（按客户）」PDF；
 * ?kind=detail → 产品明细一行/商品行，列同「明细清单」PDF。
 */
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { loadDayWiseReportData } from '@/lib/print/day-wise-report-loader'
import { buildCsv, csvResponseHeaders, money } from '@/lib/export/csv'
import { ORDER_SUMMARY_HEADERS, buildOrderSummaryRows } from '@/lib/export/order-export-rows'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['OPERATOR', 'BOSS', 'DRIVER', 'FINANCE', 'SALES']

const DETAIL_HEADERS = ['日期', '订单号', '客户', '配送批次', '产品', '数量', '单价', '税率(%)', '金额']

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const { searchParams } = new URL(req.url)
    const kind = searchParams.get('kind') === 'detail' ? 'detail' : 'summary'
    const fromDate = searchParams.get('from') ?? ''
    const toDate = searchParams.get('to') ?? ''
    if (!fromDate || !toDate) {
      return NextResponse.json({ error: '缺少参数 from/to' }, { status: 400 })
    }

    const { lines, orders } = await loadDayWiseReportData({
      fromDate,
      toDate,
      customerIds: searchParams.get('customerIds')?.split(',').filter(Boolean) ?? [],
      productNames: searchParams.get('productNames')?.split(',').filter(Boolean) ?? [],
      drivers: searchParams.get('drivers')?.split(',').filter(Boolean) ?? [],
      times: searchParams.get('times')?.split(',').filter(Boolean) ?? [],
      batchNums: searchParams.get('batchNums')?.split(',').map(Number).filter(n => !isNaN(n)) ?? [],
      weekdays: searchParams.get('weekdays')?.split(',').map(Number).filter(n => !isNaN(n)) ?? [],
      categoryIds: searchParams.get('categoryIds')?.split(',').filter(Boolean) ?? [],
      salesUserId: searchParams.get('salesUserId') ?? '',
    })

    const rangeTag = fromDate === toDate ? fromDate : `${fromDate}_${toDate}`

    if (kind === 'detail') {
      const rows = lines.map(l => [
        l.date,
        l.orderCode,
        l.customerName,
        l.deliveryBatch,
        l.productName,
        l.qty,
        money(l.unitPrice),
        money(l.taxRate > 1 ? l.taxRate : l.taxRate * 100),
        money(l.amount),
      ])
      const csv = buildCsv(DETAIL_HEADERS, rows)
      return new NextResponse(csv, { headers: csvResponseHeaders(`产品明细-${rangeTag}.csv`) })
    }

    const csv = buildCsv(ORDER_SUMMARY_HEADERS, buildOrderSummaryRows(orders))
    return new NextResponse(csv, { headers: csvResponseHeaders(`订单汇总-${rangeTag}.csv`) })
  }, { require: 'print.center.access' })
}
