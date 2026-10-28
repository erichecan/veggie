import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import {
  buildReturnStockMoves,
  postReturnStockMoves,
  applyReturnOrderLineReduction,
  syncOrderGoodsReturnStatus,
} from '@/lib/returns-engine'

/**
 * 审核 + 处置（退货/报废整合 M3，对齐 app/api/trips/[id]/returns PUT 的既有规则，
 * 共用 lib/returns-engine.ts 的 disposition → StockMove → OrderLine 记账规则）。
 *
 * approve: 必须给出 disposition（可再售 SELLABLE / 报废 SCRAP），决定库存去向；
 *   两种情形都调整 OrderLine.deliveredQty（货物已不在客户手上，不算已送达），
 *   并在 applyReturnOrderLineReduction 内部重算受影响订单的提成快照。
 * reject: 只改状态，不做库存和订单调整。
 *
 * PUT /api/order-returns/:id/review
 * body: { action: 'approve' | 'reject', disposition?, scrapReason?, note? }
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()
      const { action, disposition, scrapReason, note } = body as {
        action?: 'approve' | 'reject'
        disposition?: 'SELLABLE' | 'SCRAP'
        scrapReason?: string
        note?: string
      }

      if (action !== 'approve' && action !== 'reject') {
        return NextResponse.json({ error: '缺少必填字段: action(approve|reject)' }, { status: 400 })
      }
      if (action === 'approve' && disposition !== 'SELLABLE' && disposition !== 'SCRAP') {
        return NextResponse.json(
          { error: '批准退货必须选择货物去向：可再售(SELLABLE) 或 报废(SCRAP)' },
          { status: 400 },
        )
      }

      const ret = await prisma.orderReturn.findUnique({ where: { id } })
      if (!ret) {
        return NextResponse.json({ error: '退货记录不存在' }, { status: 404 })
      }
      if (ret.status !== 'PENDING_REVIEW') {
        return NextResponse.json(
          { error: `当前状态 ${ret.status} 不是待审核，可能已被处理或数据已过期`, status: ret.status },
          { status: 409 },
        )
      }

      const order = await prisma.order.findUnique({
        where: { id: ret.orderId },
        select: { id: true, code: true, restaurantId: true, restaurantName: true },
      })
      if (!order) {
        return NextResponse.json({ error: '关联订单不存在' }, { status: 404 })
      }

      if (action === 'reject') {
        const updated = await prisma.$transaction(async (tx) => {
          // updateMany + 状态锁定 where，防止两个并发审核请求都越过上面的前置检查、都执行一遍副作用
          const { count } = await tx.orderReturn.updateMany({
            where: { id, status: 'PENDING_REVIEW' },
            data: {
              status: 'REJECTED',
              approvedById: user.userId,
              approvedByName: user.name,
              approvedAt: new Date(),
              // 复用 warehouseNote 承载"最近一次处置备注"：OrderReturn 没有单独的审核备注列，
              // 到审核这一步仓库核实阶段的备注已经没有展示价值，这里覆盖是预期行为
              ...(note?.trim() ? { warehouseNote: note.trim() } : {}),
            },
          })
          if (count === 0) return null
          await syncOrderGoodsReturnStatus(tx, [{
            orderId: ret.orderId,
            status: 'REJECTED',
            productName: ret.productName,
            quantity: toNum(ret.quantity),
          }], user)
          return tx.orderReturn.findUnique({ where: { id } })
        })
        if (!updated) {
          return NextResponse.json(
            { error: '该退货记录已被处理，请刷新后重试', status: 'RACED' },
            { status: 409 },
          )
        }
        await writeLog({
          userId: user.userId, userEmail: user.email, userName: user.name,
          action: 'UPDATE', resource: 'order_return', resourceId: id,
          detail: `退货审核拒绝: ${ret.productName} × ${ret.quantity}${note ? ` — ${note}` : ''}`,
        })
        return NextResponse.json(serializeApi({ message: '已拒绝该退货申请', orderReturn: updated }))
      }

      const line = await prisma.orderLine.findFirst({
        where: { orderId: ret.orderId, productId: ret.productId },
        select: { uomId: true },
      })
      const quantity = toNum(ret.quantity)

      const stockMoves = buildReturnStockMoves({
        productId: ret.productId,
        productName: ret.productName,
        quantity,
        disposition: disposition as 'SELLABLE' | 'SCRAP',
        scrapReason,
        reason: ret.reason ?? undefined,
        uomId: line?.uomId ?? null,
        partnerId: order.restaurantId,
        partnerName: order.restaurantName,
        sourceType: 'ORDER_RETURN',
        sourceId: ret.id,
        sourceRef: order.code,
      })

      const updated = await prisma.$transaction(async (tx) => {
        // updateMany + 状态锁定 where，防止两个并发审核请求都越过上面的前置检查、都执行一遍副作用
        const { count } = await tx.orderReturn.updateMany({
          where: { id, status: 'PENDING_REVIEW' },
          data: {
            status: 'APPROVED',
            disposition,
            approvedById: user.userId,
            approvedByName: user.name,
            approvedAt: new Date(),
          },
        })
        if (count === 0) return null

        await postReturnStockMoves(tx, stockMoves, user)
        await applyReturnOrderLineReduction(tx, [{ orderId: ret.orderId, productId: ret.productId, reduceQty: quantity }])
        await syncOrderGoodsReturnStatus(tx, [{
          orderId: ret.orderId,
          status: 'APPROVED',
          productName: ret.productName,
          quantity,
          disposition: disposition as 'SELLABLE' | 'SCRAP',
        }], user)

        return tx.orderReturn.findUnique({ where: { id } })
      })

      if (!updated) {
        return NextResponse.json(
          { error: '该退货记录已被处理，请刷新后重试', status: 'RACED' },
          { status: 409 },
        )
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'order_return', resourceId: id,
        detail: `退货审核通过(${disposition === 'SELLABLE' ? '可再售' : '报废'}): ${ret.productName} × ${ret.quantity}`,
      })

      return NextResponse.json(serializeApi({ message: '已批准该退货申请', orderReturn: updated }))
    } catch (error) {
      console.error('[PUT /api/order-returns/[id]/review]', error)
      return NextResponse.json({ error: '退货审核失败' }, { status: 500 })
    }
  }, { require: 'dispatch.goods_return.review' })
}
