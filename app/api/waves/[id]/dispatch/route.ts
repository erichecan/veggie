import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { dispatchWave } from '@/lib/wave-dispatch'
import { deliveryAssignmentLabel } from '@/lib/delivery-assignment-label'

/**
 * 确认出发：将波次内订单的交货日期(deliveryDate)回填为排程日期，
 * 状态推进到 IN_DELIVERY，并在波次上标记 dispatchedAt（防重复出发）。
 * 交货日期优先取波次自身的 waveDate（即配送中心顶部所选排程日期）。
 *
 * 核心事务逻辑在 lib/wave-dispatch.ts::dispatchWave，与「确认全部出发」批量按钮
 * （前端逐个调用本路由）、22 点自动兜底 cron 共用同一份实现。
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const body = (await req.json().catch(() => ({}))) as { date?: string }

      const result = await dispatchWave(id, body.date, { userId: user.userId, name: user.name })
      if (!result.ok) {
        const status = result.reason === '波次不存在' ? 404 : 400
        return NextResponse.json({ error: result.reason }, { status })
      }

      const fresh = await prisma.pickingWave.findUnique({ where: { id }, include: { pallets: { select: { seq: true } } } })
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail: `确认出发：${deliveryAssignmentLabel({
          driverName: fresh?.driverName,
          timeOfDay: fresh?.timeOfDay,
          batchNums: fresh?.pallets.map(p => p.seq) ?? [],
        })}，${result.updatedCount} 个订单交货日期=${result.deliveryDate.toISOString().slice(0, 10)}、状态转 IN_DELIVERY（库存在此步真正扣减，确认订单时只预留不扣减）`,
      })

      return NextResponse.json(serializeApi({ ...fresh, dispatchedCount: result.updatedCount, tripId: result.tripId }))
    } catch (error) {
      console.error('[PUT /api/waves/[id]/dispatch]', error)
      return NextResponse.json({ error: '确认出发失败' }, { status: 500 })
    }
  }, { require: 'dispatch.wave.update' })
}
