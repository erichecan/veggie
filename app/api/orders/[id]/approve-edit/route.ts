import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * P1-6: 审批 CONFIRMED 后的订单修改
 *
 * PUT /api/orders/:id/approve-edit
 *   { approved: true }  — 管理层确认修改合理，清除 editApprovalRequired 标记
 *   { approved: false, reason?: string } — 管理层拒绝，需要回滚或人工处理
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()
      const { approved, reason } = body

      const order = await prisma.order.findUnique({
        where: { id },
        select: { id: true, code: true, editApprovalRequired: true },
      })
      if (!order) {
        return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      }
      if (!order.editApprovalRequired) {
        return NextResponse.json({ error: '该订单无需审批' }, { status: 400 })
      }

      if (approved) {
        const updated = await prisma.order.update({
          where: { id },
          data: { editApprovalRequired: false },
        })
        await writeLog({
          userId: user.userId, userEmail: user.email, userName: user.name,
          action: 'UPDATE', resource: 'order', resourceId: id,
          detail: `审批通过: 确认订单 ${order.code ?? id} 的修改`,
        })
        return NextResponse.json(serializeApi(updated))
      } else {
        // 拒绝：记录日志，但不自动回滚（由管理层手动处理）
        await writeLog({
          userId: user.userId, userEmail: user.email, userName: user.name,
          action: 'UPDATE', resource: 'order', resourceId: id,
          detail: `审批拒绝: 订单 ${order.code ?? id} 的修改 — ${reason ?? '无原因'}`,
        })
        return NextResponse.json({ message: '已记录拒绝，请手动处理' })
      }
    } catch (error) {
      console.error('[PUT /api/orders/[id]/approve-edit]', error)
      return NextResponse.json({ error: '审批操作失败' }, { status: 500 })
    }
  }, ['BOSS', 'OPERATOR'])
}
