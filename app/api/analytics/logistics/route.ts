import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { resolveDateRange } from '@/lib/analytics/metrics'
import { withCachedAuth } from '@/lib/analytics/cache'

/**
 * /api/analytics/logistics — 物流分析
 * ============================================================================
 * GET ?from&to
 * 数据源：Trip（司机日装载 + 交账差异，与 /api/trips/[id]/settlement 同口径：
 *          difference = cashCollected+onlineCollected − totalPayment）；
 *         PickingWave（出发时间记录，dispatchedAt 由「确认出发」回填）。
 * 日期口径：Trip 无自身业务日期字段，取所属 PickingWave.waveDate，
 *          无关联波次（手动建的 Trip）退回 Trip.createdAt::date。
 */

export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const byDriver = (await p.$queryRawUnsafe(
        `SELECT COALESCE(t."driverName", '未指定') AS driver,
                COUNT(*)::int AS trip_count,
                SUM(COALESCE(jsonb_array_length(t.restaurants), 0))::int AS stop_count,
                SUM(t."totalPayment")::float AS total_payment,
                SUM(COALESCE(t."cashCollected", 0) + COALESCE(t."onlineCollected", 0))::float AS total_collected,
                SUM(COALESCE(t."cashCollected", 0) + COALESCE(t."onlineCollected", 0) - t."totalPayment")::float AS difference,
                COUNT(*) FILTER (WHERE t."settlementStatus" = 'confirmed')::int AS settled_count
         FROM "Trip" t
         LEFT JOIN "PickingWave" w ON w.id = t."waveId"
         WHERE COALESCE(w."waveDate", t."createdAt"::date) >= $1
           AND COALESCE(w."waveDate", t."createdAt"::date) < $2
         GROUP BY t."driverName"
         ORDER BY SUM(t."totalPayment") DESC`,
        start, end,
      )) as Array<{
        driver: string; trip_count: number; stop_count: number
        total_payment: number; total_collected: number; difference: number; settled_count: number
      }>

      const daily = (await p.$queryRawUnsafe(
        `SELECT COALESCE(w."waveDate", t."createdAt"::date) AS day,
                COUNT(*)::int AS trip_count,
                SUM(COALESCE(jsonb_array_length(t.restaurants), 0))::int AS stop_count,
                SUM(t."totalPayment")::float AS total_payment
         FROM "Trip" t
         LEFT JOIN "PickingWave" w ON w.id = t."waveId"
         WHERE COALESCE(w."waveDate", t."createdAt"::date) >= $1
           AND COALESCE(w."waveDate", t."createdAt"::date) < $2
         GROUP BY COALESCE(w."waveDate", t."createdAt"::date)
         ORDER BY day`,
        start, end,
      )) as Array<{ day: Date; trip_count: number; stop_count: number; total_payment: number }>

      const dispatchLog = (await p.$queryRawUnsafe(
        `SELECT w."waveDate" AS day, w."waveType" AS wave_type, w."driverName" AS driver,
                COALESCE(array_length(w."orderIds", 1), 0)::int AS order_count,
                w."dispatchedAt" AS dispatched_at
         FROM "PickingWave" w
         WHERE w."waveDate" >= $1 AND w."waveDate" < $2 AND w."dispatchedAt" IS NOT NULL
         ORDER BY w."dispatchedAt" DESC
         LIMIT 100`,
        start, end,
      )) as Array<{ day: Date; wave_type: string | null; driver: string | null; order_count: number; dispatched_at: Date }>

      const round2 = (n: number) => Math.round(n * 100) / 100
      return NextResponse.json(serializeApi({
        byDriver: byDriver.map((d) => ({
          driver: d.driver,
          tripCount: d.trip_count,
          stopCount: d.stop_count,
          totalPayment: round2(d.total_payment),
          amountPerStop: d.stop_count > 0 ? round2(d.total_payment / d.stop_count) : 0,
          totalCollected: round2(d.total_collected),
          difference: round2(d.difference),
          settledCount: d.settled_count,
        })),
        daily,
        dispatchLog,
      }))
    } catch (error) {
      console.error('[GET /api/analytics/logistics]', error)
      return NextResponse.json({ error: '获取物流分析失败' }, { status: 500 })
    }
  }, ['BOSS', 'OPERATOR', 'FINANCE'])
}
