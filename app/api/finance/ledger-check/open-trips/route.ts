import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { fixOpenTripsOfCompletedWaves } from '@/lib/ledger-check'

/**
 * POST /api/finance/ledger-check/open-trips —— 统一补完成行程（客户 20261021）
 * 波次已在调度台「标记完成」、出发时生成的行程却还没完成的，补成 COMPLETED 并结司机提成。
 * 改行程状态，权限与改行程相同（dispatch.trip.update）。可重复调用。
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const r = await fixOpenTripsOfCompletedWaves()
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'trip', resourceId: 'completed-wave-open-trips',
        detail: `统一补完成行程：共 ${r.total} 条（波次已标记完成），提成失败 ${r.failed.length} 条`
          + (r.fixed.length ? `（${r.fixed.slice(0, 50).join('、')}${r.fixed.length > 50 ? ' 等' : ''}）` : ''),
      })
      return NextResponse.json(r)
    } catch (error) {
      console.error('[POST /api/finance/ledger-check/open-trips]', error)
      return NextResponse.json({ error: '统一补完成行程失败' }, { status: 500 })
    }
  }, { require: 'dispatch.trip.update' })
}
