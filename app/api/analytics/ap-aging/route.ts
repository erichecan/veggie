import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { AGING_BUCKETS, type AgingBucketKey } from '@/lib/analytics/metrics'
import { toNum } from '@/lib/decimal-helpers'
import { withCachedAuth } from '@/lib/analytics/cache'

/**
 * /api/analytics/ap-aging — 应付账龄
 * ============================================================================
 * 与 ar-aging 严格对称：同一套账龄阈值（AGING_BUCKETS），同样的返回体形状，
 * 这样「应收 60 天以上 vs 应付 60 天以上」才能直接对读。
 *
 * 口径：VendorBill status=POSTED 且 amountDue>0，按 dueDate 与今天差值分桶。
 * 与应收的一处差异：Invoice.dueDate 是 String 列（要正则挑出可解析的），
 * VendorBill.dueDate 是真 DateTime?，所以这里只需判 NULL —— 没有到期日的归 'unknown' 桶
 * 单独展示，不混进 current 假装未到期。
 *
 * 分桶与按供应商汇总都在 SQL 里 GROUP BY 完成，返回行数锁定在"供应商数 × 6 桶"量级。
 */

export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const rows = (await p.$queryRawUnsafe(`
        WITH aged AS (
          SELECT
            vb."supplierId",
            COALESCE(c."name", '(供应商已删除)') AS supplier_name,
            vb."amountDue",
            CASE WHEN vb."dueDate" IS NULL THEN NULL
                 ELSE (CURRENT_DATE - vb."dueDate"::date) END AS overdue_days,
            vb."dueDate"::date AS due_date_clean
          FROM "VendorBill" vb
          LEFT JOIN "Customer" c ON c."id" = vb."supplierId"
          WHERE vb.status = 'POSTED' AND vb."amountDue" > 0
        )
        SELECT
          "supplierId" AS supplier_id, supplier_name,
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
        GROUP BY "supplierId", supplier_name, bucket
      `)) as Array<{
        supplier_id: string; supplier_name: string; bucket: AgingBucketKey
        amount: unknown; cnt: number; oldest_due: Date | null
      }>

      // 每供应商最近一次付款：VendorBill.paidAt 是该单付清的时间
      const lastPaid = (await p.$queryRawUnsafe(
        `SELECT "supplierId" AS supplier_id, MAX("paidAt") AS last_paid_at
         FROM "VendorBill" WHERE "paidAt" IS NOT NULL GROUP BY "supplierId"`,
      )) as Array<{ supplier_id: string; last_paid_at: Date }>
      const lastPaidMap = new Map(lastPaid.map(r => [r.supplier_id, r.last_paid_at]))

      const bucketKeys: AgingBucketKey[] = [...AGING_BUCKETS.map(b => b.key), 'unknown']
      const emptyBuckets = () =>
        Object.fromEntries(bucketKeys.map(k => [k, 0])) as Record<AgingBucketKey, number>

      const totals = emptyBuckets()
      let totalDue = 0
      let billCount = 0
      let unknownCount = 0
      const bySupplier = new Map<string, {
        supplierId: string; supplierName: string
        total: number; billCount: number
        buckets: Record<AgingBucketKey, number>
        oldestDue: string | null
      }>()

      for (const row of rows) {
        const amount = toNum(row.amount)
        totals[row.bucket] += amount
        totalDue += amount
        billCount += row.cnt
        if (row.bucket === 'unknown') unknownCount += row.cnt

        let s = bySupplier.get(row.supplier_id)
        if (!s) {
          s = {
            supplierId: row.supplier_id, supplierName: row.supplier_name,
            total: 0, billCount: 0, buckets: emptyBuckets(), oldestDue: null,
          }
          bySupplier.set(row.supplier_id, s)
        }
        s.total += amount
        s.billCount += row.cnt
        s.buckets[row.bucket] += amount
        const due = row.oldest_due ? new Date(row.oldest_due).toISOString().slice(0, 10) : null
        if (due && (!s.oldestDue || due < s.oldestDue)) s.oldestDue = due
      }

      // 上游堆积情况：账龄只统计已过账(POSTED)的账单——这是正确的会计口径，
      // 但如果账单全卡在 DRAFT，页面会是一片零，看起来像坏了。把上游数量摊开讲清楚，
      // 让"为什么是空的"变成页面上的信息，而不是让人以为功能没做。
      const draftAgg = await prisma.vendorBill.aggregate({
        where: { status: 'DRAFT' },
        _count: true,
        _sum: { amountDue: true },
      })
      const postedMissingDue = await prisma.vendorBill.count({
        where: { status: 'POSTED', amountDue: { gt: 0 }, dueDate: null },
      })

      const round2 = (n: number) => Math.round(n * 100) / 100
      const suppliers = [...bySupplier.values()]
        .sort((a, b) => b.total - a.total)
        .map(s => ({
          ...s,
          total: round2(s.total),
          buckets: Object.fromEntries(Object.entries(s.buckets).map(([k, v]) => [k, round2(v)])),
          lastPaidAt: lastPaidMap.get(s.supplierId) ?? null,
        }))

      return NextResponse.json(serializeApi({
        totalDue: round2(totalDue),
        billCount,
        unknownCount,
        buckets: AGING_BUCKETS.map(b => ({ key: b.key, label: b.label, amount: round2(totals[b.key]) }))
          .concat([{ key: 'unknown' as const, label: '未知到期日', amount: round2(totals.unknown) }] as never),
        suppliers,
        /** 尚未过账、因而不计入账龄的账单——用来解释"账龄为空"到底是没欠款还是没过账 */
        pending: {
          draftCount: draftAgg._count,
          draftAmount: round2(toNum(draftAgg._sum.amountDue ?? 0)),
          postedMissingDueDate: postedMissingDue,
        },
      }))
    } catch (error) {
      console.error('[GET /api/analytics/ap-aging]', error)
      return NextResponse.json({ error: '获取应付账龄失败' }, { status: 500 })
    }
  }, { require: 'analytics.finance.read' }) // 与 ar-aging 保持同一角色口径
}
