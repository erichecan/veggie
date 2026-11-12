import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * 日销售中心「退货登记」手动入口（20261027，退货/报废整合 M3）。
 *
 * 跟司机端上报（Trip.restaurants[].returns，ReturnItem）是两条入口，状态机/审核/
 * 处置规则完全一致（lib/returns-engine.ts），落库表不同（OrderReturn，直接挂 orderId，
 * 不用像 ReturnItem 那样反查行程里的 restaurantId）。
 *
 * GET  /api/order-returns — 列表（operator/inventory「退换货」看板读取）
 * POST /api/order-returns — 登记一条退货（初始状态 WAREHOUSE_PENDING，次日仓库核实）
 */

const ALLOWED_ORDER_STATUSES = ['IN_DELIVERY', 'COMPLETED']

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const status = searchParams.get('status')
      const orderId = searchParams.get('orderId')

      const where: Record<string, unknown> = {}
      if (status) where.status = status
      if (orderId) where.orderId = orderId

      // 看板不传 status/orderId，读全表；随着历史记录增多查询数据量会线性增长。
      // 计数走 groupBy 聚合（不受 take 限制，恒等于真实总数），列表本身限额 300 条——
      // 待核实/待审核两栏天然是活跃数据不会很大，截断只影响"已处理"栏的历史尾巴，
      // 不影响看板该展示的内容（20261027 code-review 补）
      const RETURNS_LIST_CAP = 300
      const [grouped, returns] = await Promise.all([
        prisma.orderReturn.groupBy({ by: ['status'], where, _count: { _all: true } }),
        prisma.orderReturn.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: orderId ? undefined : RETURNS_LIST_CAP,
          include: {
            order: { select: { code: true, restaurantId: true, restaurantName: true } },
          },
        }),
      ])
      const countOf = (s: string) => grouped.find(g => g.status === s)?._count._all ?? 0

      return NextResponse.json(serializeApi({
        total: grouped.reduce((sum, g) => sum + g._count._all, 0),
        warehousePendingCount: countOf('WAREHOUSE_PENDING'),
        pendingReviewCount: countOf('PENDING_REVIEW'),
        approvedCount: countOf('APPROVED'),
        rejectedCount: countOf('REJECTED'),
        settledCount: countOf('SETTLED'),
        returns,
      }))
    } catch (error) {
      console.error('[GET /api/order-returns]', error)
      return NextResponse.json({ error: '获取退货列表失败' }, { status: 500 })
    }
  }, { require: ['dispatch.goods_return.warehouse_verify', 'dispatch.goods_return.review', 'dispatch.goods_return.register'] })
}

/**
 * POST — 登记一条退货
 *
 * 请求体:
 *   {
 *     orderId: string,
 *     orderLineId: string,
 *     productId: string,
 *     quantity: number,
 *     reason?: string,
 *     actionType?: 'return' | 'exchange',
 *     exchangeOrderId?: string   // actionType=exchange 时可选填关联的新开订单号
 *   }
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()
      const { orderId, orderLineId, productId, quantity, reason, actionType, exchangeOrderId } = body as {
        orderId?: string
        orderLineId?: string
        productId?: string
        quantity?: number
        reason?: string
        actionType?: 'return' | 'exchange'
        exchangeOrderId?: string
      }

      if (!orderId || !orderLineId || !productId || !Number.isFinite(quantity) || !quantity || quantity <= 0) {
        return NextResponse.json(
          { error: '缺少必填字段: orderId, orderLineId, productId, quantity(>0)' },
          { status: 400 },
        )
      }

      const result = await prisma.$transaction(async tx => {
        // Serialize registrations per order so simultaneous requests cannot
        // both pass the remaining-quantity check.
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
        const order = await tx.order.findUnique({
          where: { id: orderId },
          select: { id: true, status: true },
        })
        if (!order) return { error: '订单不存在', status: 404 as const }
        if (!ALLOWED_ORDER_STATUSES.includes(String(order.status))) {
          return { error: `订单状态 ${order.status} 还没送达，不能登记退货`, status: 400 as const }
        }

        const line = await tx.orderLine.findFirst({
          where: { id: orderLineId, orderId, productId },
          select: { id: true, productName: true, deliveredQty: true },
        })
        if (!line) return { error: '订单商品行不存在或与商品不匹配', status: 404 as const }

        const priorReturns = await tx.orderReturn.findMany({
          where: {
            orderId,
            productId,
            status: { in: ['WAREHOUSE_PENDING', 'PENDING_REVIEW'] },
            OR: [{ orderLineId: line.id }, { orderLineId: null }],
          },
          select: { quantity: true },
        })
        const alreadyReserved = priorReturns.reduce((sum, row) => sum + Number(row.quantity), 0)
        const delivered = Number(line.deliveredQty)
        const remaining = Math.max(0, delivered - alreadyReserved)
        if (quantity > remaining + 0.000001) {
          return {
            error: `退货数量超过可登记数量。已送达 ${delivered}，已登记 ${alreadyReserved}，本次最多可登记 ${remaining}`,
            status: 400 as const,
          }
        }

        const created = await tx.orderReturn.create({
          data: {
            orderId,
            orderLineId: line.id,
            productId,
            productName: line.productName,
            quantity,
            reason: reason?.trim() || undefined,
            actionType: actionType ?? 'return',
            exchangeOrderId: actionType === 'exchange' ? exchangeOrderId?.trim() || undefined : undefined,
            registeredById: user.userId,
            registeredByName: user.name,
          },
        })
        return { created, remaining: remaining - quantity }
      })

      if ('error' in result) {
        return NextResponse.json({ error: result.error }, { status: result.status })
      }
      const { created } = result

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'order_return', resourceId: created.id,
        detail: `退货登记: 订单 ${orderId} — ${created.productName} × ${quantity}`,
      })

      return NextResponse.json(serializeApi({ ...created, remainingQuantity: result.remaining }))
    } catch (error) {
      console.error('[POST /api/order-returns]', error)
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') {
        return NextResponse.json({ error: '退货登记正在被其他操作更新，请刷新后重试' }, { status: 409 })
      }
      return NextResponse.json({ error: '登记退货失败' }, { status: 500 })
    }
  }, { require: 'dispatch.goods_return.register' })
}
