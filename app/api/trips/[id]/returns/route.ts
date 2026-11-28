
import { apiRouteErrorResponse } from '@/lib/api-route-error'
import { driverRowScope } from '@/lib/row-scope'
import { reviewOrderReturn, lockReturnOrders } from '@/lib/return-workflow'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { createOrderReturn, OrderReturnInputError } from '@/lib/order-returns'
import type { TripRestaurant, ReturnItem } from '@/lib/types'

/** Driver reports (current delivery, exact historical source, or unmatched intake).
 * Warehouse verifies custody/quality, Sales submits a request, Finance alone posts effects.
 * GET is scoped to the driver's own trip; no legacy JSON mutation is permitted here.
 */

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async user => {
  try {
    const { id } = await params
    const trip = await prisma.trip.findUnique({
      where: { id },
      select: { id: true, driverId: true, name: true, status: true, restaurants: true },
    })
    if (!trip) {
      return NextResponse.json({ error: '行程不存在' }, { status: 404 })
    }

    const scope = driverRowScope(user)
    if (scope && trip.driverId !== scope.userId) return NextResponse.json({ error: '行程不存在' }, { status: 404 })
    const query = new URL(req.url).searchParams
    const sourceCode = query.get('sourceOrderCode')?.trim()
    const sourceProduct = query.get('sourceProduct')?.trim().slice(0, 120)
    if (sourceCode || sourceProduct) {
      const restaurantId = query.get('restaurantId')
      const stops = trip.restaurants as unknown as TripRestaurant[]
      if (!stops.some(stop => stop.restaurantId === restaurantId)) return NextResponse.json({ error: '客户不属于本行程' }, { status: 403 })
      if (sourceProduct) {
        const product = { productName: { contains: sourceProduct, mode: 'insensitive' as const }, deliveredQty: { gt: 0 } }
        const sources = await prisma.order.findMany({
          where: { restaurantId: restaurantId!, status: { in: ['COMPLETED', 'LOCKED'] }, lines: { some: product } },
          select: { id: true, code: true, lines: { where: product, select: { id: true, productId: true, productName: true, spec: true, deliveredQty: true } } },
          orderBy: { deliveryDate: 'desc' },
        })
        return NextResponse.json(serializeApi(sources))
      }
      const source = await prisma.order.findFirst({ where: { code: { equals: sourceCode, mode: 'insensitive' }, restaurantId: restaurantId!, status: { in: ['COMPLETED', 'LOCKED'] } }, select: { id: true, code: true, lines: { select: { id: true, productId: true, productName: true, spec: true, deliveredQty: true } } } })
      if (!source) return NextResponse.json({ error: '未找到该客户已配送完成的原订单，请核对单号；无法确认来源的货物交仓库核实' }, { status: 404 })
      return NextResponse.json(serializeApi(source))
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

    const canonical = await prisma.orderReturn.findMany({
      where: { sourceTripId: id },
      include: { order: { select: { restaurantId: true, restaurantName: true } } },
      orderBy: { createdAt: 'asc' },
    })
    for (const ret of canonical) {
      allReturns.push({
        returnKind: ret.returnKind, approvedQuantity: ret.approvedQuantity == null ? undefined : Number(ret.approvedQuantity),
        id: ret.id,
        orderId: ret.orderId,
        orderLineId: ret.orderLineId ?? undefined,
        sourceTripId: id,
        productId: ret.productId,
        productName: ret.productName,
        quantity: Number(ret.quantity),
        photo: ret.photo ?? undefined,
        unitPrice: ret.unitPrice == null ? undefined : Number(ret.unitPrice),
        refundMode: ret.refundMode === 'fixed' ? 'fixed' : ret.refundMode === 'pct' ? 'pct' : undefined,
        refundPct: ret.refundPct == null ? undefined : Number(ret.refundPct),
        refundAmount: ret.refundAmount == null ? undefined : Number(ret.refundAmount),
        refundNote: ret.refundNote ?? undefined,
        reason: ret.reason ?? undefined,
        actionType: ret.actionType === 'exchange' ? 'exchange' : 'return',
        status: ret.status,
        disposition: ret.disposition ?? undefined,
        exchangeOrderId: ret.exchangeOrderId ?? undefined,
        lateReportNote: ret.lateReportNote ?? undefined,
        warehouseVerifiedById: ret.warehouseVerifiedById ?? undefined,
        warehouseVerifiedByName: ret.warehouseVerifiedByName ?? undefined,
        warehouseVerifiedAt: ret.warehouseVerifiedAt?.toISOString(),
        warehouseNote: ret.warehouseNote ?? undefined,
        createdAt: ret.createdAt.toISOString(),
        approvedAt: ret.approvedAt?.toISOString(),
        settledAt: ret.settledAt?.toISOString(),
        restaurantId: ret.order.restaurantId,
        restaurantName: ret.order.restaurantName,
        tripId: id,
      })
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
      intakes: await prisma.returnIntake.findMany({ where: { sourceTripId: id }, orderBy: { createdAt: 'desc' } }),
    }))
  } catch (error) {
    console.error('[GET /api/trips/[id]/returns]', error)
    return apiRouteErrorResponse(error, '获取退货列表失败')
  }
  }, { require: ['dispatch.trip.read_returns', 'dispatch.trip.report_return'] })
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
          returnKind?: 'CURRENT' | 'HISTORICAL'
          photoOnly?: boolean
          spec?: string
          uomLabel?: string
          orderId?: string
          orderLineId: string
          productId: string
          productName: string
          quantity: number
          reason?: string
          actionType?: 'return' | 'exchange'
          photo?: string
          /// 补报场景专用备注（20261028 M3），跟 reason 彻底分开
          lateReportNote?: string
          actualReturnedProductName?: string
          actualReturnedProductId?: string
        }>
      }

      if (!restaurantId || !Array.isArray(returnItems) || returnItems.length === 0 || returnItems.length > 100 || returnItems.some(item => !item || typeof item !== 'object')) {
        return NextResponse.json(
          { error: '缺少必填字段: restaurantId, returns[]' },
          { status: 400 },
        )
      }
      const trip = await prisma.trip.findUnique({ where: { id } })
      if (!trip) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }

      const driverScope = driverRowScope(user)
      if (driverScope && trip.driverId !== driverScope.userId) return NextResponse.json({ error: '行程不存在' }, { status: 404 })

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

      if (String(trip.status) === 'COMPLETED') {
        const missingLateNote = returnItems.find(ri => !ri.photoOnly && (!ri.lateReportNote || !ri.lateReportNote.trim()))
        if (missingLateNote) {
          return NextResponse.json(
            { error: `商品「${missingLateNote.productName}」是补报（行程已完成），请填写补报原因` },
            { status: 400 },
          )
        }
      }

      const restaurants = (trip.restaurants ?? []) as unknown as TripRestaurant[]
      const restaurant = restaurants.find(r => r.restaurantId === restaurantId)
      if (!restaurant) {
        return NextResponse.json(
          { error: `行程中未找到客户 ${restaurantId}` },
          { status: 404 },
        )
      }
      const newReturns = await prisma.$transaction(async tx => {
        const historicalIds = returnItems.flatMap(item => item.returnKind === 'HISTORICAL' && typeof item.orderId === 'string' ? [item.orderId] : [])
        await lockReturnOrders(tx, [...(restaurant.orderIds ?? []), ...historicalIds])
        const created = []
        for (const ri of returnItems) {
          if (ri.photoOnly === true) {
            const photo = typeof ri.photo === 'string' ? ri.photo.trim() : ''
            if (!photo || photo.length > 8_000_000) throw new OrderReturnInputError('请上传有效的签收单与退货照片')
            await tx.returnIntake.create({ data: {
              sourceTripId: id, customerId: restaurantId, customerName: restaurant.restaurantName,
              productName: '照片待识别', spec: '', uomLabel: '', quantity: 0,
              candidateOrderIds: ri.returnKind === 'HISTORICAL' ? [] : [...new Set(restaurant.orderIds ?? [])],
              photo, reason: ri.reason?.trim().slice(0, 500), reportedById: user.userId,
            } })
            continue
          }
          if (ri.actionType && ri.actionType !== 'return') throw new OrderReturnInputError('退货流程不支持换货，请另建新订单')
          if (ri.returnKind === 'HISTORICAL' && !ri.orderLineId) {
            if (!ri.productName?.trim() || !ri.spec?.trim() || !ri.uomLabel?.trim() || !Number.isFinite(ri.quantity) || ri.quantity <= 0 || Math.abs(ri.quantity * 1000 - Math.round(ri.quantity * 1000)) > 0.00001) throw new OrderReturnInputError('历史退货请填写商品名、规格、单位及有效数量')
            await tx.returnIntake.create({ data: { sourceTripId: id, customerId: restaurantId, customerName: restaurant.restaurantName, productName: ri.productName.trim().slice(0,200), spec: ri.spec.trim().slice(0,200), uomLabel: ri.uomLabel.trim().slice(0,40), quantity: ri.quantity, photo: ri.photo, reason: [ri.reason, ri.lateReportNote].filter(Boolean).join(' · '), reportedById: user.userId } })
            continue
          }
          if (!ri.orderLineId) throw new OrderReturnInputError(`商品「${ri.productName}」缺少原订单行信息`)
          const sourceItem = restaurant.items.find(item => item.orderLineId === ri.orderLineId && item.productId === ri.productId)
          const historicalOrder = ri.returnKind === 'HISTORICAL' && ri.orderId ? await tx.order.findFirst({ where: { id: ri.orderId, restaurantId }, select: { id: true } }) : null
          const orderId = ri.returnKind === 'HISTORICAL' ? historicalOrder?.id : sourceItem?.orderId && restaurant.orderIds.includes(sourceItem.orderId) ? sourceItem.orderId : undefined
          if (!orderId) throw new OrderReturnInputError(`商品「${ri.productName}」不属于当前客户订单`, 404)
          created.push(await createOrderReturn(tx, {
            orderId,
            returnKind: ri.returnKind,
            orderLineId: ri.orderLineId,
            quantity: ri.quantity,
            reason: ri.reason,
            actionType: ri.actionType,
            photo: ri.photo,
            lateReportNote: ri.lateReportNote,
            actualReturnedProductName: ri.actualReturnedProductName,
            actualReturnedProductId: ri.actualReturnedProductId,
            sourceTripId: id,
          }, user))
        }
        return created
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'trip', resourceId: id,
        detail: `退货提交: ${restaurant.restaurantName} — ${returnItems.length}项`,
      })

      return NextResponse.json(serializeApi({
        message: `已提交 ${returnItems.length} 项退货（无原单历史货物进入仓库待匹配）`,
        restaurantId,
        restaurantName: restaurant.restaurantName,
        returns: newReturns.map(ret => ({
          ...ret,
          quantity: Number(ret.quantity),
          unitPrice: ret.unitPrice == null ? undefined : Number(ret.unitPrice),
          orderLineId: ret.orderLineId,
          status: ret.status,
        })),
      }))
    } catch (error) {
      if (error instanceof OrderReturnInputError) return NextResponse.json({ error: error.message }, { status: error.status })
      console.error('[POST /api/trips/[id]/returns]', error)
      return apiRouteErrorResponse(error, '提交退货失败')
    }
    // 司机上报 ≠ 销售/运营审核（PUT 那个 dispatch.trip.returns）——司机不能自己批准自己报的退货
  }, { require: ['dispatch.trip.report_return', 'dispatch.trip.returns'] })
}

