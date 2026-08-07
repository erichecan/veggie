import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { computeDayMetrics, ensureSnapshots } from '@/lib/analytics/snapshot'
import {
  SALES_COUNTED_STATUSES, CHURN_QUIET_DAYS, CHURN_LOOKBACK_DAYS, CHURN_MIN_PRIOR_ORDERS,
  toDayKey,
} from '@/lib/analytics/metrics'
import { withCachedAuth } from '@/lib/analytics/cache'

/**
 * /api/analytics/overview — 老板日报一屏
 * ============================================================================
 * 返回：昨日快照 + 今日实时 + 今日运营（待配送/波次/缺货待处理）+ 红灯区 + 应收摘要。
 * 30 天趋势由前端另行调 /api/analytics/snapshots。
 */

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const tomorrow = new Date(today)
      tomorrow.setDate(tomorrow.getDate() + 1)
      const yesterday = new Date(today)
      yesterday.setDate(yesterday.getDate() - 1)

      await ensureSnapshots()

      const [yesterdaySnap, todayMetrics] = await Promise.all([
        p.dailyBusinessSnapshot.findUnique({ where: { snapshotDate: new Date(toDayKey(yesterday)) } }),
        computeDayMetrics(today),
      ])

      // ── 今日运营 ────────────────────────────────────────────────────────
      // 待配送：已确认/已排波次、今日应送或尚未安排交货日
      const toDeliver = (await p.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS cnt, COALESCE(SUM("totalAmount"), 0)::float AS amount
         FROM "Order"
         WHERE status::text IN ('CONFIRMED', 'WAVE_ASSIGNED')
           AND ("deliveryDate" IS NULL OR ("deliveryDate" >= $1 AND "deliveryDate" < $2))`,
        today, tomorrow,
      )) as Array<{ cnt: number; amount: number }>

      // 今日波次装载（按司机）
      const waves = (await p.$queryRawUnsafe(
        `SELECT w."driverName" AS driver, w."waveType" AS wave_type,
                COALESCE(array_length(w."orderIds", 1), 0)::int AS order_count,
                (w."dispatchedAt" IS NOT NULL) AS dispatched
         FROM "PickingWave" w
         WHERE w."waveDate" = $1::date
         ORDER BY w."waveNumber" NULLS LAST, w."driverName"`,
        toDayKey(today),
      )) as Array<{ driver: string | null; wave_type: string | null; order_count: number; dispatched: boolean }>

      // 缺货待处理
      const pendingShortage = (await p.orderDiscrepancy.count({ where: { status: 'PENDING' } })) as number

      // ── 红灯区 ──────────────────────────────────────────────────────────
      const negativeStock = (await p.$queryRawUnsafe(
        `SELECT p.id, p.name, p.spec, p."qtyOnHand"::float AS qty
         FROM "Product" p
         WHERE p.active = true AND p.status = 'ACTIVE' AND p."qtyOnHand" < 0
         ORDER BY p."qtyOnHand" ASC
         LIMIT 10`,
      )) as Array<{ id: string; name: string; spec: string | null; qty: number }>
      const negativeStockTotal = (await p.product.count({
        where: { active: true, status: 'ACTIVE', qtyOnHand: { lt: 0 } },
      })) as number

      const staleCutoff = new Date(today)
      staleCutoff.setDate(staleCutoff.getDate() - 3)
      const stalePending = (await p.$queryRawUnsafe(
        `SELECT id, code, "restaurantName" AS customer, "totalAmount"::float AS amount, "createdAt"
         FROM "Order"
         WHERE status = 'PENDING' AND "createdAt" < $1
         ORDER BY "createdAt" ASC
         LIMIT 10`,
        staleCutoff,
      )) as Array<{ id: string; code: string | null; customer: string; amount: number; createdAt: Date }>
      const stalePendingTotal = (await p.order.count({
        where: { status: 'PENDING', createdAt: { lt: staleCutoff } },
      })) as number

      // 流失预警 TOP：前 8~30 天 ≥N 单、近 7 天 0 单，按历史金额降序
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
         ORDER BY pr.prior_amount DESC
         LIMIT 10`,
        new Date(today.getTime() - CHURN_LOOKBACK_DAYS * 86400000),
        new Date(today.getTime() - CHURN_QUIET_DAYS * 86400000),
        CHURN_MIN_PRIOR_ORDERS,
      )) as Array<{ customer_id: string; customer_name: string; prior_orders: number; prior_amount: number; last_order_at: Date }>

      // ── 应收摘要 ────────────────────────────────────────────────────────
      const topDebtors = (await p.$queryRawUnsafe(
        `SELECT "customerId" AS customer_id, MAX("customerName") AS customer_name,
                SUM("amountDue")::float AS amount_due, COUNT(*)::int AS invoice_count
         FROM "Invoice"
         WHERE status = 'POSTED' AND "amountDue" > 0
         GROUP BY "customerId"
         ORDER BY SUM("amountDue") DESC
         LIMIT 5`,
      )) as Array<{ customer_id: string; customer_name: string; amount_due: number; invoice_count: number }>

      return NextResponse.json(serializeApi({
        yesterday: yesterdaySnap,
        today: todayMetrics,
        todayOps: {
          toDeliverCount: toDeliver[0].cnt,
          toDeliverAmount: toDeliver[0].amount,
          waves,
          pendingShortage,
        },
        redFlags: {
          negativeStock: { total: negativeStockTotal, items: negativeStock },
          stalePending: { total: stalePendingTotal, items: stalePending },
          churnRisk: churn,
        },
        ar: {
          balance: todayMetrics.arBalance,
          overdue: todayMetrics.arOverdue,
          topDebtors,
        },
      }))
    } catch (error) {
      console.error('[GET /api/analytics/overview]', error)
      return NextResponse.json({ error: '获取经营总览失败' }, { status: 500 })
    }
  }, { require: 'analytics.sales.read' })
}
