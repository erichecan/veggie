import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { createOrderReturn, OrderReturnInputError } from '@/lib/order-returns'

/**
 * 日销售中心「退货登记」手动入口（20261027，退货/报废整合 M3）。
 *
 * 手动登记与司机上报共用 OrderReturn，并必须关联精确的 orderLineId。
 *
 * GET  /api/order-returns — 列表（operator/inventory「退换货」看板读取）
 * POST /api/order-returns — 登记一条退货（初始状态 WAREHOUSE_PENDING，次日仓库核实）
 */

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
          take: RETURNS_LIST_CAP,
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
  }, { require: ['dispatch.goods_return.warehouse_verify', 'dispatch.goods_return.review'] })
}

/**
 * POST — 登记一条退货
 *
 * 请求体:
 *   {
 *     orderId: string,
 *     orderLineId: string,
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
      const { orderId, orderLineId, quantity, reason, actionType, exchangeOrderId } = body as {
        orderId?: string
        orderLineId?: string
        quantity?: number
        reason?: string
        actionType?: 'return' | 'exchange'
        exchangeOrderId?: string
      }

      if (!orderId || !orderLineId || !Number.isFinite(quantity) || Number(quantity) <= 0) {
        return NextResponse.json(
          { error: '缺少必填字段: orderId, orderLineId, quantity(>0)' },
          { status: 400 },
        )
      }
      const created = await prisma.$transaction(tx => createOrderReturn(tx, {
        orderId,
        orderLineId,
        quantity: Number(quantity),
        reason,
        actionType,
        exchangeOrderId,
      }, user))

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'order_return', resourceId: created.id,
        detail: `退货登记: 订单 ${orderId} — ${created.productName} × ${quantity}`,
      })

      return NextResponse.json(serializeApi(created))
    } catch (error) {
      if (error instanceof OrderReturnInputError) {
        return NextResponse.json({ error: error.message }, { status: error.status })
      }
      console.error('[POST /api/order-returns]', error)
      return NextResponse.json({ error: '登记退货失败' }, { status: 500 })
    }
  }, { require: 'dispatch.goods_return.register' })
}
