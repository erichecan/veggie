import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { SALES_COUNTED_STATUSES, resolveDateRange } from '@/lib/analytics/metrics'

/**
 * /api/analytics/shortage — 缺货分析 × 采购联动
 * ============================================================================
 * GET ?from&to
 * 返回：
 *   daily      每日缺货行数 / 订单行数（物流口径 deliveryDate）
 *   byProduct  按商品：缺货次数、缺货量、影响订单数、当前库存、
 *              采购联动状态（是否有 pending/ordered 的采购建议、是否有在途 PO）
 */

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const daily = (await p.$queryRawUnsafe(
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
      )) as Array<{ day: Date; shortage_lines: number; order_lines: number }>

      const byProduct = (await p.$queryRawUnsafe(
        `SELECT dc."productId" AS product_id,
                MAX(dc."productName") AS product_name,
                COUNT(*)::int AS times,
                SUM(dc."diffQty")::float AS short_qty,
                COUNT(DISTINCT dc."orderId")::int AS affected_orders,
                MAX(p."qtyOnHand")::float AS qty_on_hand,
                COALESCE(BOOL_OR(ps.id IS NOT NULL), false) AS has_suggestion,
                COALESCE(BOOL_OR(pol.id IS NOT NULL), false) AS has_incoming_po
         FROM "OrderDiscrepancy" dc
         JOIN "Order" o ON o.id = dc."orderId"
         LEFT JOIN "Product" p ON p.id = dc."productId"
         LEFT JOIN "PurchaseSuggestion" ps
           ON ps."productId" = dc."productId" AND ps.status IN ('pending', 'approved', 'ordered')
         LEFT JOIN "PurchaseOrderLine" pol
           ON pol."productId" = dc."productId"
          AND pol."receivedQty" < pol."orderedQty"
          AND EXISTS (SELECT 1 FROM "PurchaseOrder" po2
                      WHERE po2.id = pol."purchaseOrderId" AND po2.status::text IN ('CONFIRMED', 'SENT'))
         WHERE o."deliveryDate" >= $1 AND o."deliveryDate" < $2
           AND dc.status <> 'CANCELLED'
         GROUP BY dc."productId"
         ORDER BY COUNT(*) DESC, SUM(dc."diffQty") DESC`,
        start, end,
      )) as Array<{
        product_id: string; product_name: string; times: number; short_qty: number
        affected_orders: number; qty_on_hand: number | null
        has_suggestion: boolean; has_incoming_po: boolean
      }>

      const totalShort = daily.reduce((s, d) => s + d.shortage_lines, 0)
      const totalLines = daily.reduce((s, d) => s + d.order_lines, 0)

      return NextResponse.json(serializeApi({
        summary: {
          shortageLines: totalShort,
          orderLines: totalLines,
          shortageRate: totalLines > 0 ? Math.round((totalShort / totalLines) * 10000) / 10000 : 0,
          productsAffected: byProduct.length,
          // 缺货但既无采购建议也无在途 PO 的商品数（真正的采购盲区）
          unlinked: byProduct.filter((r) => !r.has_suggestion && !r.has_incoming_po).length,
        },
        daily,
        byProduct,
      }))
    } catch (error) {
      console.error('[GET /api/analytics/shortage]', error)
      return NextResponse.json({ error: '获取缺货分析失败' }, { status: 500 })
    }
  }, ['BOSS', 'OPERATOR'])
}
