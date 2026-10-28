import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { recalcTripDriverCommission } from '@/lib/commission'
import { completeDeliveredOrders, describeFailures } from '@/lib/delivery-complete'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const wave = await prisma.pickingWave.findUnique({ where: { id } })
      if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })
      if (!wave.dispatchedAt) return NextResponse.json({ error: '该批次尚未出发' }, { status: 400 })
      if (wave.completedAt) return NextResponse.json({ error: '该批次已标记完成' }, { status: 400 })

      const updated = await prisma.pickingWave.update({
        where: { id },
        data: { completedAt: new Date() },
      })

      // 波次是现在唯一在用的调度实体（Trip 自 20260704 起不再单独排，只在出发时按波次生成一条）。
      // 回写订单（实送量、COMPLETED、出库）与行程完成共用 lib/delivery-complete.ts；
      // ⛔ 20261026：开票与提成冻结不在这里做了，等会计核销确认后才触发（见 lib/delivery-complete.ts 头注释）。
      const orderIds = wave.orderIds
      const { completedIds, failures } = await completeDeliveredOrders(orderIds, {
        reason: '波次完成出库', userId: user.userId, createdBy: user.name ?? user.email,
      })

      // 出发时按波次生成的司机行程一并完成（20261020：原来只写波次 completedAt，行程一直挂在
      // PENDING，司机端还显示这一趟）。提成此时尚未冻结（等核销），Trip.driverCommission 先同步成 0，
      // 核销确认后再次回写。
      const trips = await prisma.trip.findMany({ where: { waveId: id, status: { not: 'COMPLETED' } }, select: { id: true } })
      if (trips.length > 0) {
        await prisma.trip.updateMany({ where: { id: { in: trips.map(t => t.id) } }, data: { status: 'COMPLETED' } })
        for (const t of trips) {
          await recalcTripDriverCommission(t.id, prisma).catch((e: unknown) => console.error('[wave complete: trip commission]', e))
        }
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail: `标记完成：批次 ${wave.name ?? id} 已完成配送，${completedIds.length}/${orderIds.length} 张订单回填实送数量与状态（开票/提成等核销确认后生成）${trips.length ? `，行程 ${trips.length} 条置为完成` : ''}${describeFailures(failures)}`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PUT /api/waves/[id]/complete]', error)
      return NextResponse.json({ error: '标记完成失败' }, { status: 500 })
    }
  }, { require: 'dispatch.wave.update' })
}
