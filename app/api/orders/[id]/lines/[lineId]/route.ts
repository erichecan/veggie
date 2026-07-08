import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { assertOrderNotPickLocked, WavePickLockedError } from '@/lib/wave-pick-lock'

/**
 * PATCH /api/orders/:id/lines/:lineId
 * 修改订单行数量并重算订单合计。newQty=0 则删除该行。
 * 仅允许在非 LOCKED / CANCELLED / COMPLETED 状态下操作。
 */
export async function PATCH(
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
      await assertOrderNotPickLocked(id)

      const line = await prisma.orderLine.findUnique({
        where: { id: lineId },
        select: { id: true, orderId: true, productId: true, productName: true, orderedQty: true, unitPrice: true },
      })
      if (!line || line.orderId !== id) {
        return NextResponse.json({ error: '订单行不存在' }, { status: 404 })
      }

      const body = await req.json() as { newQty: unknown }
      const newQty = Number(body.newQty)
      if (!Number.isFinite(newQty) || newQty < 0) {
        return NextResponse.json({ error: '无效的数量' }, { status: 400 })
      }

      const oldQty = Number(line.orderedQty)
      // 少供退库、多供扣库：确认订单时已按 orderedQty 扣过库存，改量在此把差额补回/补扣
      const qtyDelta = oldQty - newQty

      await prisma.$transaction(async (tx) => {
        if (newQty === 0) {
          await tx.orderLine.delete({ where: { id: lineId } })
        } else {
          const unitPrice = Number(line.unitPrice)
          const subtotal = Math.round(unitPrice * newQty * 100) / 100
          await tx.orderLine.update({
            where: { id: lineId },
            data: { orderedQty: newQty, subtotal },
          })
        }

        if (qtyDelta !== 0) {
          await tx.product.update({
            where: { id: line.productId },
            data: { qtyOnHand: { increment: qtyDelta } },
          })
        }

        const remaining = await tx.orderLine.findMany({
          where: { orderId: id },
          select: { subtotal: true },
        })
        const newTotal = remaining.reduce((s, l) => s + Number(l.subtotal), 0)
        await tx.order.update({
          where: { id },
          data: { totalAmount: Math.round(newTotal * 100) / 100 },
        })
      })

      await writeLog({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        action: 'UPDATE',
        resource: 'order',
        resourceId: id,
        detail: newQty === 0
          ? `删除订单行: ${line.productName}（原数量 ${oldQty}，新数量 0）`
          : `修改订单行数量: ${line.productName}（${oldQty} → ${newQty}）`,
      })

      return NextResponse.json({ ok: true })
    } catch (e) {
      if (e instanceof WavePickLockedError) {
        return NextResponse.json({ error: e.message }, { status: 409 })
      }
      console.error('[PATCH order line]', e)
      return NextResponse.json(
        { error: e instanceof Error ? e.message : '修改失败' },
        { status: 500 },
      )
    }
  })
}

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
      await assertOrderNotPickLocked(id)

      const line = await prisma.orderLine.findUnique({
        where: { id: lineId },
        select: { id: true, orderId: true, productId: true, productName: true, orderedQty: true },
      })
      if (!line || line.orderId !== id) {
        return NextResponse.json({ error: '订单行不存在' }, { status: 404 })
      }

      const oldQty = Number(line.orderedQty)

      await prisma.$transaction(async (tx) => {
        await tx.orderLine.delete({ where: { id: lineId } })

        if (oldQty !== 0) {
          await tx.product.update({
            where: { id: line.productId },
            data: { qtyOnHand: { increment: oldQty } },
          })
        }

        const remaining = await tx.orderLine.findMany({
          where: { orderId: id },
          select: { subtotal: true },
        })
        const newTotal = remaining.reduce((s, l) => s + Number(l.subtotal), 0)
        await tx.order.update({
          where: { id },
          data: { totalAmount: Math.round(newTotal * 100) / 100 },
        })
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
      if (e instanceof WavePickLockedError) {
        return NextResponse.json({ error: e.message }, { status: 409 })
      }
      console.error('[DELETE order line]', e)
      return NextResponse.json(
        { error: e instanceof Error ? e.message : '删除失败' },
        { status: 500 },
      )
    }
  })
}
