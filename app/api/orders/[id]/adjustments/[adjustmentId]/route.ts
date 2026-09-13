import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { assertOrderNotPickLockedForLineEdit, WavePickLockedError } from '@/lib/wave-pick-lock'
import { deleteAdjustment } from '@/lib/order-adjustments'

const LOCKED_STATUSES = ['LOCKED', 'CANCELLED', 'COMPLETED']

/**
 * DELETE /api/orders/:id/adjustments/:adjustmentId
 * 删除等价于减内容，拣货锁定期间恒放行（与删行同一把闸，PRD Feature D）。
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; adjustmentId: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id, adjustmentId } = await params
      const order = await prisma.order.findUnique({
        where: { id },
        select: { id: true, status: true },
      })
      if (!order) return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      if (LOCKED_STATUSES.includes(order.status)) {
        return NextResponse.json({ error: '该订单状态不允许修改明细' }, { status: 403 })
      }
      await assertOrderNotPickLockedForLineEdit(id, true)

      await deleteAdjustment(id, adjustmentId)

      await writeLog({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        action: 'DELETE',
        resource: 'order',
        resourceId: id,
        detail: `删除调整行: ${adjustmentId}`,
      })

      return NextResponse.json({ ok: true })
    } catch (e) {
      if (e instanceof WavePickLockedError) {
        return NextResponse.json({ error: e.message }, { status: 409 })
      }
      const err = e as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? '请求无效' }, { status: err.status })
      }
      console.error('[DELETE order adjustment]', e)
      return NextResponse.json(
        { error: e instanceof Error ? e.message : '删除失败' },
        { status: 500 },
      )
    }
  }, { require: 'sales.order.manage_adjustment' })
}
