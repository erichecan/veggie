import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum, round2 } from '@/lib/decimal-helpers'
import { recalcOrderCommission, recalcTripDriverCommission } from '@/lib/commission'
import { restoreLotsFIFO, toStockQty } from '@/lib/inventory'
import { SCRAP_REASON_LABEL } from '@/lib/scrap-reasons'
import type { TripRestaurant, ReturnItem, OrderItem } from '@/lib/types'

/**
 * P1-9: 拒收/退货处理
 *
 * 司机配送时，客户可能拒收部分商品或要求退货。
 * 流程：
 *   1. 司机提交退货记录（POST）→ 状态 PENDING_REVIEW
 *   2. 管理层审核（PUT）→ APPROVED / REJECTED
 *   3. APPROVED 后创建 StockMove(RETURN)，调整 OrderLine.deliveredQty
 *
 * GET  /api/trips/:id/returns — 查看退货记录
 * POST /api/trips/:id/returns — 司机提交退货
 * PUT  /api/trips/:id/returns — 审核退货
 */

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const trip = await prisma.trip.findUnique({
      where: { id },
      select: { id: true, name: true, status: true, restaurants: true },
    })
    if (!trip) {
      return NextResponse.json({ error: '行程不存在' }, { status: 404 })
    }

    const restaurants = (trip.restaurants ?? []) as unknown as TripRestaurant[]
    const allReturns: Array<ReturnItem & { restaurantId: string; restaurantName: string }> = []

    for (const r of restaurants) {
      for (const ret of (r.returns ?? [])) {
        allReturns.push({
          ...ret,
          restaurantId: r.restaurantId,
          restaurantName: r.restaurantName,
        })
      }
    }

    return NextResponse.json(serializeApi({
      tripId: trip.id,
      tripName: trip.name,
      totalReturns: allReturns.length,
      pendingCount: allReturns.filter(r => r.status === 'PENDING_REVIEW').length,
      approvedCount: allReturns.filter(r => r.status === 'APPROVED').length,
      rejectedCount: allReturns.filter(r => r.status === 'REJECTED').length,
      settledCount: allReturns.filter(r => r.status === 'SETTLED').length,
      returns: allReturns,
    }))
  } catch (error) {
    console.error('[GET /api/trips/[id]/returns]', error)
    return NextResponse.json({ error: '获取退货列表失败' }, { status: 500 })
  }
}

