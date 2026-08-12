/**
 * 缺货率计算 · 共享实现
 * ============================================================================
 * 被 /api/analytics/shortage 和 /api/analytics/sales-overview 两个路由共用，
 * 避免各自维护一份公式后续跑偏。口径：物流口径（deliveryDate），
 * 缺货行 = OrderDiscrepancy 非 CANCELLED 行数，订单行 = SALES_COUNTED_STATUSES 内订单行数。
 */
import { prisma } from '@/lib/db'
import { SALES_COUNTED_STATUSES, addBusinessDays, deriveShortageRate, toDayKey } from '@/lib/analytics/metrics'

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

/**
 * 把 [start, end) 展开成业务日（都柏林）的日期字符串列表。
 *
 * ⛔ 不能让 SQL 去 `$1::date` 推这个列表：start 是「都柏林某日 00:00」对应的 UTC 时刻，
 * 夏令时期间它长得像「前一天 23:00」，`::date` 出来就是前一天 —— 于是整条按天序列
 * 整体偏一天。实测症状：查「今天」的缺货率，返回的是**昨天**那一行（订单行恒为 0）。
 * 日期口径只有一个来源：lib/analytics/metrics 的业务日函数。
 */
export function businessDayKeys(start: Date, end: Date): string[] {
  const keys: string[] = []
  for (let cur = start; cur < end; cur = addBusinessDays(cur, 1)) {
    keys.push(toDayKey(cur))
    if (keys.length > 400) break   // 与 ANALYTICS_MAX_RANGE_DAYS 同量级的护栏
  }
  return keys
}

/** 按天缺货行数 / 订单行数，[start, end) 半开区间。 */
export async function computeShortageDaily(start: Date, end: Date): Promise<ShortageDailyRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  const dayKeys = businessDayKeys(start, end)
  if (dayKeys.length === 0) return []
  return (await p.$queryRawUnsafe(
    `WITH days AS (
       SELECT unnest($3::date[]) AS d
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
    start, end, dayKeys,
  )) as ShortageDailyRow[]
}

/** 纯函数：把按天序列汇总成缺货率。不查库，可单测。 */
export function summarizeShortageDaily(daily: ShortageDailyRow[]): ShortageSummary {
  const shortageLines = daily.reduce((s, d) => s + d.shortage_lines, 0)
  const orderLines = daily.reduce((s, d) => s + d.order_lines, 0)
  return { shortageLines, orderLines, shortageRate: deriveShortageRate(shortageLines, orderLines) }
}
