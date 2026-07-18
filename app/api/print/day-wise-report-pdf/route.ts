/**
 * GET /api/print/day-wise-report-pdf
 *
 * 「日报（按客户）/明细清单/商品×星期汇总」的真·服务端 PDF：客户反馈(20260718)老版本走
 * window.print()，浏览器自己加的默认页头页脚（打印时间/文档标题/URL/页码）丑且不受控。
 * 改成跟送货单/汇总单一样，服务端 loadDayWiseReportData() 取数据、生成 HTML，用无头
 * Chromium 渲染成 PDF 二进制返回——不接受客户端传来的任意 HTML（避免 SSRF 跳板）。
 */
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { loadDayWiseReportData } from '@/lib/print/day-wise-report-loader'
import {
  type PrintMode,
  DAY_NAMES,
  buildOrderSummaryHtml,
  buildMultilineHtml,
  buildSummaryHtml,
} from '@/lib/print/day-wise-report-template'
import { renderHtmlToPdf } from '@/lib/print/render-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['OPERATOR', 'BOSS', 'DRIVER', 'FINANCE', 'SALES']

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const { searchParams } = new URL(req.url)
    const mode = (searchParams.get('mode') ?? 'day') as PrintMode
    const fromDate = searchParams.get('from') ?? ''
    const toDate = searchParams.get('to') ?? ''
    const customerIds = searchParams.get('customerIds')?.split(',').filter(Boolean) ?? []
    const productNames = searchParams.get('productNames')?.split(',').filter(Boolean) ?? []
    const drivers = searchParams.get('drivers')?.split(',').filter(Boolean) ?? []
    const times = searchParams.get('times')?.split(',').filter(Boolean) ?? []
    const batchNums = searchParams.get('batchNums')?.split(',').map(Number).filter(n => !isNaN(n)) ?? []
    const weekdays = searchParams.get('weekdays')?.split(',').map(Number).filter(n => !isNaN(n)) ?? []
    const categoryIds = searchParams.get('categoryIds')?.split(',').filter(Boolean) ?? []
    const salesUserId = searchParams.get('salesUserId') ?? ''
    const sortBySequence = searchParams.get('sortBySequence') === '1'

    if (!fromDate || !toDate) {
      return NextResponse.json({ error: '缺少参数 from/to' }, { status: 400 })
    }

    try {
      const { lines, orders } = await loadDayWiseReportData({
        fromDate, toDate, customerIds, productNames, drivers, times, batchNums, weekdays, categoryIds, salesUserId,
      })

      const dateLabel = fromDate === toDate ? fromDate : `${fromDate} → ${toDate}`
      const custLabel = customerIds.length > 0 ? `${customerIds.length} customer(s) selected` : 'All customers'
      const prodLabel = productNames.length > 0 ? `${productNames.length} product(s) selected` : 'All products'
      const catLabel = categoryIds.length > 0 ? ` · ${categoryIds.length} categor${categoryIds.length > 1 ? 'ies' : 'y'} selected` : ''
      const batchFilterParts = [
        drivers.length > 0 ? `Drivers: ${drivers.join(', ')}` : '',
        times.length > 0 ? `${times.map(t => t.toUpperCase()).join('/')}` : '',
        batchNums.length > 0 ? `Batch# ${batchNums.join(', ')}` : '',
        weekdays.length > 0 ? `Weekday: ${weekdays.map(w => DAY_NAMES[w]).join(', ')}` : '',
      ].filter(Boolean)
      const batchLabel = batchFilterParts.length > 0 ? batchFilterParts.join(' · ') : 'All batches'
      const countLabel = mode === 'day' ? `${orders.length} orders` : `${lines.length} lines`
      const meta = `Period: ${dateLabel}  |  ${custLabel}  |  ${prodLabel}${catLabel}  |  ${batchLabel}  |  ${countLabel}`

      // 页脚筛选摘要：只列出真正生效的筛选条件（不列 All customers 这类默认值），
      // 一叠纸打乱后靠页脚就能认出这是哪一份筛选结果的第几页（客户要求，20260718）
      const footerParts = [
        dateLabel,
        customerIds.length > 0 ? `${customerIds.length} cust` : '',
        categoryIds.length > 0 ? `${categoryIds.length} categ` : '',
        ...batchFilterParts,
      ].filter(Boolean)
      const pageLabel = footerParts.join(' · ')

      const TITLES: Record<PrintMode, string> = {
        day: 'Order Summary Report',
        multiline: 'Product Sales Multi Line Report',
        summary: 'Product Sale Summary Report',
      }

      let html: string
      if (mode === 'multiline') {
        html = buildMultilineHtml(lines, TITLES.multiline, meta, sortBySequence)
      } else if (mode === 'summary') {
        html = buildSummaryHtml(lines, TITLES.summary, meta, sortBySequence)
      } else {
        html = buildOrderSummaryHtml(lines, orders, TITLES.day, meta)
      }

      const pdf = await renderHtmlToPdf(html, { pageNumbers: true, pageLabel })
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Cache-Control': 'no-store',
        },
      })
    } catch (error) {
      console.error('[GET /api/print/day-wise-report-pdf]', error)
      return NextResponse.json({ error: '生成报表失败' }, { status: 500 })
    }
  }, ALLOWED_ROLES)
}
