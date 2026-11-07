import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'
import { driverRowScope } from '@/lib/row-scope'
import { completeDeliveredOrders, describeFailures } from '@/lib/delivery-complete'
import { decodedPngBytes, MAX_SIGNATURE_BYTES } from '@/lib/trip-signature'
import { orderIncTaxTotal } from '@/lib/order-items'
import { calculateReturnAdjustment } from '@/lib/trip-collection'
import type { TripRestaurant } from '@/lib/types'

type OrderTiming = { startedAt?: string; endedAt?: string }
type RestaurantWithOrderTiming = TripRestaurant & { orderTimings?: Record<string, OrderTiming> }

/** Server-stamped, serialized start/end transitions for one sales order in a driver trip. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async user => {
    try {
      const body = await req.json() as { orderId?: string; action?: 'start' | 'end' }
      if (!body.orderId || (body.action !== 'start' && body.action !== 'end')) {
        return NextResponse.json({ error: '请选择订单和开始/结束操作' }, { status: 400 })
      }
      const orderId = body.orderId
      const action = body.action

      const result = await prisma.$transaction(async (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => {
        // Serialize competing start requests: one trip can have only one active order at a time.
        await tx.$queryRaw`SELECT id FROM "Trip" WHERE id = ${id} FOR UPDATE`
        const trip = await tx.trip.findUnique({ where: { id } })
        if (!trip) return { error: '行程不存在', status: 404 as const }
        const scope = driverRowScope(user)
        if (scope && trip.driverId !== scope.userId) return { error: '行程不存在', status: 404 as const }
        if (String(trip.status).toUpperCase() !== 'IN_PROGRESS' || !trip.departTime) {
          return { error: '请先在行程详情页确认出发，再开始订单计时', status: 409 as const }
        }

        const restaurants = trip.restaurants as unknown as RestaurantWithOrderTiming[]
        const owner = restaurants.find(r => (r.orderIds ?? []).includes(orderId))
        if (!owner) return { error: '该订单不属于此行程', status: 404 as const }
        const legacyReturns = owner.returns ?? []
        const canonicalReturns = await tx.orderReturn.findMany({
          where: { sourceTripId: id, orderId },
          orderBy: { createdAt: 'asc' },
        })
        owner.returns = [
          ...(owner.returns ?? []),
          ...canonicalReturns.map(ret => ({
            id: ret.id,
            orderId: ret.orderId,
            orderLineId: ret.orderLineId ?? undefined,
            productId: ret.productId,
            productName: ret.productName,
            quantity: Number(ret.quantity),
            unitPrice: ret.unitPrice == null ? undefined : Number(ret.unitPrice),
            refundAmount: ret.refundAmount == null ? undefined : Number(ret.refundAmount),
            status: ret.status,
          })),
        ]

        const timings: Record<string, OrderTiming> = { ...(owner.orderTimings ?? {}) }
        const current: OrderTiming = timings[orderId] ?? {}
        const activeOrderId = restaurants.flatMap(r =>
          Object.entries(r.orderTimings ?? {}).map(([orderId, timing]) =>
            timing.startedAt && !timing.endedAt ? orderId : null,
          ),
        ).find(Boolean)

        if (action === 'start') {
          if (current.startedAt || current.endedAt) {
            return { error: '该订单已经开始或结束，不能重复计时', status: 409 as const }
          }
          if (activeOrderId) return { error: '请先结束当前订单，再开始下一个订单', status: 409 as const }
          // Start Order 时自动带出应收金额。只填尚未设置的金额，保留司机已录入的值（包括 0），
          // 并按司机端展示口径扣除已申报退货，避免开始计时后仍需要手动补填。
          if (typeof owner.payment !== 'number' || !Number.isFinite(owner.payment) || owner.payment < 0) {
            const grossDueIncTax = orderIncTaxTotal(owner.items)
            const returnAdjustment = calculateReturnAdjustment(owner.items, owner.returns ?? [])
            owner.payment = Math.max(0, Math.round((grossDueIncTax - returnAdjustment.incTax) * 100) / 100)
          }
          timings[orderId] = { startedAt: new Date().toISOString() }
        } else {
          if (!current.startedAt || current.endedAt) {
            return { error: '该订单尚未开始，或已经结束', status: 409 as const }
          }
          const signatureBytes = owner.signature ? decodedPngBytes(owner.signature) : null
          if (
            !owner.delivered ||
            signatureBytes === null ||
            signatureBytes > MAX_SIGNATURE_BYTES ||
            !owner.signerName?.trim() ||
            !owner.signedAt
          ) {
            return { error: '请先完成顾客签名，再结束订单', status: 409 as const }
          }
          if (typeof owner.payment !== 'number' || !Number.isFinite(owner.payment) || owner.payment < 0) {
            return {
              error: '请先输入并保存实收金额（可以填写 0）再结束订单',
              status: 409 as const,
            }
          }
          timings[orderId] = { ...current, endedAt: new Date().toISOString() }
        }

        owner.orderTimings = timings
        owner.returns = legacyReturns
        const updated = await tx.trip.update({
          where: { id },
          data: { restaurants: restaurants as never },
        })
        return { trip: updated }
      })

      if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
      const restaurants = result.trip.restaurants as unknown as RestaurantWithOrderTiming[]
      const orderIds = [...new Set(restaurants.flatMap(r => r.orderIds ?? []))]
      let completionDetail = ''
      if (action === 'end') {
        const completion = await completeDeliveredOrders([orderId], {
          reason: '司机完成单个订单配送',
          userId: user.userId,
          createdBy: user.name ?? user.email,
        })
        if (completion.completedIds.includes(orderId)) {
          completionDetail = '；销售订单状态已更新为配送完成'
        }
        if (completion.failures.length > 0) {
          console.error('[order timing: delivery complete]', orderId, describeFailures(completion.failures))
        }
      }
      const orders = orderIds.length > 0
        ? await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, code: true } })
        : []
      const orderCodeById = new Map((orders as Array<{ id: string; code: string | null }>).map(order => [order.id, order.code ?? order.id.slice(-8).toUpperCase()]))
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'trip', resourceId: id,
        detail: `${action === 'start' ? '开始' : '结束'}订单计时: ${orderId}${completionDetail}`,
      })
      return NextResponse.json(serializeApi({
        ...result.trip,
        restaurants: restaurants.map(r => ({
          ...r,
          orderCodes: (r.orderIds ?? []).map(orderId => orderCodeById.get(orderId) ?? orderId.slice(-8).toUpperCase()),
        })),
      }))
    } catch (error) {
      console.error('[POST /api/trips/[id]/order-timing]', error)
      return NextResponse.json({ error: '更新订单计时失败' }, { status: 500 })
    }
  }, { require: 'dispatch.trip.update' })
}
