import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'

/**
 * PUT /api/lots/[id] —— 订正批次保质期（商品详情页 BBD 字段，20261016 客户反馈）
 * BBD 只读展示的是"最近一批进货"这个 Lot 的 bestBefore；没有商品级字段，订正就是
 * 改这条 Lot 本身。目前只开放 bestBefore 一个字段，数量/来源等保持只读——那些是
 * 发生过什么事的事实记录，不应被回改。
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const data = await req.json()
      const bestBeforeRaw = data.bestBefore

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const existing = await p.lot.findUnique({ where: { id } })
      if (!existing) return NextResponse.json({ error: '批次不存在' }, { status: 404 })

      let bestBefore: Date | null = null
      if (bestBeforeRaw) {
        bestBefore = new Date(bestBeforeRaw)
        if (Number.isNaN(bestBefore.getTime())) {
          return NextResponse.json({ error: 'bestBefore 不是有效日期' }, { status: 400 })
        }
      }

      const before = existing.bestBefore
      const lot = await p.lot.update({ where: { id }, data: { bestBefore } })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'lot', resourceId: id,
        detail: `${existing.lotNumber} 订正保质期：${before ? before.toISOString().slice(0, 10) : '（空）'} → ${bestBefore ? bestBefore.toISOString().slice(0, 10) : '（空）'}`,
      })

      return NextResponse.json(serializeApi(lot))
    } catch (error) {
      console.error('[PUT /api/lots/[id]]', error)
      return NextResponse.json({ error: '订正保质期失败' }, { status: 500 })
    }
  }, { require: 'stock.lot.manage' })
}
