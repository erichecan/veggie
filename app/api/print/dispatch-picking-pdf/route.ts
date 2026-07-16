/**
 * GET /api/print/dispatch-picking-pdf
 *
 * 拣货单的真·服务端 PDF：参数与 /api/orders/dispatch-print-data 完全一致
 * （date/fromDate/driverSlotId/batchLabel/waveIds/variant），服务端直接用同一个
 * loadDispatchPrintData() 取数据、生成 HTML，再用无头 Chromium 渲染成 PDF 二进制返回——
 * 不接受客户端传来的任意 HTML（避免无头浏览器被拿去做 SSRF 跳板）。
 */
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { loadDispatchPrintData } from '@/lib/print/dispatch-loader'
import { stripAutoPrintScript } from '@/lib/print/trip-common'
import { generateTripPickingHtml } from '@/lib/print/trip-picking-template'
import { parsePickingVariant } from '@/lib/print/dispatch-print-html'
import { renderHtmlToPdf } from '@/lib/print/render-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['OPERATOR', 'BOSS', 'DRIVER', 'FINANCE', 'SALES']

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const { searchParams } = new URL(req.url)
    const date = searchParams.get('date')
    const fromDate = searchParams.get('fromDate') ?? undefined
    const driverSlotId = searchParams.get('driverSlotId')
    const batchLabel = searchParams.get('batchLabel')
    const waveIdsParam = searchParams.get('waveIds')
    const waveIds = waveIdsParam ? waveIdsParam.split(',').filter(Boolean) : undefined
    const variant = parsePickingVariant(searchParams.get('variant'))

    if (!date) {
      return NextResponse.json({ error: '缺少参数 date' }, { status: 400 })
    }

    try {
      const wire = await loadDispatchPrintData(date, { driverSlotId, batchLabel, waveIds }, fromDate)
      if (!wire) {
        return NextResponse.json({ error: '该批次无订单数据' }, { status: 404 })
      }
      const data = { trip: wire.trip, orders: wire.orders, customers: new Map(wire.customers.map(c => [c.id, c])) }
      const html = stripAutoPrintScript(generateTripPickingHtml(data, variant))
      const pdf = await renderHtmlToPdf(html, { pageNumbers: true })
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="picking-list-${date}.pdf"`,
          'Cache-Control': 'no-store',
        },
      })
    } catch (error) {
      console.error('[GET /api/print/dispatch-picking-pdf]', error)
      return NextResponse.json(
        { error: 'PDF 生成失败', message: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      )
    }
  }, ALLOWED_ROLES)
}
