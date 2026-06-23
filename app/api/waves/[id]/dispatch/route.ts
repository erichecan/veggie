import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

/**
 * 确认出发：将波次内订单的交货日期(deliveryDate)回填为排程日期，
 * 状态推进到 IN_DELIVERY，并在波次上标记 dispatchedAt（防重复出发）。
 * 交货日期优先取波次自身的 waveDate（即配送中心顶部所选排程日期）。
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const body = (await req.json().catch(() => ({}))) as { date?: string }

      const wave = await prisma.pickingWave.findUnique({ where: { id } })
      if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })
      if (wave.dispatchedAt) {
        return NextResponse.json({ error: '该批次已确认出发' }, { status: 400 })
      }

      const orderIds = (wave.orderIds as string[]) ?? []
      if (orderIds.length === 0) {
        return NextResponse.json({ error: '该批次没有订单，无法出发' }, { status: 400 })
      }

      const deliveryDate = wave.waveDate
        ?? (body.date ? new Date(`${body.date}T00:00:00Z`) : null)
      if (!deliveryDate) {
        return NextResponse.json({ error: '缺少排程日期，无法确定交货日期' }, { status: 400 })
      }

      const [updated] = await prisma.$transaction([
        prisma.order.updateMany({
          where: { id: { in: orderIds }, status: { in: ['CONFIRMED', 'WAVE_ASSIGNED'] } },
          data: { deliveryDate, status: 'IN_DELIVERY' },
        }),
        prisma.pickingWave.update({
          where: { id },
          data: { dispatchedAt: new Date() },
        }),
      ])

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail: `确认出发：批次 ${wave.name ?? id}，${updated.count} 个订单交货日期=${deliveryDate.toISOString().slice(0, 10)}`,
      })

      const fresh = await prisma.pickingWave.findUnique({ where: { id } })
      return NextResponse.json(serializeApi({ ...fresh, dispatchedCount: updated.count }))
    } catch (error) {
      console.error('[PUT /api/waves/[id]/dispatch]', error)
      return NextResponse.json({ error: '确认出发失败' }, { status: 500 })
    }
  })
}
