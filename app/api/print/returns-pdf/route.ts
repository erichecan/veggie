/**
 * GET /api/print/returns-pdf —— 未核销回单清单 PDF（核销管理，20261021）
 *   ?groupBy=date|driver &from=&to=&driver=&timeOfDay=am|pm&payment=CASH|ONLINE&status=PENDING,ISSUE
 * 与送货单 / 日报同一套：服务端取数（lib/accounting/returns.ts）→ HTML 模板 → 无头 Chromium 渲染 PDF。
 * 只读，权限与核销页「钱」板块相同（finance.settlement.read）。
 */
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { listReturns, type ReturnState } from '@/lib/accounting/returns'
import { buildReturnsReportHtml } from '@/lib/print/returns-report-template'
import { renderHtmlToPdf } from '@/lib/print/render-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const sp = new URL(req.url).searchParams
      const groupBy = sp.get('groupBy') === 'driver' ? 'driver' : 'date'
      const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
      const statusIn = (sp.get('status') ?? 'PENDING,ISSUE').split(',').map(s => s.trim().toUpperCase())
        .filter((s): s is ReturnState => s === 'PENDING' || s === 'ISSUE')
      const status: ReturnState[] = statusIn.length ? statusIn : ['PENDING', 'ISSUE']
      const payment = ['CASH', 'ONLINE'].includes(String(sp.get('payment')).toUpperCase()) ? String(sp.get('payment')).toUpperCase() : null
      const timeOfDay = sp.get('timeOfDay') === 'am' || sp.get('timeOfDay') === 'pm' ? sp.get('timeOfDay') : null
      const q = {
        tab: 'open' as const,
        from: day(sp.get('from')), to: day(sp.get('to')),
        driver: sp.get('driver') || null, timeOfDay, payment, status,
      }
      const { rows } = await listReturns(q)

      // 页头说明 + 页脚摘要：只列真正生效的筛选，一叠纸打乱了靠页脚也认得出是哪份
      const parts = [
        q.from || q.to ? `送货日期 ${q.from ?? '…'} ~ ${q.to ?? '…'}` : '全部日期（自 2026-09-13 起）',
        q.driver ? `司机 ${q.driver}` : '',
        timeOfDay ? (timeOfDay === 'am' ? '上午' : '下午') : '',
        payment ? (payment === 'CASH' ? '现付' : '转账') : '',
        status.length === 1 ? (status[0] === 'PENDING' ? '仅未回' : '仅有问题') : '未回 + 有问题',
      ].filter(Boolean)
      const meta = `${parts.join('  |  ')}  |  ${rows.length} 张  |  打印人：${user.name ?? user.email}`
      const pdf = await renderHtmlToPdf(buildReturnsReportHtml(rows, groupBy, meta), {
        pageNumbers: true,
        pageLabel: `未核销回单 · ${parts.join(' · ')}`,
      })
      return new NextResponse(new Uint8Array(pdf), {
        headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' },
      })
    } catch (error) {
      console.error('[GET /api/print/returns-pdf]', error)
      return NextResponse.json({ error: '生成未核销清单失败' }, { status: 500 })
    }
  }, { require: 'finance.settlement.read' })
}
