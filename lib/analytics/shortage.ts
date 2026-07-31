/**
 * 缺货率计算 · 共享实现
 * ============================================================================
 * 被 /api/analytics/shortage 和 /api/analytics/sales-overview 两个路由共用，
 * 避免各自维护一份公式后续跑偏。口径：物流口径（deliveryDate），
 * 缺货行 = OrderDiscrepancy 非 CANCELLED 行数，订单行 = SALES_COUNTED_STATUSES 内订单行数。
 */
import { prisma } from '@/lib/db'
import { SALES_COUNTED_STATUSES } from '@/lib/analytics/metrics'

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

export interface ShortageDailyRow {
  day: Date
  shortage_lines: number
  order_lines: number
}

export interface ShortageSummary {
  shortageLines: number
  orderLines: number
  shortageRate: number
}

/** 按天缺货行数 / 订单行数，[start, end) 半开区间。 */
export async function computeShortageDaily(start: Date, end: Date): Promise<ShortageDailyRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  return (await p.$queryRawUnsafe(
    `WITH days AS (
       SELECT generate_series($1::date, ($2::date - INTERVAL '1 day')::date, '1 day')::date AS d
     ),
     short AS (
       SELECT o."deliveryDate"::date AS d, COUNT(*)::int AS cnt
       FROM "OrderDiscrepancy" dc
       JOIN "Order" o ON o.id = dc."orderId"
       WHERE o."deliveryDate" >= $1 AND o."deliveryDate" < $2 AND dc.status <> 'CANCELLED'
       GROUP BY o."deliveryDate"::date
     ),
     lines AS (
       SELECT o."deliveryDate"::date AS d, COUNT(*)::int AS cnt
       FROM "OrderLine" ol
       JOIN "Order" o ON o.id = ol."orderId"
       WHERE o."deliveryDate" >= $1 AND o."deliveryDate" < $2
         AND o.status::text IN (${SALES_STATUS_SQL})
       GROUP BY o."deliveryDate"::date
     )
     SELECT days.d AS day,
            COALESCE(short.cnt, 0) AS shortage_lines,
            COALESCE(lines.cnt, 0) AS order_lines
     FROM days
     LEFT JOIN short ON short.d = days.d
     LEFT JOIN lines ON lines.d = days.d
     ORDER BY days.d`,
    start, end,
  )) as ShortageDailyRow[]
}

/** 纯函数：把按天序列汇总成缺货率。不查库，可单测。 */
export function summarizeShortageDaily(daily: ShortageDailyRow[]): ShortageSummary {
  const shortageLines = daily.reduce((s, d) => s + d.shortage_lines, 0)
  const orderLines = daily.reduce((s, d) => s + d.order_lines, 0)
  return {
    shortageLines,
    orderLines,
    shortageRate: orderLines > 0 ? Math.round((shortageLines / orderLines) * 10000) / 10000 : 0,
  }
}
