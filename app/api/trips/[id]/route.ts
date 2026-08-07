import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog, diffChanges } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { createDraftInvoiceForOrder } from '@/lib/invoice-from-order'
import { recalcOrderCommission, recalcTripDriverCommission } from '@/lib/commission'
import { reconcileSignatures, describeIssues } from '@/lib/trip-signature'

const TRIP_TRACKED_FIELDS = [
  'name', 'status', 'driverId', 'driverName', 'departTime', 'timeSlot',
  'totalPayment', 'driverCommission', 'waveId',
]

const DECIDED_RETURN_STATUSES = new Set(['APPROVED', 'REJECTED', 'SETTLED'])

type RestaurantJson = { restaurantId: string; returns?: Array<{ productId: string; createdAt?: string; status?: string }> }

/**
 * 退货审核必须走专用的 PUT /api/trips/:id/returns（有状态机守卫 + 库存联动），
 * 不能通过这个通用路由直接改 restaurants[].returns[].status——此前 operator/returns
 * 页面就是绕这条路直接改状态，导致审批通过但库存/OrderLine/提成全部没有联动。
 * 只拦截"状态真的发生了变化，且新状态是已决状态"的情形，其余字段(name/driverId等)照常放行。
 */
function findBlockedReturnStatusChange(
  before: unknown,
  incoming: unknown,
): { restaurantId: string; productId: string; from?: string; to?: string } | null {
  if (!Array.isArray(incoming)) return null
  const beforeStatusByKey = new Map<string, string | undefined>()
  if (Array.isArray(before)) {
    for (const r of before as RestaurantJson[]) {
      for (const ret of r.returns ?? []) {
        beforeStatusByKey.set(`${r.restaurantId}::${ret.productId}::${ret.createdAt ?? ''}`, ret.status)
      }
    }
  }
  for (const r of incoming as RestaurantJson[]) {
    for (const ret of r.returns ?? []) {
      const key = `${r.restaurantId}::${ret.productId}::${ret.createdAt ?? ''}`
      const prevStatus = beforeStatusByKey.get(key)
      if (ret.status !== prevStatus && DECIDED_RETURN_STATUSES.has(String(ret.status))) {
        return { restaurantId: r.restaurantId, productId: ret.productId, from: prevStatus, to: ret.status }
      }
    }
  }
  return null
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const trip = await prisma.trip.findUnique({ where: { id } })
    if (!trip) return NextResponse.json({ error: '行程不存在' }, { status: 404 })
    return NextResponse.json(serializeApi(trip))
  } catch (error) {
    console.error('[GET /api/trips/[id]]', error)
    return NextResponse.json({ error: '获取行程失败' }, { status: 500 })
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const before = await prisma.trip.findUnique({ where: { id } })
      if (!before) return NextResponse.json({ error: '行程不存在' }, { status: 404 })

      const blocked = findBlockedReturnStatusChange(before.restaurants, data.restaurants)
      if (blocked) {
        return NextResponse.json(
          { error: `退货审核请使用「审核退货」功能（走 /api/trips/${id}/returns），不能直接修改行程数据` },
          { status: 409 },
        )
      }

      // 电子签收完整性：时间戳服务端打、已签名不可改、体积与格式受限
      // （签名是收货凭证，客户端时钟与整包 PUT 都不能信）
      if (data.restaurants !== undefined) {
        const { restaurants, issues } = reconcileSignatures(before.restaurants, data.restaurants, new Date())
        const immutable = issues.filter(i => i.kind === 'immutable')
        if (immutable.length > 0) {
          return NextResponse.json({ error: describeIssues(immutable) }, { status: 409 })
        }
        if (issues.length > 0) {
          return NextResponse.json({ error: describeIssues(issues) }, { status: 400 })
        }
        data.restaurants = restaurants
      }

      const newStatus = data.status?.toUpperCase()
      const trip = await prisma.trip.update({
        where: { id },
        data: {
          ...data,
          status: newStatus ?? undefined,
        },
      })

      // ─ Trip → Order 回写：状态变为 COMPLETED 时，自动把订单各 line 的 deliveredQty
      //   置为 orderedQty（方案 C 默认全送，可后续手动覆盖）。
      if (newStatus === 'COMPLETED' && String(before.status) !== 'COMPLETED') {
        const restaurants = Array.isArray(before.restaurants)
          ? (before.restaurants as Array<{ orderIds?: string[] }>)
          : []
        const orderIds = restaurants.flatMap(r => r.orderIds ?? [])
        if (orderIds.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const prismaAny = prisma as any
          // 把所有相关 OrderLine.deliveredQty 设为 orderedQty
          // 用原生 SQL 一次完成（updateMany 不支持字段赋值给字段）
          await prismaAny.$executeRawUnsafe(
            `UPDATE "OrderLine" SET "deliveredQty" = "orderedQty", "updatedAt" = NOW() WHERE "orderId" IN (${orderIds.map((_, i) => `$${i + 1}`).join(',')})`,
            ...orderIds,
          )
          // 同时把订单状态推进到 COMPLETED（行程完成即代表已交货）
          await prismaAny.order.updateMany({
            where: { id: { in: orderIds }, status: { in: ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY'] } },
            data: { status: 'COMPLETED' },
          }).catch((e: unknown) => console.error('[trip→order status]', e))
          // 完成即自动生成 DRAFT 发票(幂等),供 finance 应收口径用
          for (const oid of orderIds) {
            await createDraftInvoiceForOrder(prismaAny, oid).catch((e: unknown) => console.error('[auto draft invoice]', e))
          }
          // 送达冻结司机提成快照（deliveredQty 刚落到 orderedQty，status 已 COMPLETED）
          for (const oid of orderIds) {
            await recalcOrderCommission(oid, prisma).catch((e: unknown) => console.error('[commission freeze]', e))
          }
          await recalcTripDriverCommission(id, prisma).catch((e: unknown) => console.error('[trip commission sync]', e))
        }
      }

      const changes = diffChanges(
        before as unknown as Record<string, unknown>,
        trip as unknown as Record<string, unknown>,
        TRIP_TRACKED_FIELDS,
      )
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'trip', resourceId: id,
        detail: `更新行程: ${id}`,
        changes: Object.keys(changes).length > 0 ? changes : undefined })
      return NextResponse.json(serializeApi(trip))
    } catch (error) {
      console.error('[PUT /api/trips/[id]]', error)
      return NextResponse.json({ error: '更新行程失败' }, { status: 500 })
    }
  }, { require: 'dispatch.trip.update' })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      await prisma.trip.delete({ where: { id } })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'trip', resourceId: id,
        detail: `删除行程: ${id}` })
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/trips/[id]]', error)
      return NextResponse.json({ error: '删除行程失败' }, { status: 500 })
    }
  }, { require: 'dispatch.trip.delete' })
}
