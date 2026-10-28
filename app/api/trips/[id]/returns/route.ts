import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import { recalcTripDriverCommission } from '@/lib/commission'
import {
  buildReturnStockMoves,
  postReturnStockMoves,
  applyReturnOrderLineReduction,
  calculateRefundAmount,
  type ReturnStockMovePlan,
  type OrderLineReduction,
} from '@/lib/returns-engine'
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
 *     driverSignature?: string,   // 司机手写签名（20260922），整批一次签，覆盖本次提交的所有条目
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
      const { restaurantId, returns: returnItems, driverSignature } = body as {
        restaurantId: string
        driverSignature?: string
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
      // 司机手写签名确认已上报（20260922 拍板）：证明"这条异常是我本人记录的"，不是可选项
      if (!driverSignature || !driverSignature.trim()) {
        return NextResponse.json({ error: '请先完成司机签名确认' }, { status: 400 })
      }

      const trip = await prisma.trip.findUnique({ where: { id } })
      if (!trip) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }

      // 允许在核货中/配送中/已完成的行程提交退货。20260922 曾漏了 VERIFYING——
      // 司机端出发前核货阶段（tripStatus === 'verifying'）本来就有"报告异常"按钮，
      // 漏掉这个状态会让司机点了按钮却提交 400，是本次改动引入的回归，已修复。
      const allowedStatuses = ['VERIFYING', 'IN_PROGRESS', 'COMPLETED']
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

      // 构建 ReturnItem 记录。20260922：初始状态改为 WAREHOUSE_PENDING——次日仓库
      // 核实实物在不在车上，核实通过才转 PENDING_REVIEW 进入现有销售/运营审核队列。
      const now = new Date().toISOString()
      const newReturns: ReturnItem[] = returnItems.map(ri => ({
        // 稳定 id：同一商品可能被多次分别上报（不同批次的异常，或历史订单补报），
        // 仓库核实/销售审核靠这个 id 精确定位到具体这一条，不靠 productId 猜
        id: crypto.randomUUID(),
        productId: ri.productId,
        productName: ri.productName,
        quantity: ri.quantity,
        reason: ri.reason,
        actionType: ri.actionType ?? 'return',
        photo: ri.photo,
        unitPrice: itemPriceMap.get(ri.productId),
        status: 'WAREHOUSE_PENDING' as const,
        restaurantId,
        restaurantName: restaurant.restaurantName,
        tripId: id,
        createdAt: now,
        driverSignature,
        driverSignedAt: now,
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
    // 司机上报 ≠ 销售/运营审核（PUT 那个 dispatch.trip.returns）——司机不能自己批准自己报的退货
  }, { require: ['dispatch.trip.report_return', 'dispatch.trip.returns'] })
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
          /// 首选定位方式（ReturnItem.id，20260922 补）；缺失时退回 productId+status 匹配
          returnId?: string
          action: 'approve' | 'reject'
          disposition?: 'SELLABLE' | 'SCRAP'
          scrapReason?: string
          refundMode?: 'pct' | 'fixed'
          refundPct?: number
          refundAmount?: number
          refundNote?: string
          /// 换货场景关联的新开订单单号（20260922），只做记录，不校验真实性
          exchangeOrderId?: string
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

      // 收集需要的数据库操作（StockMove/OrderLine 的记账规则见 lib/returns-engine.ts）
      const stockMoves: ReturnStockMovePlan[] = []
      const orderLineUpdates: OrderLineReduction[] = []

      let approvedCount = 0
      let rejectedCount = 0
      let sellableCount = 0
      let scrapCount = 0

      for (const review of reviews) {
        const rIdx = restaurants.findIndex(r => r.restaurantId === review.restaurantId)
        if (rIdx === -1) continue

        const restaurant = restaurants[rIdx]
        const returns = restaurant.returns ?? []

        // 找到匹配的 PENDING_REVIEW 退货记录。同一商品可能被分别上报两次（不同批次
        // 异常、或历史订单补报），优先按 returnId 精确定位；缺失时（历史遗留记录）
        // 才退回旧的 productId 匹配——那种匹配会命中数组里第一条同状态记录，
        // 不一定是审核人实际打开在看的那一条。
        const retIdx = review.returnId
          ? returns.findIndex(ret => ret.id === review.returnId && ret.status === 'PENDING_REVIEW')
          : returns.findIndex(ret => ret.productId === review.productId && ret.status === 'PENDING_REVIEW')
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
            refundAmount: review.refundAmount ?? calculateRefundAmount(toNum(ret.unitPrice), toNum(ret.quantity), review),
            refundNote: review.refundNote,
            exchangeOrderId: ret.actionType === 'exchange' ? review.exchangeOrderId?.trim() || undefined : undefined,
            approvedAt: new Date().toISOString(),
          }
          approvedCount++
          if (disposition === 'SELLABLE') sellableCount++
          else scrapCount++

          // 原订单行的单位：退货数量按它换算成基础单位（20261014 修：以前只有可再售那笔换算，
          // 流水记的是未换算的数，按箱退货时流水与 qtyOnHand 不一致）
          const sourceLine = await prisma.orderLine.findFirst({
            where: { orderId: { in: restaurant.orderIds }, productId: ret.productId },
            select: { uomId: true },
          })
          // P1-3: StockMove with source tracking; P1-4: decimal qty
          stockMoves.push(...buildReturnStockMoves({
            productId: ret.productId,
            productName: ret.productName,
            quantity: returnQty,
            disposition,
            scrapReason: review.scrapReason,
            reason: ret.reason,
            uomId: sourceLine?.uomId ?? null,
            partnerId: restaurant.restaurantId,
            partnerName: restaurant.restaurantName,
            sourceType: 'RETURN',
            sourceId: id,
            sourceRef: restaurant.orderIds?.[0] ?? null,
          }))

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

      // 20260923 补：reviews 非空但一条都没匹配上（returnId 传错/记录已被处理过/客户端数据过期），
      // 不能悄悄返回 200——前端只看请求成不成功就弹"已批准"，实测过一次真实回归：一条都没生效，
      // 用户却看到成功提示，Trip 状态原地不动
      if (approvedCount === 0 && rejectedCount === 0) {
        return NextResponse.json(
          { error: '没有匹配到可审核的退货记录（可能已被处理，或数据已过期，请刷新后重试）' },
          { status: 409 },
        )
      }

      // 事务: 更新 Trip JSON + 创建 StockMove + 调整 OrderLine
      await prisma.$transaction(async (tx) => {
        await tx.trip.update({
          where: { id },
          data: { restaurants: restaurants as never },
        })

        // 退货库存入账（lib/stock-ledger.ts，20261014 复式改造 L3；20261027 抽到 lib/returns-engine.ts）：
        //   每笔退货「客户 → 仓库」；报废的再接一笔「仓库 → 报废」。可再售的按 FEFO 反序回补批次。
        await postReturnStockMoves(tx, stockMoves, user)

        // P1-4: 逐条调整 OrderLine.deliveredQty（精确小数计算）+ 提成重算（deliveredQty 变了，
        // 受影响订单的司机提成快照需要重新覆盖，不再信旧快照）
        await applyReturnOrderLineReduction(tx, orderLineUpdates)
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
