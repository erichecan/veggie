import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { assertWaveNotPickLocked, WavePickLockedError } from '@/lib/wave-pick-lock'

/**
 * 分配完成标记：纯进度标记，可反悔。
 * body.done=true  → 回填 assignmentDoneAt=now（要求批次有订单、未出发）
 * body.done=false → 清空 assignmentDoneAt（撤销）
 * 不改订单状态/交货日期/波次理货状态，不触发任何下游动作。
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const { done } = (await req.json().catch(() => ({}))) as { done?: boolean }

      const wave = await prisma.pickingWave.findUnique({ where: { id } })
      if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })
      await assertWaveNotPickLocked(id)
      if (wave.dispatchedAt) {
        return NextResponse.json({ error: '该批次已确认出发，无法更改分配完成标记' }, { status: 400 })
      }
      if (done && ((wave.orderIds as string[]) ?? []).length === 0) {
        return NextResponse.json({ error: '空批次不能标记分配完成' }, { status: 400 })
      }

      const updated = await prisma.pickingWave.update({
        where: { id },
        data: { assignmentDoneAt: done ? new Date() : null },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail: `${done ? '标记分配完成' : '撤销分配完成'}：批次 ${wave.name ?? id}`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      if (error instanceof WavePickLockedError) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      console.error('[PUT /api/waves/[id]/assignment-done]', error)
      return NextResponse.json({ error: '操作失败' }, { status: 500 })
    }
  }, { require: 'dispatch.wave.update' })
}
