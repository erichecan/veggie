import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { SALES_COUNTED_STATUSES, resolveDateRange } from '@/lib/analytics/metrics'
import { DIMENSION_DEFS, buildPivot, PivotTooManyColumnsError, type PivotRawCell } from '@/lib/analytics/pivot'
import { withCachedAuth } from '@/lib/analytics/cache'

/**
 * /api/analytics/margin — 毛利分析
 * ============================================================================
 * GET ?from&to&groupBy=product|category|customer|salesUser|day|week|month
 *     &colBy=<同上，可选，传了就是透视模式>
 *     &categoryId&customerId&salesUserId（可选精确过滤）
 * 毛利口径（税前）：Σ (unitPrice − unitCostRef) × orderedQty
 * unitCostRef 优先级：≤确认日最近的批次加权成本（v_lot_daily_cost）
 *                    → Product.standardPrice → Template.standardPrice → 0
 * 每行返回 costedAmount（有批次成本的金额），前端展示成本覆盖率。
 * 不传 colBy 时行为与透视模式改造前完全一致；透视设计见 docs/20260731-flexible-pivot-analysis-design.md
 */

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

/**
 * 多单位销售(20260714)：ol."orderedQty" 按行选用单位计数，非商品"基准单位"(pt."uomId")时
 * 需要按 Uom.factor 比例换算成基准单位数量再参与 SUM，否则"箱"和"个"直接相加/相乘会失真。
 * 逻辑与 lib/inventory.ts 的 toStockQty 换算公式一致。
 */
const STOCK_QTY_EXPR = `(CASE WHEN ol."uomId" IS NOT NULL AND ol."uomId" <> pt."uomId"
       AND line_uom.factor IS NOT NULL AND anchor_uom.factor IS NOT NULL AND anchor_uom.factor <> 0
       THEN ol."orderedQty" * (line_uom.factor / anchor_uom.factor)
       ELSE ol."orderedQty" END)`

const round2 = (n: number) => Math.round(n * 100) / 100

