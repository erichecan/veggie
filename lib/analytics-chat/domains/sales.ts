/**
 * AI 问数 · sales 域（从 lib/analytics/semantic-model.ts + compiler.ts 迁移，20260910）
 * ============================================================================
 * 迁移是纯重构，SQL/口径逐字保留：销售口径=Order.confirmationDate，毛利按税前算，
 * 计入状态固定 SALES_COUNTED_STATUSES，taxBasis 只有 salesAmount 能选。
 * 新增：detail（订单行明细，不聚合），对照客户截图"每家送什么货/单价/数量"。
 */
import { SALES_COUNTED_STATUSES } from '@/lib/analytics/metrics'
import { DIMENSION_DEFS } from '@/lib/analytics/pivot'
import type { AggregateSqlArgs, DetailSqlArgs, DomainDef, MetricDef, SqlQuery } from './types'

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')
const STOCK_QTY_EXPR = `(ol."orderedQty" * COALESCE(psu.factor, 1))`

const TAX_BASIS_PARAM = {
  options: ['preTax', 'incTax'] as const,
  default: 'preTax' as const,
  labelZh: '税前/税后口径',
  optionLabelsZh: { preTax: '税前', incTax: '税后（含税）' },
}

const DIMENSION_KEYS = Object.keys(DIMENSION_DEFS)
const FILTER_KEYS = ['customerId', 'salesUserId', 'categoryId', 'productId'] as const

const METRICS: Record<string, MetricDef> = {
  salesAmount: {
    key: 'salesAmount',
    labelZh: '销售额',
    confirmableParams: { taxBasis: TAX_BASIS_PARAM },
    allowedDimensions: DIMENSION_KEYS,
    allowedFilters: FILTER_KEYS,
  },
  grossMargin: {
    key: 'grossMargin',
    labelZh: '毛利',
    confirmableParams: {},
    allowedDimensions: DIMENSION_KEYS,
    allowedFilters: FILTER_KEYS,
  },
}

function revenueExpr(taxBasis: string | undefined): string {
  if (taxBasis === 'incTax') {
    return `SUM(ol."subtotal" * (1 + CASE WHEN ol."taxRate" > 1 THEN ol."taxRate" / 100 ELSE COALESCE(ol."taxRate", 0) END))`
  }
  return `SUM(ol."subtotal")`
}

function buildFilterClauses(filters: Record<string, string | undefined>, params: unknown[]): string {
  const clauses: string[] = []
  if (filters.categoryId) { params.push(filters.categoryId); clauses.push(`p."categoryId" = $${params.length}`) }
  if (filters.customerId) { params.push(filters.customerId); clauses.push(`o."restaurantId" = $${params.length}`) }
  if (filters.salesUserId) { params.push(filters.salesUserId); clauses.push(`o."salesUserId" = $${params.length}`) }
  if (filters.productId) { params.push(filters.productId); clauses.push(`ol."productId" = $${params.length}`) }
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : ''
}

function buildAggregateSql({ metric, confirmedParams, dimension, filters, start, end, rowLimit }: AggregateSqlArgs): SqlQuery {
  const dimDef = dimension ? DIMENSION_DEFS[dimension] : null
  const params: unknown[] = [start, end]
  const extraWhere = buildFilterClauses(filters, params)

  const groupExpr = dimDef ? dimDef.keyExpr : `'__total__'`
  const nameExpr = dimDef ? dimDef.nameExpr : `'合计'`
  const extraJoin = dimDef ? dimDef.extraJoin : ''

  const valueExpr = metric.key === 'grossMargin'
    ? `SUM(ol.subtotal - COALESCE(lc.unit_cost, p."standardPrice", 0) * ${STOCK_QTY_EXPR})`
    : revenueExpr(confirmedParams.taxBasis)

  const costJoin = metric.key === 'grossMargin'
    ? `LEFT JOIN LATERAL (
         SELECT c.unit_cost FROM v_lot_daily_cost c
         WHERE c.product_id = ol."productId"
           AND c.cost_date <= COALESCE(o."confirmationDate", o."createdAt")::date
         ORDER BY c.cost_date DESC LIMIT 1
       ) lc ON TRUE`
    : ''

  // dimDef 为 null 时不能写 GROUP BY '__total__'（Postgres 拒绝非整数常量），省略即可收敛成一行
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
         LIMIT ${rowLimit + 1}`

  return { sql, params }
}

function buildDetailSql({ filters, start, end, rowLimit }: DetailSqlArgs): SqlQuery {
  const params: unknown[] = [start, end]
  const extraWhere = buildFilterClauses(filters, params)

  const sql = `SELECT to_char(o."confirmationDate", 'YYYY-MM-DD') AS order_date,
                o."restaurantName" AS customer_name,
                ol."productName" AS product_name,
                ol."unitPrice"::float AS unit_price,
                ${STOCK_QTY_EXPR}::float AS qty,
                ol.subtotal::float AS subtotal
         FROM "OrderLine" ol
         JOIN "Order" o ON o.id = ol."orderId"
         LEFT JOIN "ProductSaleUom" psu ON psu."productId" = ol."productId" AND psu."uomId" = ol."uomId"
         WHERE o.status::text IN (${SALES_STATUS_SQL})
           AND o."confirmationDate" >= $1 AND o."confirmationDate" < $2
           ${extraWhere}
         ORDER BY o."confirmationDate" DESC, o."restaurantName"
         LIMIT ${rowLimit + 1}`

  return { sql, params }
}

export const salesDomain: DomainDef = {
  key: 'sales',
  labelZh: '销售',
  metrics: METRICS,
  dimensions: DIMENSION_DEFS,
  dimensionLabelsZh: {
    product: '商品', category: '分类', customer: '客户', salesUser: '业务员',
    day: '日', week: '周', month: '月',
  },
  filterKeys: FILTER_KEYS,
  filterLabelsZh: {
    customerId: '客户', salesUserId: '业务员', categoryId: '分类', productId: '商品',
  },
  buildAggregateSql,
  detail: {
    fields: [
      { key: 'order_date', labelZh: '日期' },
      { key: 'customer_name', labelZh: '客户' },
      { key: 'product_name', labelZh: '商品' },
      { key: 'unit_price', labelZh: '单价' },
      { key: 'qty', labelZh: '数量' },
      { key: 'subtotal', labelZh: '金额' },
    ],
    buildSql: buildDetailSql,
  },
}
