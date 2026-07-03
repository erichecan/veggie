import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { resolveDateRange } from '@/lib/analytics/metrics'

/**
 * /api/analytics/internal-control — 内控审计
 * ============================================================================
 * GET ?from&to
 * 返回：
 *   priceChanges   OrderAuditLog action='updated' 且 totalBefore≠totalAfter 的明细
 *                  （按降价幅度排序，降价 = 潜在异常折扣）
 *   byOperator     按操作员：改单次数、降价次数、降价总额
 *   timeliness     按创建人：报价→确认平均耗时（小时），仅统计已确认订单
 */

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const priceChangeRows = (await p.$queryRawUnsafe(
        `SELECT al.id, al."orderId" AS order_id, o.code AS order_code,
                COALESCE(u.name, al."userId") AS operator,
                al."totalBefore"::float AS total_before,
                al."totalAfter"::float AS total_after,
                (al."totalAfter" - al."totalBefore")::float AS delta,
                al."createdAt" AS changed_at
         FROM "OrderAuditLog" al
         LEFT JOIN "Order" o ON o.id = al."orderId"
         LEFT JOIN "User" u ON u.id = al."userId"
         WHERE al.action = 'updated'
           AND al."totalBefore" IS NOT NULL AND al."totalAfter" IS NOT NULL
           AND al."totalBefore" <> al."totalAfter"
           AND al."createdAt" >= $1 AND al."createdAt" < $2
         ORDER BY (al."totalAfter" - al."totalBefore") ASC
         LIMIT 100`,
        start, end,
      )) as Array<{
        id: string; order_id: string; order_code: string | null; operator: string
        total_before: number; total_after: number; delta: number; changed_at: Date
      }>

      const byOperator = (await p.$queryRawUnsafe(
        `SELECT COALESCE(u.name, al."userId") AS operator,
                COUNT(*)::int AS change_count,
                COUNT(*) FILTER (WHERE al."totalAfter" < al."totalBefore")::int AS decrease_count,
                COALESCE(SUM(CASE WHEN al."totalAfter" < al."totalBefore"
                  THEN al."totalBefore" - al."totalAfter" ELSE 0 END), 0)::float AS decrease_amount
         FROM "OrderAuditLog" al
         LEFT JOIN "User" u ON u.id = al."userId"
         WHERE al.action = 'updated'
           AND al."totalBefore" IS NOT NULL AND al."totalAfter" IS NOT NULL
           AND al."totalBefore" <> al."totalAfter"
           AND al."createdAt" >= $1 AND al."createdAt" < $2
         GROUP BY COALESCE(u.name, al."userId")
         ORDER BY decrease_amount DESC`,
        start, end,
      )) as Array<{ operator: string; change_count: number; decrease_count: number; decrease_amount: number }>

      const timeliness = (await p.$queryRawUnsafe(
        `SELECT COALESCE(o."createdByName", '未知') AS creator,
                COUNT(*)::int AS order_count,
                AVG(EXTRACT(EPOCH FROM (o."confirmationDate" - o."createdAt")) / 3600)::float AS avg_hours
         FROM "Order" o
         WHERE o."confirmationDate" IS NOT NULL
           AND o."createdAt" >= $1 AND o."createdAt" < $2
         GROUP BY o."createdByName"
         ORDER BY avg_hours DESC`,
        start, end,
      )) as Array<{ creator: string; order_count: number; avg_hours: number }>

      const round2 = (n: number) => Math.round(n * 100) / 100
      return NextResponse.json(serializeApi({
        priceChanges: priceChangeRows.map((r) => ({
          id: r.id, orderId: r.order_id, orderCode: r.order_code, operator: r.operator,
          totalBefore: round2(r.total_before), totalAfter: round2(r.total_after),
          delta: round2(r.delta), changedAt: r.changed_at,
        })),
        byOperator: byOperator.map((r) => ({
          operator: r.operator, changeCount: r.change_count,
          decreaseCount: r.decrease_count, decreaseAmount: round2(r.decrease_amount),
        })),
        timeliness: timeliness.map((r) => ({
          creator: r.creator, orderCount: r.order_count,
          avgHours: r.avg_hours === null ? null : round2(r.avg_hours),
        })),
      }))
    } catch (error) {
      console.error('[GET /api/analytics/internal-control]', error)
      return NextResponse.json({ error: '获取内控审计失败' }, { status: 500 })
    }
  }, ['BOSS', 'FINANCE', 'OPERATOR']) // TODO: 临时放开给 OPERATOR 看数据分析中心，权限模型定下来后收紧
}
