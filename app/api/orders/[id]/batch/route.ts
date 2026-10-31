import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { assignOrderToWave, removeOrderFromAllWaves } from '@/lib/wave-assign'
import { WavePickLockedError } from '@/lib/wave-pick-lock'
import { WaveDispatchedError } from '@/lib/wave-dispatch-lock'

/**
 * 销售单/报价单列表分配/清空交货批次。
 * 单一存储 = PickingWave.orderIds(见 lib/wave-assign.ts)。本接口与销售单 PUT、调度台拖拽
 * 共用同一写入逻辑,保证双向一致。PENDING 报价单只保存 driverSlotId 意向，不进入波次；
 * 报价单批量确认时再由订单 PUT 把司机意向同步到真实波次。已确认订单按
 * driverSlotId 加入 (订单 deliveryDate ?? 今天, driverSlot) 对应的 wave；清空时从当前 wave 移除。
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const { driverSlotId } = (await req.json()) as { driverSlotId: string | null }

      const order = await prisma.order.findUnique({ where: { id }, select: { id: true, code: true, status: true, driverSlotId: true } })
      if (!order) return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      // 报价阶段只存计划司机，不进 PickingWave，也不改报价状态/库存。
      if (order.status === 'PENDING') {
        const slot = driverSlotId
          ? await prisma.driverSlot.findFirst({ where: { id: driverSlotId, archived: false } })
          : null
        if (driverSlotId && !slot) return NextResponse.json({ error: '司机批次不存在或已归档' }, { status: 400 })
        await prisma.order.update({ where: { id }, data: { driverSlotId: slot?.id ?? null } })
        await writeLog({
          userId: user.userId, userEmail: user.email, userName: user.name,
          action: 'UPDATE', resource: 'order', resourceId: id,
          detail: slot
            ? `为报价单 ${order.code || id} 预安排司机 ${slot.batchNum} ${slot.timeOfDay} ${slot.driverName}`
            : `清除报价单 ${order.code || id} 的预安排司机`,
        })
        return NextResponse.json({ ok: true, driverSlotId: slot?.id ?? null, driverName: slot?.driverName ?? null })
      }
      // 已取消订单不能重新安排司机。
      if (driverSlotId && order.status === 'CANCELLED') {
        return NextResponse.json({ error: '报价单/已取消订单不能分配配送批次，请先确认订单' }, { status: 400 })
      }

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
      // ⛔ WaveDispatchedError 也要按 409 交出去。调度台的 assign/unassign 两条路由
      // 早就这么做了，唯独走 assignOrderToWave 的这条（销售单列表改派）漏了 ——
      // 同一条业务规则，从调度台拖拽得到「该批次已出发，不能再分配」，
      // 从销售单列表改派却得到无信息的 500「分配批次失败」。C4 实测撞出来的。
      if (error instanceof WavePickLockedError || error instanceof WaveDispatchedError) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      console.error('[PUT /api/orders/[id]/batch]', error)
      return NextResponse.json({ error: '分配批次失败' }, { status: 500 })
    }
  }, { require: 'sales.order.assign_batch' })
}
