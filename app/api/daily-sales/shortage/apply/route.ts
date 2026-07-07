import { type NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { syncOrderItemsSnapshot } from '@/lib/order-items'

type ShortageAction = 'DELETE_ALL' | 'DISTRIBUTE_EVEN' | 'DISTRIBUTE_MANUAL'

interface ApplyBody {
  productId: string
  productName: string
  date: string
  action: ShortageAction
  availableQty?: number
  manual?: Array<{ orderId: string; lineId: string; newQty: number }>
}

export async function POST(req: NextRequest) {
  return withAuth(req, async (user) => {
    const body: ApplyBody = await req.json()
    const { productId, productName, date, action, availableQty, manual } = body

    if (!productId || !productName || !date || !action) {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 })
    }

    const dayStart = new Date(date + 'T00:00:00.000Z')
    const dayEnd   = new Date(date + 'T23:59:59.999Z')

    const orders = await prisma.order.findMany({
      where: {
        status: { in: ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY'] },
        deliveryDate: { gte: dayStart, lte: dayEnd },
        lines: { some: { productId } },
      },
      include: { lines: { where: { productId } } },
    })

    if (orders.length === 0) {
      return NextResponse.json({ message: '未找到受影响的订单' })
    }

    await prisma.$transaction(async tx => {
      if (action === 'DELETE_ALL') {
        for (const order of orders) {
          const lineIds = order.lines.map(l => l.id)
          await tx.orderLine.deleteMany({ where: { id: { in: lineIds } } })

          const orderRecord = await tx.order.findUnique({ where: { id: order.id }, select: { totalAmount: true } })
          const orderTotalBefore = Number(orderRecord?.totalAmount ?? 0)
          const deletedSubtotal = order.lines.reduce((s, l) => s + Number(l.subtotal), 0)
          const orderTotalAfter = Math.max(0, orderTotalBefore - deletedSubtotal)

          await tx.order.update({ where: { id: order.id }, data: { totalAmount: orderTotalAfter } })
          await tx.orderAuditLog.create({
            data: {
              orderId: order.id,
              userId: user.userId,
              action: 'shortage_apply',
              changedFields: { type: 'DELETE_ALL', productId, productName, lineIds },
              totalBefore: orderTotalBefore,
              totalAfter: orderTotalAfter,
            },
          })
          // 改动 OrderLine 后回写 items 快照,下游(波次/配送/司机汇总)读到新数量
          await syncOrderItemsSnapshot(tx, order.id)
        }

      } else if (action === 'DISTRIBUTE_EVEN') {
        const count = orders.reduce((s, o) => s + o.lines.length, 0)
        const perOrder = (availableQty ?? 0) / Math.max(count, 1)

        for (const order of orders) {
          for (const line of order.lines) {
            const newQty = Number(perOrder.toFixed(3))
            const newSubtotal = Number((Number(line.unitPrice) * newQty).toFixed(2))
            await tx.orderLine.update({
              where: { id: line.id },
              data: { orderedQty: newQty, subtotal: newSubtotal },
            })
          }
          const allLines = await tx.orderLine.findMany({ where: { orderId: order.id } })
          const newTotal = Number(allLines.reduce((s, l) => s + Number(l.subtotal), 0).toFixed(2))
          const orderRecord = await tx.order.findUnique({ where: { id: order.id }, select: { totalAmount: true } })
          const totalBefore = Number(orderRecord?.totalAmount ?? 0)
          await tx.order.update({ where: { id: order.id }, data: { totalAmount: newTotal } })
          await tx.orderAuditLog.create({
            data: {
              orderId: order.id,
              userId: user.userId,
              action: 'shortage_apply',
              changedFields: { type: 'DISTRIBUTE_EVEN', productId, productName, availableQty, perOrder },
              totalBefore,
              totalAfter: newTotal,
            },
          })
          await syncOrderItemsSnapshot(tx, order.id)
        }

      } else if (action === 'DISTRIBUTE_MANUAL') {
        if (!manual || manual.length === 0) {
          throw new Error('手动分配模式缺少 manual 参数')
        }
        const byOrder = new Map<string, typeof manual>()
        for (const m of manual) {
          if (!byOrder.has(m.orderId)) byOrder.set(m.orderId, [])
          byOrder.get(m.orderId)!.push(m)
        }
        for (const [orderId, specs] of byOrder) {
          for (const spec of specs) {
            if (spec.newQty <= 0) {
              await tx.orderLine.delete({ where: { id: spec.lineId } })
            } else {
              const line = await tx.orderLine.findUnique({ where: { id: spec.lineId } })
              if (!line) continue
              const newQty = Number(spec.newQty.toFixed(3))
              const newSubtotal = Number((Number(line.unitPrice) * newQty).toFixed(2))
              await tx.orderLine.update({
                where: { id: spec.lineId },
                data: { orderedQty: newQty, subtotal: newSubtotal },
              })
            }
          }
          const allLines = await tx.orderLine.findMany({ where: { orderId } })
          const newTotal = Number(allLines.reduce((s, l) => s + Number(l.subtotal), 0).toFixed(2))
          const orderRecord = await tx.order.findUnique({ where: { id: orderId }, select: { totalAmount: true } })
          const totalBefore = Number(orderRecord?.totalAmount ?? 0)
          await tx.order.update({ where: { id: orderId }, data: { totalAmount: newTotal } })
          await tx.orderAuditLog.create({
            data: {
              orderId,
              userId: user.userId,
              action: 'shortage_apply',
              changedFields: { type: 'DISTRIBUTE_MANUAL', productId, productName, specs },
              totalBefore,
              totalAfter: newTotal,
            },
          })
          await syncOrderItemsSnapshot(tx, orderId)
        }
      }
    })

    return NextResponse.json({ ok: true, affected: orders.length })
  })
}
