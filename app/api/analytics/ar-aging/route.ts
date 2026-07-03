import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import {
  AR_AGING_BUCKETS, agingBucketKey, parseInvoiceDate, type ArAgingBucketKey,
} from '@/lib/analytics/metrics'
import { toNum } from '@/lib/decimal-helpers'

/**
 * /api/analytics/ar-aging — 应收账龄
 * ============================================================================
 * 口径：Invoice status=POSTED 且 amountDue>0；按 dueDate 与今天差值分桶。
 * dueDate 是 String 列，parse 失败归 'unknown' 桶（单独展示，不隐藏脏数据）。
 * 返回：buckets 汇总 + 按客户明细（每客户各桶金额 + 最近还款日）。
 */

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const today = new Date()
      today.setHours(0, 0, 0, 0)

      const invoices = (await p.invoice.findMany({
        where: { status: 'POSTED', amountDue: { gt: 0 } },
        select: {
          id: true, name: true, customerId: true, customerName: true,
          amountDue: true, dueDate: true, createdAt: true,
        },
      })) as Array<{
        id: string; name: string; customerId: string; customerName: string
        amountDue: unknown; dueDate: string | null; createdAt: Date
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
      let unknownCount = 0
      const byCustomer = new Map<string, {
        customerId: string; customerName: string
        total: number; invoiceCount: number
        buckets: Record<ArAgingBucketKey, number>
        oldestDue: string | null
      }>()

      for (const inv of invoices) {
        const due = toNum(inv.amountDue)
        totalDue += due
        const parsed = parseInvoiceDate(inv.dueDate)
        let key: ArAgingBucketKey
        if (!parsed) {
          key = 'unknown'
          unknownCount++
        } else {
          const overdueDays = Math.floor((today.getTime() - parsed.getTime()) / 86400000)
          key = agingBucketKey(Math.max(0, overdueDays))
          if (overdueDays <= 0) key = 'current'
        }
        totals[key] += due

        let c = byCustomer.get(inv.customerId)
        if (!c) {
          c = {
            customerId: inv.customerId, customerName: inv.customerName,
            total: 0, invoiceCount: 0, buckets: emptyBuckets(), oldestDue: null,
          }
          byCustomer.set(inv.customerId, c)
        }
        c.total += due
        c.invoiceCount++
        c.buckets[key] += due
        if (parsed) {
          const iso = parsed.toISOString().slice(0, 10)
          if (!c.oldestDue || iso < c.oldestDue) c.oldestDue = iso
        }
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
        invoiceCount: invoices.length,
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
