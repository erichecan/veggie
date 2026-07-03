import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { SALES_COUNTED_STATUSES, resolveDateRange } from '@/lib/analytics/metrics'

/**
 * /api/analytics/margin — 毛利分析
 * ============================================================================
 * GET ?from&to&groupBy=product|category|customer|salesUser
 * 毛利口径（税前）：Σ (unitPrice − unitCostRef) × orderedQty
 * unitCostRef 优先级：≤确认日最近的批次加权成本（v_lot_daily_cost）
 *                    → Product.standardPrice → Template.standardPrice → 0
 * 每行返回 costedAmount（有批次成本的金额），前端展示成本覆盖率。
 */

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

const GROUP_DEFS: Record<string, { keyExpr: string; nameExpr: string; extraJoin: string }> = {
  product: {
    keyExpr: `ol."productId"`,
    nameExpr: `MAX(ol."productName")`,
    extraJoin: '',
  },
  category: {
    keyExpr: `COALESCE(cat.id, 'uncategorized')`,
    nameExpr: `COALESCE(MAX(COALESCE(cat."nameZh", cat.name)), '未分类')`,
    extraJoin: `LEFT JOIN "ProductCategory" cat ON cat.id = COALESCE(p."categoryId", pt."categoryId")`,
  },
  customer: {
    keyExpr: `o."restaurantId"`,
    nameExpr: `MAX(o."restaurantName")`,
    extraJoin: '',
  },
  salesUser: {
    keyExpr: `COALESCE(o."salesUserId", 'none')`,
    nameExpr: `COALESCE(MAX(su.name), '未指定业务员')`,
    extraJoin: `LEFT JOIN "User" su ON su.id = o."salesUserId"`,
  },
}

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      const groupBy = searchParams.get('groupBy') ?? 'product'
      const def = GROUP_DEFS[groupBy]
      if (!def) {
        return NextResponse.json({ error: `groupBy 必须是 ${Object.keys(GROUP_DEFS).join('/')}` }, { status: 400 })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const rows = (await p.$queryRawUnsafe(
        `SELECT ${def.keyExpr} AS group_key,
                ${def.nameExpr} AS group_name,
                COUNT(*)::int AS line_count,
                SUM(ol."orderedQty")::float AS qty,
                SUM(ol.subtotal)::float AS revenue_ex,
                SUM(COALESCE(lc.unit_cost, p."standardPrice", pt."standardPrice", 0) * ol."orderedQty")::float AS cost,
                SUM((ol."unitPrice" - COALESCE(lc.unit_cost, p."standardPrice", pt."standardPrice", 0)) * ol."orderedQty")::float AS gross_profit,
                SUM(CASE WHEN lc.unit_cost IS NOT NULL THEN ol.subtotal ELSE 0 END)::float AS costed_amount
         FROM "OrderLine" ol
         JOIN "Order" o ON o.id = ol."orderId"
         LEFT JOIN "Product" p ON p.id = ol."productId"
         LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
         ${def.extraJoin}
         LEFT JOIN LATERAL (
           SELECT c.unit_cost FROM v_lot_daily_cost c
           WHERE c.product_id = ol."productId"
             AND c.cost_date <= COALESCE(o."confirmationDate", o."createdAt")::date
           ORDER BY c.cost_date DESC LIMIT 1
         ) lc ON TRUE
         WHERE o.status::text IN (${SALES_STATUS_SQL})
           AND o."confirmationDate" >= $1 AND o."confirmationDate" < $2
         GROUP BY ${def.keyExpr}
         ORDER BY SUM((ol."unitPrice" - COALESCE(lc.unit_cost, p."standardPrice", pt."standardPrice", 0)) * ol."orderedQty") DESC`,
        start, end,
      )) as Array<{
        group_key: string; group_name: string; line_count: number; qty: number
        revenue_ex: number; cost: number; gross_profit: number; costed_amount: number
      }>

      const round2 = (n: number) => Math.round(n * 100) / 100
      const totalRevenue = rows.reduce((s, r) => s + r.revenue_ex, 0)
      const totalProfit = rows.reduce((s, r) => s + r.gross_profit, 0)
      const totalCosted = rows.reduce((s, r) => s + r.costed_amount, 0)

      return NextResponse.json(serializeApi({
        summary: {
          revenueExTax: round2(totalRevenue),
          grossProfit: round2(totalProfit),
          marginPct: totalRevenue > 0 ? round2((totalProfit / totalRevenue) * 100) : 0,
          costCoverageRate: totalRevenue > 0 ? Math.round((totalCosted / totalRevenue) * 10000) / 10000 : 0,
        },
        rows: rows.map((r) => ({
          key: r.group_key,
          name: r.group_name,
          lineCount: r.line_count,
          qty: Math.round(r.qty * 1000) / 1000,
          revenueExTax: round2(r.revenue_ex),
          cost: round2(r.cost),
          grossProfit: round2(r.gross_profit),
          marginPct: r.revenue_ex > 0 ? round2((r.gross_profit / r.revenue_ex) * 100) : 0,
          costCoverage: r.revenue_ex > 0 ? Math.round((r.costed_amount / r.revenue_ex) * 10000) / 10000 : 0,
        })),
      }))
    } catch (error) {
      console.error('[GET /api/analytics/margin]', error)
      return NextResponse.json({ error: '获取毛利分析失败' }, { status: 500 })
    }
  }, ['BOSS', 'OPERATOR', 'FINANCE'])
}