/** Sales decision for canonical trip returns. Approval only submits a Finance request;
 * approvedQuantity enables partial approval. Stock/quantity/CN effects occur at Finance.
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
          approvedQuantity?: number
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
      const trip = await prisma.trip.findUnique({ where: { id } })
      if (!trip) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }

      const reviewIds = reviews.map(r => r.returnId).filter((value): value is string => Boolean(value))
      const canonicalRows = reviewIds.length === reviews.length
        ? await prisma.orderReturn.findMany({ where: { id: { in: reviewIds }, sourceTripId: id } })
        : []
      if (canonicalRows.length > 0) {
        if (canonicalRows.length !== reviews.length || new Set(reviewIds).size !== reviews.length) return NextResponse.json({ error: '退货记录重复或已过期' }, { status: 409 })
        const result = await prisma.$transaction(async tx => {
          await lockReturnOrders(tx, canonicalRows.map(row => row.orderId))
          const results = []
          for (const review of [...reviews].sort((a, b) => String(a.returnId).localeCompare(String(b.returnId)))) {
            const ret = canonicalRows.find(row => row.id === review.returnId)!
            results.push(await reviewOrderReturn(tx, ret.id, { action: review.action, approvedQuantity: review.approvedQuantity, note: review.refundNote, exchangeOrderId: review.exchangeOrderId }, user))
          }
          return results
        })
        return NextResponse.json(serializeApi({ message: '已提交销售审核结果，批准项待会计确认', creditNoteRequests: result.flatMap(row => row.creditNoteRequests) }))
      }
      // Historical JSON has no exact source-line identity. Do not guess and move stock.
      return NextResponse.json({ error: '旧退货记录缺少原订单行，请在退货登记中核对原单后登记；禁止按商品名猜测入账' }, { status: 409 })
    } catch (error) {
      if ((error as { status?: number }).status) return NextResponse.json({ error: (error as Error).message }, { status: (error as { status: number }).status })
      console.error('[PUT /api/trips/[id]/returns]', error)
      return apiRouteErrorResponse(error, '退货审核失败')
    }
  }, { require: 'dispatch.trip.returns' })
}
