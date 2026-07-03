import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import {
  SALES_COUNTED_STATUSES, CHURN_QUIET_DAYS, CHURN_LOOKBACK_DAYS, CHURN_MIN_PRIOR_ORDERS,
  resolveDateRange,
} from '@/lib/analytics/metrics'

/**
 * /api/analytics/customers — 客户分析
 * ============================================================================
 * GET ?from&to
 * 返回：
 *   summary  活跃客户数 / 新客户数（首单在期内）/ 期内销售额
 *   abc      期内每客户聚合（销售额、单数、客单价、最后下单日）+ ABC 分层
 *            （按销售额降序累计：≤80% = A，≤95% = B，其余 C）
 *   churn    流失预警全量名单（口径同 overview）
 */

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const rows = (await p.$queryRawUnsafe(
        `SELECT o."restaurantId" AS customer_id,
                MAX(o."restaurantName") AS customer_name,
                COUNT(*)::int AS order_count,
                SUM(o."totalAmount")::float AS sales_ex,
                MAX(o."confirmationDate") AS last_order_at,
                MIN(o."confirmationDate") AS first_order_in_range
         FROM "Order" o
         WHERE o.status::text IN (${SALES_STATUS_SQL})
           AND o."confirmationDate" >= $1 AND o."confirmationDate" < $2
         GROUP BY o."restaurantId"
         ORDER BY SUM(o."totalAmount") DESC`,
        start, end,
      )) as Array<{
        customer_id: string; customer_name: string; order_count: number
        sales_ex: number; last_order_at: Date; first_order_in_range: Date
      }>

      // 新客户：期内首单即历史首单
      const newCustomers = (await p.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS cnt FROM (
           SELECT o."restaurantId"
           FROM "Order" o
           WHERE o.status::text IN (${SALES_STATUS_SQL}) AND o."confirmationDate" IS NOT NULL
           GROUP BY o."restaurantId"
           HAVING MIN(o."confirmationDate") >= $1 AND MIN(o."confirmationDate") < $2
         ) t`,
        start, end,
      )) as Array<{ cnt: number }>

      const totalSales = rows.reduce((s, r) => s + r.sales_ex, 0)
      let cum = 0
      const abc = rows.map((r, i) => {
        cum += r.sales_ex
        const cumPct = totalSales > 0 ? cum / totalSales : 1
        return {
          rank: i + 1,
          customerId: r.customer_id,
          customerName: r.customer_name,
          orderCount: r.order_count,
          salesExTax: Math.round(r.sales_ex * 100) / 100,
          avgOrder: r.order_count > 0 ? Math.round((r.sales_ex / r.order_count) * 100) / 100 : 0,
          lastOrderAt: r.last_order_at,
          klass: cumPct <= 0.8 ? 'A' : cumPct <= 0.95 ? 'B' : 'C',
        }
      })

      // 流失预警（口径同 overview，全量）
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const churn = (await p.$queryRawUnsafe(
        `WITH prior AS (
           SELECT o."restaurantId" AS customer_id,
                  MAX(o."restaurantName") AS customer_name,
                  COUNT(*)::int AS prior_orders,
                  SUM(o."totalAmount")::float AS prior_amount,
                  MAX(o."confirmationDate") AS last_order_at
           FROM "Order" o
           WHERE o.status::text IN (${SALES_STATUS_SQL})
             AND o."confirmationDate" >= $1 AND o."confirmationDate" < $2
           GROUP BY o."restaurantId"
           HAVING COUNT(*) >= $3
         ),
         recent AS (
           SELECT DISTINCT o."restaurantId" AS customer_id
           FROM "Order" o
           WHERE o.status::text IN (${SALES_STATUS_SQL})
             AND o."confirmationDate" >= $2
         )
         SELECT pr.customer_id, pr.customer_name, pr.prior_orders, pr.prior_amount, pr.last_order_at
         FROM prior pr
         LEFT JOIN recent r ON r.customer_id = pr.customer_id
         WHERE r.customer_id IS NULL
         ORDER BY pr.prior_amount DESC`,
        new Date(today.getTime() - CHURN_LOOKBACK_DAYS * 86400000),
        new Date(today.getTime() - CHURN_QUIET_DAYS * 86400000),
        CHURN_MIN_PRIOR_ORDERS,
      )) as Array<{ customer_id: string; customer_name: string; prior_orders: number; prior_amount: number; last_order_at: Date }>

      return NextResponse.json(serializeApi({
        summary: {
          activeCustomers: rows.length,
          newCustomers: newCustomers[0].cnt,
          salesExTax: Math.round(totalSales * 100) / 100,
          churnCount: churn.length,
        },
        abc,
        churn,
      }))
    } catch (error) {
      console.error('[GET /api/analytics/customers]', error)
      return NextResponse.json({ error: '获取客户分析失败' }, { status: 500 })
    }
  }, ['BOSS', 'OPERATOR', 'FINANCE'])
}
