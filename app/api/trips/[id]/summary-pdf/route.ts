/**
 * GET /api/trips/[id]/summary-pdf
 *
 * 汇总单的真·服务端 PDF（Trip 实体维度，供 trips 列表页用）。数据源与
 * /api/trips/[id]/print-data 一致(loadTripPrintData)，服务端直接生成 HTML 再
 * 用无头 Chromium 渲染成 PDF 二进制返回，不接受客户端传来的任意 HTML。
 */
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { loadTripPrintData } from '@/lib/print/trip-loader'
import { stripAutoPrintScript } from '@/lib/print/trip-common'
import { generateTripSummaryHtml } from '@/lib/print/trip-summary-template'
import { renderHtmlToPdf } from '@/lib/print/render-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['OPERATOR', 'BOSS', 'DRIVER', 'FINANCE', 'SALES']

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await params
    try {
      const wire = await loadTripPrintData(id)
      if (!wire) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }
      const data = { trip: wire.trip, orders: wire.orders, customers: new Map(wire.customers.map(c => [c.id, c])) }
      const html = stripAutoPrintScript(generateTripSummaryHtml(data))
      const pdf = await renderHtmlToPdf(html)
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="delivery-summary-${id}.pdf"`,
          'Cache-Control': 'no-store',
        },
      })
    } catch (error) {
      console.error('[GET /api/trips/[id]/summary-pdf]', error)
      return NextResponse.json(
        { error: 'PDF 生成失败', message: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      )
    }
  }, { require: 'dispatch.trip.print' })
}