export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      const groupBy = searchParams.get('groupBy') ?? 'product'
      const colByParam = searchParams.get('colBy')
      const categoryId = searchParams.get('categoryId')
      const customerId = searchParams.get('customerId')
      const salesUserId = searchParams.get('salesUserId')

      const rowDef = DIMENSION_DEFS[groupBy]
      if (!rowDef) {
        return NextResponse.json({ error: `groupBy 必须是 ${Object.keys(DIMENSION_DEFS).join('/')}` }, { status: 400 })
      }
      const colBy = colByParam || null
      const colDef = colBy ? DIMENSION_DEFS[colBy] : null
      if (colBy && !colDef) {
        return NextResponse.json({ error: `colBy 必须是 ${Object.keys(DIMENSION_DEFS).join('/')}` }, { status: 400 })
      }
      if (colBy && colBy === groupBy) {
        return NextResponse.json({ error: '行列维度不能相同' }, { status: 400 })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const params: unknown[] = [start, end]
      const filters: string[] = []
      if (categoryId) { params.push(categoryId); filters.push(`COALESCE(p."categoryId", pt."categoryId") = $${params.length}`) }
      if (customerId) { params.push(customerId); filters.push(`o."restaurantId" = $${params.length}`) }
      if (salesUserId) { params.push(salesUserId); filters.push(`o."salesUserId" = $${params.length}`) }
      const extraWhere = filters.length ? ` AND ${filters.join(' AND ')}` : ''

      const colSelect = colDef ? `, ${colDef.keyExpr} AS col_key, ${colDef.nameExpr} AS col_name` : ''
      const colGroupBy = colDef ? `, ${colDef.keyExpr}` : ''
      const colJoin = colDef ? colDef.extraJoin : ''

      const rows = (await p.$queryRawUnsafe(
        `SELECT ${rowDef.keyExpr} AS row_key,
                ${rowDef.nameExpr} AS row_name
                ${colSelect},
                COUNT(*)::int AS line_count,
                SUM(${STOCK_QTY_EXPR})::float AS qty,
                SUM(ol.subtotal)::float AS revenue_ex,
                SUM(COALESCE(lc.unit_cost, p."standardPrice", pt."standardPrice", 0) * ${STOCK_QTY_EXPR})::float AS cost,
                SUM(ol.subtotal - COALESCE(lc.unit_cost, p."standardPrice", pt."standardPrice", 0) * ${STOCK_QTY_EXPR})::float AS gross_profit,
                SUM(CASE WHEN lc.unit_cost IS NOT NULL THEN ol.subtotal ELSE 0 END)::float AS costed_amount
         FROM "OrderLine" ol
         JOIN "Order" o ON o.id = ol."orderId"
         LEFT JOIN "Product" p ON p.id = ol."productId"
         LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
         LEFT JOIN "Uom" line_uom ON line_uom.id = ol."uomId"
         LEFT JOIN "Uom" anchor_uom ON anchor_uom.id = pt."uomId"
         ${rowDef.extraJoin}
         ${colJoin}
         LEFT JOIN LATERAL (
           SELECT c.unit_cost FROM v_lot_daily_cost c
           WHERE c.product_id = ol."productId"
             AND c.cost_date <= COALESCE(o."confirmationDate", o."createdAt")::date
           ORDER BY c.cost_date DESC LIMIT 1
         ) lc ON TRUE
         WHERE o.status::text IN (${SALES_STATUS_SQL})
           AND o."confirmationDate" >= $1 AND o."confirmationDate" < $2
           ${extraWhere}
         GROUP BY ${rowDef.keyExpr}${colGroupBy}
         ORDER BY SUM(ol.subtotal - COALESCE(lc.unit_cost, p."standardPrice", pt."standardPrice", 0) * ${STOCK_QTY_EXPR}) DESC`,
        ...params,
      )) as Array<{
        row_key: string; row_name: string; col_key?: string; col_name?: string
        line_count: number; qty: number; revenue_ex: number; cost: number; gross_profit: number; costed_amount: number
      }>

      const totalRevenue = rows.reduce((s, r) => s + r.revenue_ex, 0)
      const totalProfit = rows.reduce((s, r) => s + r.gross_profit, 0)
      const totalCosted = rows.reduce((s, r) => s + r.costed_amount, 0)
      const summary = {
        revenueExTax: round2(totalRevenue),
        grossProfit: round2(totalProfit),
        marginPct: totalRevenue > 0 ? round2((totalProfit / totalRevenue) * 100) : 0,
        costCoverageRate: totalRevenue > 0 ? Math.round((totalCosted / totalRevenue) * 10000) / 10000 : 0,
      }

      if (!colDef) {
        return NextResponse.json(serializeApi({
          summary,
          rows: rows.map((r) => ({
            key: r.row_key,
            name: r.row_name,
            lineCount: r.line_count,
            qty: Math.round(r.qty * 1000) / 1000,
            revenueExTax: round2(r.revenue_ex),
            cost: round2(r.cost),
            grossProfit: round2(r.gross_profit),
            marginPct: r.revenue_ex > 0 ? round2((r.gross_profit / r.revenue_ex) * 100) : 0,
            costCoverage: r.revenue_ex > 0 ? Math.round((r.costed_amount / r.revenue_ex) * 10000) / 10000 : 0,
          })),
        }))
      }

      const rawCells: PivotRawCell[] = rows.map((r) => ({
        rowKey: r.row_key,
        rowName: r.row_name,
        colKey: String(r.col_key),
        colName: String(r.col_name),
        qty: r.qty,
        revenueExTax: r.revenue_ex,
        cost: r.cost,
        grossProfit: r.gross_profit,
      }))

      try {
        const pivot = buildPivot(rawCells, { rowIsTimeBucket: rowDef.isTimeBucket, colIsTimeBucket: colDef.isTimeBucket })
        return NextResponse.json(serializeApi({ summary, ...pivot }))
      } catch (err) {
        if (err instanceof PivotTooManyColumnsError) {
          return NextResponse.json({ error: err.message }, { status: 400 })
        }
        throw err
      }
    } catch (error) {
      console.error('[GET /api/analytics/margin]', error)
      return NextResponse.json({ error: '获取毛利分析失败' }, { status: 500 })
    }
  }, ['BOSS', 'OPERATOR', 'FINANCE'])
}
