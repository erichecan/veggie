import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'

/**
 * P1-2: 客户小程序 — 订单详情
 *
 * GET /api/customer-portal/orders/:id
 *   - RESTAURANT 角色
 *   - 校验 order.restaurantId === user.userId（客户只能看自己的订单）
 *   - 返回订单基本信息 + 行明细 + 配送状态
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params

      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          lines: {
            orderBy: { sequence: 'asc' },
            select: {
              id: true,
              productId: true,
              productName: true,
              spec: true,
              uomId: true,
              uomName: true,
              unitPrice: true,
              taxRate: true,
              orderedQty: true,
              deliveredQty: true,
              subtotal: true,
              sequence: true,
            },
          },
          driverSlot: {
            select: { id: true, batchNum: true, timeOfDay: true, driverName: true },
          },
        },
      })

      if (!order) {
        return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      }

      // 安全校验：客户只能查看自己的订单
      if (order.restaurantId !== user.userId) {
        return NextResponse.json({ error: '无权查看此订单' }, { status: 403 })
      }

      return NextResponse.json(serializeApi({
        id: order.id,
        code: order.code,
        status: order.status,
        totalAmount: toNum(order.totalAmount),
        paymentMethod: order.paymentMethod,
        deliveryDate: order.deliveryDate,
        quotationDate: order.quotationDate,
        createdAt: order.createdAt,
        internalNote: order.internalNote,
        driverSlot: order.driverSlot,
        lines: order.lines.map(line => ({
          ...line,
          unitPrice: toNum(line.unitPrice),
          orderedQty: toNum(line.orderedQty),
          deliveredQty: toNum(line.deliveredQty),
          subtotal: toNum(line.subtotal),
          taxRate: line.taxRate != null ? toNum(line.taxRate) : null,
        })),
      }))
    } catch (error) {
      console.error('[GET /api/customer-portal/orders/[id]]', error)
      return NextResponse.json({ error: '获取订单详情失败' }, { status: 500 })
    }
  }, ['RESTAURANT'])
}
