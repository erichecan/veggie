/**
 * AI 问数 · 查询编译器（20260906）
 * ============================================================================
 * DSL → 参数化 SQL → 执行。手法与 `app/api/analytics/margin/route.ts` 完全
 * 一致（`$queryRawUnsafe` + `$N` 占位符，SQL 片段全部来自代码常量/白名单，
 * 不拼接任何请求参数进 SQL 文本），并且直接复用它的两条查询逻辑——
 * salesAmount 就是它的 revenue_ex，grossMargin 就是它的 gross_profit，
 * 这也是"AI 问数算出来的数字必须能跟毛利页对上"这条验收标准的由来：
 * 两边根本是同一段 SQL 逻辑，不是另起一套算法再祈祷两边一致。
 *
 * v1 只支持单一维度分组（不做行列两轴透视），维度为 null 时退化成一个总计。
 */
import { prisma } from '@/lib/db'
import { SALES_COUNTED_STATUSES, resolveDateRange } from '@/lib/analytics/metrics'
import { DIMENSION_DEFS } from '@/lib/analytics/pivot'
import { getMetricDef } from '@/lib/analytics/semantic-model'
import type { AnalysisDsl } from './dsl-schema'

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

/** 与 app/api/analytics/margin/route.ts 的 STOCK_QTY_EXPR 保持一致：多单位销售换算成基准单位再求和 */
const STOCK_QTY_EXPR = `(ol."orderedQty" * COALESCE(psu.factor, 1))`

/** 行数硬上限：防止理解错的问题（比如维度选了个基数很大的字段）拖垮生产库 */
export const COMPILER_ROW_LIMIT = 500

const round2 = (n: number) => Math.round(n * 100) / 100

export interface CompiledRow {
  key: string
  name: string
  value: number
  qty: number
}

export interface CompileResult {
  rows: CompiledRow[]
  total: number
  /** 命中 COMPILER_ROW_LIMIT 时为 true，前端/解读文案要提示"仅显示前 500 行" */
  truncated: boolean
}

/**
 * 税后系数：与 `lib/order-items.ts` 的 `orderIncTaxTotal` 同一条公式
 * （taxRate 是百分数，>1 时除以 100 归一）。只有 salesAmount 会用到，
 * grossMargin 恒走税前分支（`validateDslSemantics` 已经挡掉了 grossMargin
 * 携带 taxBasis 的情况，这里的 dsl.metric 分支是双保险，不是唯一防线）。
 */
function revenueExpr(taxBasis: 'preTax' | 'incTax' | undefined): string {
  if (taxBasis === 'incTax') {
    return `SUM(ol."subtotal" * (1 + CASE WHEN ol."taxRate" > 1 THEN ol."taxRate" / 100 ELSE COALESCE(ol."taxRate", 0) END))`
  }
  return `SUM(ol."subtotal")`
}

export async function compileAndRun(dsl: AnalysisDsl): Promise<CompileResult> {
  const metricDef = getMetricDef(dsl.metric)
  if (!metricDef) throw new Error(`未知指标：${dsl.metric}`)

  const { start, end } = resolveDateRange(dsl.dateRange.from ?? null, dsl.dateRange.to ?? null)
  const dimDef = dsl.dimension ? DIMENSION_DEFS[dsl.dimension] : null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  const params: unknown[] = [start, end]
  const filterClauses: string[] = []
  if (dsl.filters.categoryId) { params.push(dsl.filters.categoryId); filterClauses.push(`p."categoryId" = $${params.length}`) }
  if (dsl.filters.customerId) { params.push(dsl.filters.customerId); filterClauses.push(`o."restaurantId" = $${params.length}`) }
  if (dsl.filters.salesUserId) { params.push(dsl.filters.salesUserId); filterClauses.push(`o."salesUserId" = $${params.length}`) }
  if (dsl.filters.productId) { params.push(dsl.filters.productId); filterClauses.push(`ol."productId" = $${params.length}`) }
  const extraWhere = filterClauses.length ? ` AND ${filterClauses.join(' AND ')}` : ''

  const groupExpr = dimDef ? dimDef.keyExpr : `'__total__'`
  const nameExpr = dimDef ? dimDef.nameExpr : `'合计'`
  const extraJoin = dimDef ? dimDef.extraJoin : ''

  const valueExpr = dsl.metric === 'grossMargin'
    ? `SUM(ol.subtotal - COALESCE(lc.unit_cost, p."standardPrice", 0) * ${STOCK_QTY_EXPR})`
    : revenueExpr(dsl.confirmedParams.taxBasis)

  const costJoin = dsl.metric === 'grossMargin'
    ? `LEFT JOIN LATERAL (
         SELECT c.unit_cost FROM v_lot_daily_cost c
         WHERE c.product_id = ol."productId"
           AND c.cost_date <= COALESCE(o."confirmationDate", o."createdAt")::date
         ORDER BY c.cost_date DESC LIMIT 1
       ) lc ON TRUE`
    : ''

  // dimDef 为 null（不分组，只要总计）时不能写 `GROUP BY '__total__'`——Postgres
  // 拒绝非整数常量出现在 GROUP BY 里（"non-integer constant in GROUP BY"）。
  // 不分组本就该省略 GROUP BY 子句，聚合函数自然收敛成一行，SELECT 列表里的
  // 常量字符串本身没问题，只有 GROUP BY 子句不接受它。
  const groupByClause = dimDef ? `GROUP BY ${groupExpr}` : ''

  const sql = `SELECT ${groupExpr} AS row_key, ${nameExpr} AS row_name,
                SUM(${STOCK_QTY_EXPR})::float AS qty,
                ${valueExpr}::float AS value
         FROM "OrderLine" ol
         JOIN "Order" o ON o.id = ol."orderId"
         LEFT JOIN "Product" p ON p.id = ol."productId"
         LEFT JOIN "ProductSaleUom" psu ON psu."productId" = ol."productId" AND psu."uomId" = ol."uomId"
         ${extraJoin}
         ${costJoin}
         WHERE o.status::text IN (${SALES_STATUS_SQL})
           AND o."confirmationDate" >= $1 AND o."confirmationDate" < $2
           ${extraWhere}
         ${groupByClause}
         ORDER BY value DESC
         LIMIT ${COMPILER_ROW_LIMIT + 1}`

  const rows = (await p.$queryRawUnsafe(sql, ...params)) as Array<{
    row_key: string; row_name: string; qty: number; value: number
  }>

  const truncated = rows.length > COMPILER_ROW_LIMIT
  const kept = truncated ? rows.slice(0, COMPILER_ROW_LIMIT) : rows
  const total = kept.reduce((s, r) => s + r.value, 0)

  return {
    rows: kept.map((r) => ({
      key: r.row_key,
      name: r.row_name,
      value: round2(r.value),
      qty: Math.round(r.qty * 1000) / 1000,
    })),
    total: round2(total),
    truncated,
  }
}
