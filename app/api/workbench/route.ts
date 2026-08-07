import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'

interface TripReturn { status?: string }
interface TripRestaurant { returns?: TripReturn[] }

/**
 * GET /api/workbench?date=YYYY-MM-DD
 *
 * 运营「今日工作台」聚合计数。date 为客户端本地日历日,
 * 用于波次匹配(波次 waveDate 约定为 new Date(date+'T00:00:00Z'))。
 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const dateStr = searchParams.get('date')
      const waveDate = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
        ? new Date(dateStr + 'T00:00:00Z')
        : null

      const [
        pendingQuotations,
        confirmedTotal,
        todayWaves,
        inDelivery,
        uninvoicedRows,
        trips,
        lowStock,
      ] = await Promise.all([
        prisma.order.count({ where: { status: 'PENDING' } }),
        prisma.order.count({ where: { status: 'CONFIRMED' } }),
        waveDate
          ? prisma.pickingWave.findMany({ where: { waveDate }, select: { orderIds: true } })
          : Promise.resolve([] as { orderIds: string[] }[]),
        prisma.order.count({ where: { status: 'IN_DELIVERY' } }),
        prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM "Order"
          WHERE status = 'COMPLETED'
            AND id NOT IN (
              SELECT unnest("saleOrderIds") FROM "Invoice" WHERE status <> 'CANCELLED'
            )`,
        prisma.trip.findMany({
          where: { status: { in: ['IN_PROGRESS', 'COMPLETED'] } },
          select: { restaurants: true },
          orderBy: { createdAt: 'desc' },
          take: 300,
        }),
        prisma.product.count({ where: { active: true, qtyOnHand: { lt: 20 } } }),
      ])

      const assignedIds = [...new Set(todayWaves.flatMap(w => w.orderIds))]
      const assignedConfirmed = assignedIds.length > 0
        ? await prisma.order.count({ where: { status: 'CONFIRMED', id: { in: assignedIds } } })
        : 0
      const unassignedConfirmed = Math.max(0, confirmedTotal - assignedConfirmed)

      let pendingReturns = 0
      for (const t of trips) {
        const rests = (t.restaurants as unknown as TripRestaurant[]) ?? []
        for (const r of rests) {
          for (const ret of r.returns ?? []) {
            if ((ret.status ?? '').toUpperCase() === 'PENDING_REVIEW') pendingReturns++
          }
        }
      }

      return NextResponse.json({
        pendingQuotations,
        unassignedConfirmed,
        inDelivery,
        uninvoicedCompleted: uninvoicedRows[0]?.n ?? 0,
        pendingReturns,
        lowStock,
      })
    } catch (error) {
      console.error('[GET /api/workbench]', error)
      return NextResponse.json({ error: '获取工作台数据失败' }, { status: 500 })
    }
  }, { require: 'sales.workbench.read' })
}
