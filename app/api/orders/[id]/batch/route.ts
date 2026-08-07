import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { assignOrderToWave, removeOrderFromAllWaves } from '@/lib/wave-assign'
import { WavePickLockedError } from '@/lib/wave-pick-lock'

/**
 * 销售单列表分配/清空交货批次。
 * 单一存储 = PickingWave.orderIds(见 lib/wave-assign.ts)。本接口与销售单 PUT、调度台拖拽
 * 共用同一写入逻辑,保证双向一致。
 * - driverSlotId 非空：归到 (订单 deliveryDate ?? 今天, driverSlot) 的 wave。
 * - driverSlotId 为空：从订单当前所属 wave 移除。
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const { driverSlotId } = (await req.json()) as { driverSlotId: string | null }

      const order = await prisma.order.findUnique({ where: { id }, select: { id: true, code: true } })
      if (!order) return NextResponse.json({ error: '订单不存在' }, { status: 404 })

      if (!driverSlotId) {
        await removeOrderFromAllWaves(id)
        await writeLog({
          userId: user.userId, userEmail: user.email, userName: user.name,
          action: 'UPDATE', resource: 'order', resourceId: id,
          detail: `清空订单 ${order.code || id} 的交货批次`,
        })
        return NextResponse.json({ ok: true, driverSlotId: null })
      }

      const result = await assignOrderToWave(id, driverSlotId)
      if (!result) return NextResponse.json({ error: '司机批次不存在' }, { status: 400 })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'order', resourceId: id,
        detail: `分配订单 ${order.code || id} 到批次 ${result.driverName}`,
      })
      return NextResponse.json({ ok: true, driverSlotId, waveId: result.waveId, driverName: result.driverName })
    } catch (error) {
      if (error instanceof WavePickLockedError) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      console.error('[PUT /api/orders/[id]/batch]', error)
      return NextResponse.json({ error: '分配批次失败' }, { status: 500 })
    }
  }, { require: 'sales.order.assign_batch' })
}
