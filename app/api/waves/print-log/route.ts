import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'

/**
 * POST /api/waves/print-log
 * 记录打印中心的打印动作（送货单 / 汇总单 / 批量送货单）到操作记录。
 * 拣货单的打印由 pick-lock 顺带记录，不走这里。
 * detail 一律由服务端按枚举拼装（不信任客户端自由文本），并带上配送日期，
 * 便于操作记录面板按日期过滤（resource 统一 picking-wave，与锁定/解锁同源）。
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as {
    date?: string
    type?: 'delivery' | 'summary' | 'sales'
    scope?: 'batch' | 'bulk'
    batchLabel?: string
    waveId?: string
    count?: number
  }
  return withAuth(req, async (user) => {
    const { date, type, scope, batchLabel, waveId, count } = body
    if (!date || (type !== 'delivery' && type !== 'summary' && type !== 'sales')) {
      return NextResponse.json({ error: '参数不完整' }, { status: 400 })
    }

    const typeLabel = type === 'delivery' ? '送货单' : type === 'sales' ? '销售单' : '汇总单'
    const detail = scope === 'bulk'
      ? `批量打印${typeLabel} · 全部批次（${count ?? 0} 批次） · ${date}`
      : `打印${typeLabel} · ${batchLabel || '未分配'} · ${date}`

    await writeLog({
      userId: user.userId, userEmail: user.email, userName: user.name,
      action: 'UPDATE', resource: 'picking-wave', resourceId: waveId ?? undefined,
      detail,
    })

    return NextResponse.json({ ok: true })
  })
}