/**
 * POST — 司机提交退货/拒收
 *
 * 请求体:
 *   {
 *     restaurantId: string,
 *     returns: [{
 *       productId: string,
 *       productName: string,
 *       quantity: number,
 *       reason?: string,
 *       actionType?: 'return' | 'exchange',
 *       photo?: string
 *     }]
 *   }
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()
      const { restaurantId, returns: returnItems } = body as {
        restaurantId: string
        returns: Array<{
          productId: string
          productName: string
          quantity: number
          reason?: string
          actionType?: 'return' | 'exchange'
          photo?: string
        }>
      }

      if (!restaurantId || !Array.isArray(returnItems) || returnItems.length === 0) {
        return NextResponse.json(
          { error: '缺少必填字段: restaurantId, returns[]' },
          { status: 400 },
        )
      }

      const trip = await prisma.trip.findUnique({ where: { id } })
      if (!trip) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }

      // 允许在配送中或已完成的行程提交退货
      const allowedStatuses = ['IN_PROGRESS', 'COMPLETED']
      if (!allowedStatuses.includes(String(trip.status))) {
        return NextResponse.json(
          { error: `当前状态 ${trip.status} 不允许提交退货` },
          { status: 400 },
        )
      }

      const restaurants = (trip.restaurants ?? []) as unknown as TripRestaurant[]
      const rIdx = restaurants.findIndex(r => r.restaurantId === restaurantId)
      if (rIdx === -1) {
        return NextResponse.json(
          { error: `行程中未找到客户 ${restaurantId}` },
          { status: 404 },
        )
      }

      const restaurant = restaurants[rIdx]

      // 查找商品的单价（从 items 中获取，用于后续退款计算）
      const itemPriceMap = new Map(
        (restaurant.items ?? []).map((it: OrderItem) => [it.productId, it.price]),
      )

      // 构建 ReturnItem 记录
      const now = new Date().toISOString()
      const newReturns: ReturnItem[] = returnItems.map(ri => ({
        productId: ri.productId,
        productName: ri.productName,
        quantity: ri.quantity,
        reason: ri.reason,
        actionType: ri.actionType ?? 'return',
        photo: ri.photo,
        unitPrice: itemPriceMap.get(ri.productId),
        status: 'PENDING_REVIEW' as const,
        restaurantId,
        restaurantName: restaurant.restaurantName,
        tripId: id,
        createdAt: now,
      }))

      // 追加到 restaurant.returns
      const existingReturns = restaurant.returns ?? []
      restaurants[rIdx] = {
        ...restaurant,
        returns: [...existingReturns, ...newReturns],
      }

      await prisma.trip.update({
        where: { id },
        data: { restaurants: restaurants as never },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'trip', resourceId: id,
        detail: `退货提交: ${restaurant.restaurantName} — ${returnItems.length}项`,
      })

      return NextResponse.json(serializeApi({
        message: `已提交 ${returnItems.length} 项退货`,
        restaurantId,
        restaurantName: restaurant.restaurantName,
        returns: newReturns,
      }))
    } catch (error) {
      console.error('[POST /api/trips/[id]/returns]', error)
      return NextResponse.json({ error: '提交退货失败' }, { status: 500 })
    }
  }, { require: 'dispatch.trip.returns' })
}

/**
 * PUT — 审核退货
 *
 * 请求体:
 *   {
 *     reviews: [{
 *       restaurantId: string,
 *       productId: string,
 *       action: 'approve' | 'reject',
 *       refundMode?: 'pct' | 'fixed',
 *       refundPct?: number,
 *       refundAmount?: number,
 *       refundNote?: string,
 *     }]
 *   }
 *
 * approve: 必须同时给出 disposition（可再售/报废），决定库存去向
 *   - SELLABLE：货物回补可售库存 → Product.qtyOnHand += qty，FIFO 回补批次余量，
 *     创建 StockMove(RETURN, +qty)
 *   - SCRAP：货物报废，不回补可售库存 → 创建 StockMove(RETURN, +qty) 记录客退事实 +
 *     StockMove(SCRAP, -qty) 记录报废损耗（计入损耗仪表盘），qtyOnHand 净不变
 *   两种情形都调整 OrderLine.deliveredQty（货物已不在客户手上，不算已送达）
 * reject: 标记为 REJECTED, 不做库存和订单调整
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()
      const { reviews } = body as {
        reviews: Array<{
          restaurantId: string
          productId: string
          action: 'approve' | 'reject'
          disposition?: 'SELLABLE' | 'SCRAP'
          scrapReason?: string
          refundMode?: 'pct' | 'fixed'
          refundPct?: number
          refundAmount?: number
          refundNote?: string
        }>
      }

      if (!Array.isArray(reviews) || reviews.length === 0) {
        return NextResponse.json({ error: '缺少 reviews[]' }, { status: 400 })
      }
      const badDisposition = reviews.find(
        r => r.action === 'approve' && r.disposition !== 'SELLABLE' && r.disposition !== 'SCRAP',
      )
      if (badDisposition) {
        return NextResponse.json(
          { error: `批准退货 ${badDisposition.productId} 必须选择货物去向：可再售(SELLABLE) 或 报废(SCRAP)` },
          { status: 400 },
        )
      }

      const trip = await prisma.trip.findUnique({ where: { id } })
      if (!trip) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }

      const restaurants = (trip.restaurants ?? []) as unknown as TripRestaurant[]

      // 收集需要的数据库操作
      const stockMoves: Array<{
        productId: string
        productName: string
        type: 'RETURN' | 'SCRAP'
        lossStage?: string | null
        lossReason?: string | null
        qty: number
        note: string
        sourceType: string
        sourceId: string
        sourceRef: string | null
      }> = []
      const orderLineUpdates: Array<{
        orderId: string
        productId: string
        reduceQty: number
      }> = []
      // 仅 SELLABLE 处置需要真正回补可售库存；SCRAP 处置货物不回可售库存，只留 StockMove 记账
      const restockUpdates: Array<{ productId: string; qty: number; uomId: string | null }> = []

      let approvedCount = 0
      let rejectedCount = 0
      let sellableCount = 0
      let scrapCount = 0

      for (const review of reviews) {
        const rIdx = restaurants.findIndex(r => r.restaurantId === review.restaurantId)
        if (rIdx === -1) continue

        const restaurant = restaurants[rIdx]
        const returns = restaurant.returns ?? []

        // 找到匹配的 PENDING_REVIEW 退货记录
        const retIdx = returns.findIndex(
          ret => ret.productId === review.productId && ret.status === 'PENDING_REVIEW',
        )
        if (retIdx === -1) continue

        const ret = returns[retIdx]

        if (review.action === 'approve') {
          const returnQty = toNum(ret.quantity)
          const disposition = review.disposition as 'SELLABLE' | 'SCRAP'

          // 更新退货状态为 APPROVED，P0-3: 退货日期使用今天而非行程日期
          returns[retIdx] = {
            ...ret,
            status: 'APPROVED',
            disposition,
            refundMode: review.refundMode,
            refundPct: review.refundPct,
            refundAmount: review.refundAmount ?? calculateRefund(ret, review),
            refundNote: review.refundNote,
            approvedAt: new Date().toISOString(),
          }
          approvedCount++
          if (disposition === 'SELLABLE') sellableCount++
          else scrapCount++

          // P1-3: StockMove with source tracking; P1-4: decimal qty
          // 客退入库记账：无论去向如何，先记一笔"货物回来了"
          stockMoves.push({
            productId: ret.productId,
            productName: ret.productName,
            type: 'RETURN',
            qty: returnQty,
            note: `退货入库(${disposition === 'SELLABLE' ? '可再售' : '待报废'}): ${restaurant.restaurantName} — ${ret.reason ?? '无原因'}`,
            sourceType: 'RETURN',
            sourceId: id,
            sourceRef: restaurant.orderIds?.[0] ?? null,
          })

          if (disposition === 'SELLABLE') {
            // 可再售：真正回补库存，供 FIFO 出库和批次台账使用
            // 多单位销售(20260714)：退货按原订单行选用的单位换算成库存记账单位
            const sourceLine = await prisma.orderLine.findFirst({
              where: { orderId: { in: restaurant.orderIds }, productId: ret.productId },
              select: { uomId: true },
            })
            restockUpdates.push({ productId: ret.productId, qty: returnQty, uomId: sourceLine?.uomId ?? null })
          } else {
            // 报废：不回补可售库存，额外记一笔报废损耗（计入损耗仪表盘 & 退货回收率）
            const reasonKey = review.scrapReason ?? 'CUSTOMER_RETURN_DAMAGED'
            const reasonLabel = SCRAP_REASON_LABEL[reasonKey] ?? reasonKey
            stockMoves.push({
              productId: ret.productId,
              productName: ret.productName,
              type: 'SCRAP',
              qty: -returnQty,
              note: `客退报废(${reasonLabel}): ${restaurant.restaurantName} — ${ret.reason ?? '无原因'}`,
              // 结构化归因（台账 E4）：客退报废天然属「客退」环节，不必让看板再从 note 里猜
              lossStage: 'CUSTOMER_RETURN',
              lossReason: reasonKey,
              sourceType: 'RETURN_SCRAP',
              sourceId: id,
              sourceRef: restaurant.orderIds?.[0] ?? null,
            })
          }

          // 调整 OrderLine.deliveredQty（减去退货数量，货物已不在客户手上）P1-4: 精确小数
          for (const orderId of restaurant.orderIds) {
            orderLineUpdates.push({
              orderId,
              productId: ret.productId,
              reduceQty: returnQty,
            })
          }
        } else {
          // 拒绝退货
          returns[retIdx] = {
            ...ret,
            status: 'REJECTED',
            refundNote: review.refundNote,
          }
          rejectedCount++
        }

        restaurants[rIdx] = { ...restaurant, returns }
      }

      // 事务: 更新 Trip JSON + 创建 StockMove + 调整 OrderLine
      await prisma.$transaction(async (tx) => {
        await tx.trip.update({
          where: { id },
          data: { restaurants: restaurants as never },
        })

        // P1-3: 批量创建退货库存记录（含来源追踪）
        if (stockMoves.length > 0) {
          await tx.stockMove.createMany({
            data: stockMoves.map(sm => ({
              productId: sm.productId,
              productName: sm.productName,
              type: sm.type,
              qty: sm.qty,
              movedAt: new Date(),
              note: sm.note,
              lossStage: sm.lossStage ?? null,
              lossReason: sm.lossReason ?? null,
              sourceType: sm.sourceType,
              sourceId: sm.sourceId,
              sourceRef: sm.sourceRef,
            })),
          })
        }

        // SELLABLE 处置：真正回补 Product.qtyOnHand + FIFO 回补批次余量
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const txAny = tx as any
        for (const r of restockUpdates) {
          const stockQty = await toStockQty(txAny, r.productId, r.qty, r.uomId)
          await tx.product.update({
            where: { id: r.productId },
            data: { qtyOnHand: { increment: stockQty } },
          })
          await restoreLotsFIFO(txAny, r.productId, stockQty)
        }

        // P1-4: 逐条调整 OrderLine.deliveredQty（精确小数计算）
        for (const upd of orderLineUpdates) {
          const line = await tx.orderLine.findFirst({
            where: { orderId: upd.orderId, productId: upd.productId },
            select: { id: true, deliveredQty: true },
          })
          if (line) {
            const current = toNum(line.deliveredQty)
            const newQty = round2(Math.max(0, current - upd.reduceQty))
            await tx.orderLine.update({
              where: { id: line.id },
              data: { deliveredQty: newQty },
            })
          }
        }

        // 提成重算：deliveredQty 变了，受影响订单的司机提成快照需要重新覆盖（不再信旧快照）
        const affectedOrderIds = Array.from(new Set(orderLineUpdates.map(u => u.orderId)))
        for (const orderId of affectedOrderIds) {
          await recalcOrderCommission(orderId, tx)
        }
        await recalcTripDriverCommission(id, tx)
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'trip', resourceId: id,
        detail: `退货审核: 通过${approvedCount}项(可再售${sellableCount}/报废${scrapCount}), 拒绝${rejectedCount}项`,
      })

      return NextResponse.json(serializeApi({
        message: `已审核 ${reviews.length} 项退货`,
        approved: approvedCount,
        rejected: rejectedCount,
        sellable: sellableCount,
        scrap: scrapCount,
      }))
    } catch (error) {
      console.error('[PUT /api/trips/[id]/returns]', error)
      return NextResponse.json({ error: '退货审核失败' }, { status: 500 })
    }
  }, { require: 'dispatch.trip.returns' })
}

/** P1-4: 计算退款金额（精确小数） */
function calculateRefund(
  ret: ReturnItem,
  review: { refundMode?: 'pct' | 'fixed'; refundPct?: number; refundAmount?: number },
): number {
  if (review.refundAmount !== undefined) return round2(review.refundAmount)
  const unitPrice = toNum(ret.unitPrice)
  const qty = toNum(ret.quantity)
  const total = round2(unitPrice * qty)
  if (review.refundMode === 'pct' && review.refundPct !== undefined) {
    return round2(total * review.refundPct / 100)
  }
  return total
}
