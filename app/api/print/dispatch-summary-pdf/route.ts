/**
 * GET /api/print/dispatch-summary-pdf
 *
 * 汇总单的真·服务端 PDF：参数与 /api/orders/dispatch-print-data 完全一致
 * （date/fromDate/driverSlotId/batchLabel/waveIds），服务端直接用同一个
 * loadDispatchPrintData() 取数据、生成 HTML，再用无头 Chromium 渲染成 PDF 二进制返回——
 * 不接受客户端传来的任意 HTML（避免无头浏览器被拿去做 SSRF 跳板）。
 */
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { loadDispatchPrintData, parseDispatchSelector } from '@/lib/print/dispatch-loader'
import { stripAutoPrintScript, formatTripDriverList } from '@/lib/print/trip-common'
import { generateTripSummaryHtml } from '@/lib/print/trip-summary-template'
import { renderHtmlToPdf } from '@/lib/print/render-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['OPERATOR', 'BOSS', 'DRIVER', 'FINANCE', 'SALES']

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const { searchParams } = new URL(req.url)
    const date = searchParams.get('date')
    const fromDate = searchParams.get('fromDate') ?? undefined
    const selector = parseDispatchSelector(searchParams)

    if (!date) {
      return NextResponse.json({ error: '缺少参数 date' }, { status: 400 })
    }

    try {
      const wire = await loadDispatchPrintData(date, selector, fromDate)
      if (!wire) {
        return NextResponse.json({ error: '该批次无订单数据' }, { status: 404 })
      }
      const data = { trip: wire.trip, orders: wire.orders, customers: new Map(wire.customers.map(c => [c.id, c])) }
      const html = stripAutoPrintScript(generateTripSummaryHtml(data))
      // 汇总单不是按订单分页(是连续表格，多单挤一起)，"订单号-Page X/Y"套不上——改成
      // 整份文档统一页码，用 Puppeteer 原生页码(按真实渲染页数计数)，前缀带日期+司机方便辨认
      // 是哪一叠(客户要求，20260718)。
      const driverLabel = formatTripDriverList(wire.trip, wire.orders)
      const pageLabel = `Summary ${date}${driverLabel && driverLabel !== '—' ? ' ' + driverLabel : ''}`
      const pdf = await renderHtmlToPdf(html, { pageNumbers: true, pageLabel })
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="delivery-summary-${date}.pdf"`,
          'Cache-Control': 'no-store',
        },
      })
    } catch (error) {
      console.error('[GET /api/print/dispatch-summary-pdf]', error)
      return NextResponse.json(
        { error: 'PDF 生成失败', message: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      )
    }
  }, { require: 'print.center.access' })
}
