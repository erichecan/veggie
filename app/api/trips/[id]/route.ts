import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog, diffChanges } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { createDraftInvoiceForOrder } from '@/lib/invoice-from-order'

const TRIP_TRACKED_FIELDS = [
  'name', 'status', 'driverId', 'driverName', 'departTime', 'timeSlot',
  'totalPayment', 'driverCommission', 'waveId',
]

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
  })
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
  })
}
