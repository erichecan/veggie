import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { SALES_COUNTED_STATUSES, resolveDateRange, deriveAov } from '@/lib/analytics/metrics'
import { ensureSnapshots } from '@/lib/analytics/snapshot'
import { computeShortageDaily, summarizeShortageDaily } from '@/lib/analytics/shortage'

/**
 * /api/analytics/sales-overview — 销售统计统一视图
 * ============================================================================
 * GET ?from&to
 * 一次请求返回四项指标（日销售额/客单价/缺货率的按天序列 + 关键商品 Top10）：
 *   dailySeries  日销售额 + 客单价（销售口径 confirmationDate，读 dailyBusinessSnapshot 快照表，
 *                口径与 boss/page.tsx 首页趋势图、/api/analytics/snapshots 完全一致）
 *   shortage     缺货率按天序列 + 汇总（物流口径 deliveryDate，与 /api/analytics/shortage 共用
 *                lib/analytics/shortage.ts 里的同一份计算，避免两处公式跑偏）
 *   topProducts  所选范围内按销售额（subtotal）汇总取 Top 10，每次按范围重新排名
 */

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      await ensureSnapshots()
      const snapshots = (await p.dailyBusinessSnapshot.findMany({
        where: { snapshotDate: { gte: start, lt: end } },
        orderBy: { snapshotDate: 'asc' },
        select: { snapshotDate: true, salesExTax: true, salesIncTax: true, orderCount: true },
      })) as Array<{ snapshotDate: Date; salesExTax: unknown; salesIncTax: unknown; orderCount: number }>

      const dailySeries = snapshots.map((s) => {
        const salesExTax = Number(s.salesExTax)
        const salesIncTax = Number(s.salesIncTax)
        return {
          date: s.snapshotDate,
          salesExTax,
          salesIncTax,
          orderCount: s.orderCount,
          aov: deriveAov(salesExTax, s.orderCount),
        }
      })

      const shortageDaily = await computeShortageDaily(start, end)
      const shortageSummary = summarizeShortageDaily(shortageDaily)

      const topProductsRows = (await p.$queryRawUnsafe(
        `SELECT ol."productId" AS product_id,
                MAX(ol."productName") AS product_name,
                SUM(ol.subtotal)::float AS subtotal,
                SUM(ol."orderedQty")::float AS qty
         FROM "OrderLine" ol
         JOIN "Order" o ON o.id = ol."orderId"
         WHERE o.status::text IN (${SALES_STATUS_SQL})
           AND o."confirmationDate" >= $1 AND o."confirmationDate" < $2
         GROUP BY ol."productId"
         ORDER BY SUM(ol.subtotal) DESC
         LIMIT 10`,
        start, end,
      )) as Array<{ product_id: string; product_name: string; subtotal: number; qty: number }>

      const topProducts = topProductsRows.map((r) => ({
        productId: r.product_id,
        productName: r.product_name,
        subtotal: Math.round(r.subtotal * 100) / 100,
        qty: r.qty,
      }))

      return NextResponse.json(serializeApi({
        dailySeries,
        shortage: { series: shortageDaily, summary: shortageSummary },
        topProducts,
      }))
    } catch (error) {
      console.error('[GET /api/analytics/sales-overview]', error)
      return NextResponse.json({ error: '获取销售统计总览失败' }, { status: 500 })
    }
  }, ['BOSS', 'OPERATOR', 'FINANCE'])
}
