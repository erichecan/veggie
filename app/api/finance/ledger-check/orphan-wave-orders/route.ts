import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { fixOrphanWaveOrders } from '@/lib/ledger-check'

/**
 * POST /api/finance/ledger-check/orphan-wave-orders —— 统一退回已确认（20261021）
 * 「已排波次」却不在任何有日期的波次里的订单：移出这些波次、状态退回 CONFIRMED，再到调度台按日期排车。
 * 改订单排车归属，权限与调度台移出订单相同（dispatch.wave.update）。可重复调用。
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const r = await fixOrphanWaveOrders()
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: 'orphan-wave-orders',
        detail: `统一退回已确认：共 ${r.total} 张「已排波次」但不在任何司机车上的订单，成功 ${r.fixed.length} 张，失败 ${r.failed.length} 张`
          + (r.fixed.length ? `（${r.fixed.slice(0, 50).join('、')}${r.fixed.length > 50 ? ' 等' : ''}）` : ''),
      })
      return NextResponse.json(r)
    } catch (error) {
      console.error('[POST /api/finance/ledger-check/orphan-wave-orders]', error)
      return NextResponse.json({ error: '统一退回失败' }, { status: 500 })
    }
  }, { require: 'dispatch.wave.update' })
}
