import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { listReturns, type ReturnState } from '@/lib/accounting/returns'

/**
 * GET /api/accounting/returns —— 核销管理页回单清单（20261021，见 lib/accounting/returns.ts）
 *   ?tab=open|returned  &from=&to=（送货日期）&driver=&timeOfDay=am|pm&payment=CASH|ONLINE
 *   &status=PENDING,ISSUE,RETURNED  &q=单号/客户
 * 只读；权限与「钱」板块相同（finance.settlement.read）。打印页也走这里。
 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const sp = new URL(req.url).searchParams
      const tab = sp.get('tab') === 'returned' ? 'returned' : 'open'
      const status = (sp.get('status') ?? '').split(',').map(s => s.trim().toUpperCase())
        .filter((s): s is ReturnState => s === 'PENDING' || s === 'ISSUE' || s === 'RETURNED')
      const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
      const data = await listReturns({
        tab,
        from: day(sp.get('from')),
        to: day(sp.get('to')),
        driver: sp.get('driver') || null,
        timeOfDay: sp.get('timeOfDay') || null,
        payment: ['CASH', 'ONLINE'].includes(String(sp.get('payment')).toUpperCase()) ? String(sp.get('payment')).toUpperCase() : null,
        status: status.length ? status : null,
        q: sp.get('q'),
      })
      return NextResponse.json(data)
    } catch (error) {
      console.error('[GET /api/accounting/returns]', error)
      return NextResponse.json({ error: '获取回单清单失败' }, { status: 500 })
    }
  }, { require: 'finance.settlement.read' })
}
