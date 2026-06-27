import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'

/**
 * DELETE /api/orders/:id/lines/:lineId
 * 直接删除订单中的单行商品，并重算订单合计。
 * 仅允许在非 LOCKED / CANCELLED / COMPLETED 状态下操作。
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; lineId: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id, lineId } = await params

      const order = await prisma.order.findUnique({
        where: { id },
        select: { id: true, code: true, status: true },
      })
      if (!order) {
        return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      }

      const lockedStatuses = ['LOCKED', 'CANCELLED', 'COMPLETED']
      if (lockedStatuses.includes(order.status)) {
        return NextResponse.json({ error: '该订单状态不允许修改明细' }, { status: 403 })
      }

      const line = await prisma.orderLine.findUnique({
        where: { id: lineId },
        select: { id: true, orderId: true, productName: true, orderedQty: true },
      })
      if (!line || line.orderId !== id) {
        return NextResponse.json({ error: '订单行不存在' }, { status: 404 })
      }

      await prisma.orderLine.delete({ where: { id: lineId } })

      const remaining = await prisma.orderLine.findMany({
        where: { orderId: id },
        select: { subtotal: true },
      })
      const newTotal = remaining.reduce((s, l) => s + Number(l.subtotal), 0)
      await prisma.order.update({
        where: { id },
        data: { totalAmount: Math.round(newTotal * 100) / 100 },
      })

      await writeLog({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        action: 'DELETE',
        resource: 'order',
        resourceId: id,
        detail: `删除订单行: ${line.productName}（数量 ${Number(line.orderedQty)}）`,
      })

      return NextResponse.json({ ok: true })
    } catch (e) {
      console.error('[DELETE order line]', e)
      return NextResponse.json(
        { error: e instanceof Error ? e.message : '删除失败' },
        { status: 500 },
      )
    }
  })
}
