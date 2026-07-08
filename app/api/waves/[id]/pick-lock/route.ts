import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * POST /api/waves/[id]/pick-lock
 * 打印员打印拣货单时触发：锁定该批次，调度台/销售单列表不可再改其订单归属。
 * 重打拣货单会再次调用此接口，刷新 pickLockedAt/pickLockedBy（重新上锁）。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // reason 区分锁定来源，让操作记录文案准确：'manual'=手动点锁定，'print'=打印拣货单触发
  const body = await req.json().catch(() => ({})) as { reason?: 'manual' | 'print'; variant?: string }
  return withAuth(req, async (user) => {
    try {
      const wave = await prisma.pickingWave.findUnique({ where: { id }, select: { id: true, name: true } })
      if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })

      const updated = await prisma.pickingWave.update({
        where: { id },
        data: { pickLockedAt: new Date(), pickLockedBy: user.name || user.email },
      })

      const variantLabel = body.variant === 'storable' ? '整箱整袋' : body.variant === 'consumable' ? '零散货' : ''
      const detail = body.reason === 'manual'
        ? `锁定批次 ${wave.name ?? id}`
        : `打印拣货单${variantLabel ? `（${variantLabel}）` : ''}，锁定批次 ${wave.name ?? id}`

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[POST /api/waves/[id]/pick-lock]', error)
      return NextResponse.json({ error: '锁定批次失败' }, { status: 500 })
    }
  })
}
