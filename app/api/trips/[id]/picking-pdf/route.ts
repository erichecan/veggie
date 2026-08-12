/**
 * GET /api/trips/[id]/picking-pdf
 *
 * 拣货单的真·服务端 PDF（Trip 实体维度，供 trips 列表页用）。数据源与
 * /api/trips/[id]/print-data 一致(loadTripPrintData)，服务端直接生成 HTML 再
 * 用无头 Chromium 渲染成 PDF 二进制返回，不接受客户端传来的任意 HTML。
 */
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { loadTripPrintData } from '@/lib/print/trip-loader'
import { stripAutoPrintScript } from '@/lib/print/trip-common'
import { generateTripPickingHtml } from '@/lib/print/trip-picking-template'
import { parsePickingVariant } from '@/lib/print/dispatch-print-html'
import { renderHtmlToPdf } from '@/lib/print/render-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['OPERATOR', 'BOSS', 'DRIVER', 'FINANCE', 'SALES']

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await params
    const { searchParams } = new URL(req.url)
    const variant = parsePickingVariant(searchParams.get('variant'))
    try {
      const wire = await loadTripPrintData(id)
      if (!wire) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }
      const data = { trip: wire.trip, orders: wire.orders, customers: new Map(wire.customers.map(c => [c.id, c])) }
      const html = stripAutoPrintScript(generateTripPickingHtml(data, variant))

      // ?format=html：直接返回排版好的 HTML，不过无头 Chromium。
      // 用途一是在浏览器里调打印样式（分页、拆箱副标这类改 CSS 要反复看），
      // 二是让自动化测试能对纸面内容做文本断言——在 PDF 二进制里找字既脆又难定位。
      // 鉴权与权限点(dispatch.trip.print)与 PDF 分支完全一致，不额外放开任何东西。
      if (searchParams.get('format') === 'html') {
        return new NextResponse(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      }

      const pdf = await renderHtmlToPdf(html, { pageNumbers: true })
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="picking-list-${id}.pdf"`,
          'Cache-Control': 'no-store',
        },
      })
    } catch (error) {
      console.error('[GET /api/trips/[id]/picking-pdf]', error)
      return NextResponse.json(
        { error: 'PDF 生成失败', message: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      )
    }
  }, { require: 'dispatch.trip.print' })
}
