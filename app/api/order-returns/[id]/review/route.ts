import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { round2, toNum } from '@/lib/decimal-helpers'
import {
  buildReturnStockMoves,
  postReturnStockMoves,
  applyReturnOrderLineReduction,
  syncOrderGoodsReturnStatus,
} from '@/lib/returns-engine'
import { creditForInvoicedReturn, createReturnCreditNoteRequest, reduceDraftInvoiceForReturn } from '@/lib/finance/return-credit-note'

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
      const { action, disposition, scrapReason, note, exchangeOrderId } = body as {
        action?: 'approve' | 'reject'
        disposition?: 'SELLABLE' | 'SCRAP'
        scrapReason?: string
        note?: string
        exchangeOrderId?: string
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
              ...(note?.trim() ? { salesNote: note.trim() } : {}),
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
        where: ret.orderLineId
          ? { id: ret.orderLineId, orderId: ret.orderId, productId: ret.productId }
          : { orderId: ret.orderId, productId: ret.productId },
        select: { uomId: true, unitPrice: true, taxRate: true },
      })
      if (!line) {
        return NextResponse.json({ error: '原订单中找不到对应商品行，无法核算贷记金额' }, { status: 400 })
      }
      const quantity = toNum(ret.warehouseAcceptedQuantity ?? ret.quantity)
      const returnedProductId = ret.actualReturnedProductId ?? ret.productId
      const returnedProductName = ret.actualReturnedProductName ?? ret.productName

      const stockMoves = buildReturnStockMoves({
        productId: returnedProductId,
        productName: returnedProductName,
        quantity,
        disposition: disposition as 'SELLABLE' | 'SCRAP',
        scrapReason,
        reason: ret.reason ?? undefined,
        uomId: returnedProductId === ret.productId ? line?.uomId ?? null : null,
        partnerId: order.restaurantId,
        partnerName: order.restaurantName,
        sourceType: 'ORDER_RETURN',
        sourceId: ret.id,
        sourceRef: order.code,
      })

      const result = await prisma.$transaction(async (tx) => {
        // updateMany + 状态锁定 where，防止两个并发审核请求都越过上面的前置检查、都执行一遍副作用
        const { count } = await tx.orderReturn.updateMany({
          where: { id, status: 'PENDING_REVIEW' },
          data: {
            status: 'APPROVED',
            disposition,
            ...(ret.actionType === 'exchange' ? { exchangeOrderId: exchangeOrderId?.trim() || null } : {}),
            approvedById: user.userId,
            approvedByName: user.name,
            approvedAt: new Date(),
            ...(note?.trim() ? { salesNote: note.trim() } : {}),
          },
        })
        if (count === 0) return null

        await postReturnStockMoves(tx, stockMoves, user)
        await applyReturnOrderLineReduction(tx, [{
          orderId: ret.orderId,
          orderLineId: ret.orderLineId ?? undefined,
          productId: ret.productId,
          reduceQty: quantity,
        }])
        if (ret.orderLineId) await reduceDraftInvoiceForReturn(tx, { orderId: ret.orderId, orderLineId: ret.orderLineId, quantity })
        await syncOrderGoodsReturnStatus(tx, [{
          orderId: ret.orderId,
          status: 'APPROVED',
          productName: returnedProductName,
          quantity,
          disposition: disposition as 'SELLABLE' | 'SCRAP',
        }], user)

        // 销售审核确认退货后，只建立待会计审核的申请；会计批准后才生成贷记单草稿。
        // 未开票的当天退货不建立申请，按修正后的实送数量开票。
        const billedQuantities = ret.orderLineId ? await creditForInvoicedReturn(tx, {
          sourceReturnId: `ORDER_RETURN:${ret.id}`,
          orderId: ret.orderId,
          orderLineId: ret.orderLineId,
          quantity,
          returnedAt: ret.createdAt,
        }) : null
        const creditNoteRequests = []
        for (const billed of billedQuantities ?? []) {
          creditNoteRequests.push(await createReturnCreditNoteRequest(tx, {
            sourceReturnId: `ORDER_RETURN:${ret.id}`,
            customerId: order.restaurantId,
            customerName: order.restaurantName,
            orderId: ret.orderId,
            orderCode: order.code ?? order.id,
            orderLineId: ret.orderLineId!,
            invoiceId: billed.sourceInvoiceId,
            productId: ret.productId,
            productName: ret.productName,
            quantity: billed.quantity,
            unitPrice: billed.unitPrice,
            taxRate: billed.taxRate,
            reason: [ret.actionType === 'exchange' ? '换货' : '退货', disposition === 'SCRAP' ? '报废' : '可再售', ret.reason].filter(Boolean).join(' · '),
          }, user))
        }

        return { orderReturn: await tx.orderReturn.findUnique({ where: { id } }), creditNoteRequests }
      })

      if (!result) {
        return NextResponse.json(
          { error: '该退货记录已被处理，请刷新后重试', status: 'RACED' },
          { status: 409 },
        )
      }

      const requestRefs = result.creditNoteRequests.map(cn => cn.name).join(', ')
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'order_return', resourceId: id,
        detail: `退货审核通过(${disposition === 'SELLABLE' ? '可再售' : '报废'}): ${ret.productName} × ${ret.quantity}${requestRefs ? ` · 待会计审核申请 ${requestRefs}` : ''}`,
      })

      return NextResponse.json(serializeApi({ message: '已批准该退货申请', orderReturn: result.orderReturn, creditNoteRequests: result.creditNoteRequests }))
    } catch (error) {
      console.error('[PUT /api/order-returns/[id]/review]', error)
      return NextResponse.json({ error: '退货审核失败' }, { status: 500 })
    }
  }, { require: 'dispatch.goods_return.review' })
}
