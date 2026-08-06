import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { ensureSnapshots, recomputeSnapshots } from '@/lib/analytics/snapshot'
import { resolveDateRange } from '@/lib/analytics/metrics'
import { withCachedAuth } from '@/lib/analytics/cache'

/**
 * /api/analytics/snapshots
 * ============================================================================
 * GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD  快照序列（趋势图用）；先惰性补齐缺失日期
 * POST { days?: number } 或 { from, to }  强制重算（订正 credit note / 回写后用）
 */

export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      await ensureSnapshots()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const items = await p.dailyBusinessSnapshot.findMany({
        where: { snapshotDate: { gte: start, lt: end } },
        orderBy: { snapshotDate: 'asc' },
      })
      return NextResponse.json(serializeApi({ items }))
    } catch (error) {
      console.error('[GET /api/analytics/snapshots]', error)
      return NextResponse.json({ error: '获取快照失败' }, { status: 500 })
    }
  }, ['BOSS', 'OPERATOR', 'FINANCE'])
}

export async function POST(req: Request) {
  return withAuth(req, async () => {
    try {
      const body = await req.json().catch(() => ({}))
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      let from: Date
      let to = new Date(today)
      to.setDate(to.getDate() - 1)
      if (body.from) {
        from = new Date(body.from)
        if (body.to) to = new Date(body.to)
      } else {
        const days = Math.min(120, Math.max(1, Number(body.days ?? 7)))
        from = new Date(today)
        from.setDate(from.getDate() - days)
      }
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return NextResponse.json({ error: '日期格式无效' }, { status: 400 })
      }
      const recomputed = await recomputeSnapshots(from, to)
      return NextResponse.json({ recomputed })
    } catch (error) {
      console.error('[POST /api/analytics/snapshots]', error)
      return NextResponse.json({ error: '重算快照失败' }, { status: 500 })
    }
  }, ['BOSS', 'OPERATOR', 'FINANCE'])
}
