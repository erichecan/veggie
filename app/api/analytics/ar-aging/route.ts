import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { AR_AGING_BUCKETS, type ArAgingBucketKey } from '@/lib/analytics/metrics'
import { toNum } from '@/lib/decimal-helpers'

/**
 * /api/analytics/ar-aging — 应收账龄
 * ============================================================================
 * 口径：Invoice status=POSTED 且 amountDue>0；按 dueDate 与今天差值分桶。
 * dueDate 是 String 列，无法按 yyyy-mm-dd 解析的归 'unknown' 桶（单独展示，不隐藏脏数据）。
 * 分桶与按客户汇总都在 SQL 里用 GROUP BY 完成，不整表拉发票到 Node 再用 JS reduce——
 * 发票量只会随时间线性增长，SQL 聚合把返回行数锁定在"客户数 × 6 个桶"量级。
 * 返回：buckets 汇总 + 按客户明细（每客户各桶金额 + 最近还款日）。
 */

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const rows = (await p.$queryRawUnsafe(`
        WITH aged AS (
          SELECT
            "customerId", "customerName", "amountDue",
            CASE
              WHEN "dueDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                THEN (CURRENT_DATE - "dueDate"::date)
              ELSE NULL
            END AS overdue_days,
            CASE WHEN "dueDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN "dueDate" ELSE NULL END AS due_date_clean
          FROM "Invoice"
          WHERE status = 'POSTED' AND "amountDue" > 0
        )
        SELECT
          "customerId" AS customer_id, "customerName" AS customer_name,
          CASE
            WHEN overdue_days IS NULL THEN 'unknown'
            WHEN overdue_days <= 0 THEN 'current'
            WHEN overdue_days <= 30 THEN 'd1_30'
            WHEN overdue_days <= 60 THEN 'd31_60'
            WHEN overdue_days <= 90 THEN 'd61_90'
            ELSE 'd90_plus'
          END AS bucket,
          SUM("amountDue") AS amount,
          COUNT(*)::int AS cnt,
          MIN(due_date_clean) AS oldest_due
        FROM aged
        GROUP BY "customerId", "customerName", bucket
      `)) as Array<{
        customer_id: string; customer_name: string; bucket: ArAgingBucketKey
        amount: unknown; cnt: number; oldest_due: string | null
      }>

      // 每客户最近一次收款
      const lastPayments = (await p.$queryRawUnsafe(
        `SELECT "customerId" AS customer_id, MAX("paidAt") AS last_paid_at
         FROM "Payment" GROUP BY "customerId"`,
      )) as Array<{ customer_id: string; last_paid_at: Date }>
      const lastPaidMap = new Map(lastPayments.map((r) => [r.customer_id, r.last_paid_at]))

      const bucketKeys: ArAgingBucketKey[] = [...AR_AGING_BUCKETS.map((b) => b.key), 'unknown']
      const emptyBuckets = () => Object.fromEntries(bucketKeys.map((k) => [k, 0])) as Record<ArAgingBucketKey, number>

      const totals = emptyBuckets()
      let totalDue = 0
      let invoiceCount = 0
      let unknownCount = 0
      const byCustomer = new Map<string, {
        customerId: string; customerName: string
        total: number; invoiceCount: number
        buckets: Record<ArAgingBucketKey, number>
        oldestDue: string | null
      }>()

      for (const row of rows) {
        const amount = toNum(row.amount)
        totals[row.bucket] += amount
        totalDue += amount
        invoiceCount += row.cnt
        if (row.bucket === 'unknown') unknownCount += row.cnt

        let c = byCustomer.get(row.customer_id)
        if (!c) {
          c = {
            customerId: row.customer_id, customerName: row.customer_name,
            total: 0, invoiceCount: 0, buckets: emptyBuckets(), oldestDue: null,
          }
          byCustomer.set(row.customer_id, c)
        }
        c.total += amount
        c.invoiceCount += row.cnt
        c.buckets[row.bucket] += amount
        if (row.oldest_due && (!c.oldestDue || row.oldest_due < c.oldestDue)) c.oldestDue = row.oldest_due
      }

      const round2 = (n: number) => Math.round(n * 100) / 100
      const customers = [...byCustomer.values()]
        .sort((a, b) => b.total - a.total)
        .map((c) => ({
          ...c,
          total: round2(c.total),
          buckets: Object.fromEntries(Object.entries(c.buckets).map(([k, v]) => [k, round2(v)])),
          lastPaidAt: lastPaidMap.get(c.customerId) ?? null,
        }))

      return NextResponse.json(serializeApi({
        totalDue: round2(totalDue),
        invoiceCount,
        unknownCount,
        buckets: AR_AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label, amount: round2(totals[b.key]) }))
          .concat([{ key: 'unknown' as const, label: '未知到期日', amount: round2(totals.unknown) }] as never),
        customers,
      }))
    } catch (error) {
      console.error('[GET /api/analytics/ar-aging]', error)
      return NextResponse.json({ error: '获取应收账龄失败' }, { status: 500 })
    }
  }, ['BOSS', 'FINANCE', 'OPERATOR']) // TODO: 临时放开给 OPERATOR 看数据分析中心，权限模型定下来后收紧
}
