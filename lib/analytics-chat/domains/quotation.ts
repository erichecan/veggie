/**
 * AI 问数 · quotation 域（20260910 新建）
 * ============================================================================
 * 没有独立 Quotation 表——Order.status=PENDING 就是报价单，Order.quotationDate
 * 是每张订单创建时打的"何时成为报价单"戳（app/api/orders/route.ts:318，恒有值，
 * 不受后续状态变化影响），"转化"= PENDING → CONFIRMED 的状态迁移。
 *
 * ⛔ 口径坑（V1 探针实测发现）：转化率必须用"当前 status 是否已进入
 * SALES_COUNTED_STATUSES" 判定，不能用"是否存在过 confirmed 审计记录"——
 * 有单子被确认后又撤回（withdrawn）变回 PENDING，此时它有 confirmed 记录但
 * 不该算已转化。population = quotationDate 落在区间内的全部订单（不管当前
 * 状态），converted = 其中当前状态已经是 CONFIRMED 及之后的子集。
 */
import { SALES_COUNTED_STATUSES } from '@/lib/analytics/metrics'
import type { AggregateSqlArgs, DetailSqlArgs, DimensionDef, DomainDef, MetricDef, SqlQuery } from './types'

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

const DIMENSIONS: Record<string, DimensionDef> = {
  customer: {
    keyExpr: `o."restaurantId"`,
    nameExpr: `MAX(o."restaurantName")`,
    extraJoin: '',
    isTimeBucket: false,
  },
  salesUser: {
    keyExpr: `COALESCE(o."salesUserId", 'none')`,
    nameExpr: `COALESCE(MAX(su.name), '未指定业务员')`,
    extraJoin: `LEFT JOIN "User" su ON su.id = o."salesUserId"`,
    isTimeBucket: false,
  },
  day: {
    keyExpr: `to_char(date_trunc('day', o."quotationDate"), 'YYYY-MM-DD')`,
    nameExpr: `MAX(to_char(date_trunc('day', o."quotationDate"), 'YYYY-MM-DD'))`,
    extraJoin: '',
    isTimeBucket: true,
  },
  week: {
    keyExpr: `to_char(date_trunc('week', o."quotationDate"), 'IYYY-"W"IW')`,
    nameExpr: `MAX(to_char(date_trunc('week', o."quotationDate"), 'IYYY-"W"IW'))`,
    extraJoin: '',
    isTimeBucket: true,
  },
  month: {
    keyExpr: `to_char(date_trunc('month', o."quotationDate"), 'YYYY-MM')`,
    nameExpr: `MAX(to_char(date_trunc('month', o."quotationDate"), 'YYYY-MM'))`,
    extraJoin: '',
    isTimeBucket: true,
  },
}

const FILTER_KEYS = ['customerId', 'salesUserId'] as const

const METRICS: Record<string, MetricDef> = {
  quotationCount: {
    key: 'quotationCount',
    labelZh: '报价单数量',
    confirmableParams: {},
    allowedDimensions: Object.keys(DIMENSIONS),
    allowedFilters: FILTER_KEYS,
  },
  quotationAmount: {
    key: 'quotationAmount',
    labelZh: '报价单金额',
    confirmableParams: {},
    allowedDimensions: Object.keys(DIMENSIONS),
    allowedFilters: FILTER_KEYS,
  },
  conversionRate: {
    key: 'conversionRate',
    labelZh: '转化率（%）',
    confirmableParams: {},
    allowedDimensions: Object.keys(DIMENSIONS),
    allowedFilters: FILTER_KEYS,
    // 比率指标：分组总计不能直接相加（8 组的转化率加起来没有业务含义），
    // compiler.ts 改按 qty（各分组样本量）加权平均算总计
    aggregationKind: 'rate',
  },
}

function buildFilterClauses(filters: Record<string, string | undefined>, params: unknown[]): string {
  const clauses: string[] = []
  if (filters.customerId) { params.push(filters.customerId); clauses.push(`o."restaurantId" = $${params.length}`) }
  if (filters.salesUserId) { params.push(filters.salesUserId); clauses.push(`o."salesUserId" = $${params.length}`) }
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : ''
}

function buildAggregateSql({ metric, dimension, filters, start, end, rowLimit }: AggregateSqlArgs): SqlQuery {
  const dimDef = dimension ? DIMENSIONS[dimension] : null
  const params: unknown[] = [start, end]
  const extraWhere = buildFilterClauses(filters, params)

  const groupExpr = dimDef ? dimDef.keyExpr : `'__total__'`
  const nameExpr = dimDef ? dimDef.nameExpr : `'合计'`
  const extraJoin = dimDef ? dimDef.extraJoin : ''
  const groupByClause = dimDef ? `GROUP BY ${groupExpr}` : ''

  const valueExpr = metric.key === 'quotationAmount'
    ? `SUM(o."totalAmount")`
    : metric.key === 'conversionRate'
      ? `(COUNT(*) FILTER (WHERE o.status::text IN (${SALES_STATUS_SQL}))::float / NULLIF(COUNT(*), 0) * 100)`
      : `COUNT(DISTINCT o.id)`

  const sql = `SELECT ${groupExpr} AS row_key, ${nameExpr} AS row_name,
                COUNT(*)::float AS qty,
                ${valueExpr}::float AS value
         FROM "Order" o
         ${extraJoin}
         WHERE o."quotationDate" >= $1 AND o."quotationDate" < $2
           ${extraWhere}
         ${groupByClause}
         ORDER BY value DESC
         LIMIT ${rowLimit + 1}`

  return { sql, params }
}

function buildDetailSql({ filters, start, end, rowLimit }: DetailSqlArgs): SqlQuery {
  const params: unknown[] = [start, end]
  const extraWhere = buildFilterClauses(filters, params)

  const sql = `SELECT to_char(o."quotationDate", 'YYYY-MM-DD') AS quotation_date,
                o."restaurantName" AS customer_name,
                COALESCE(su.name, '未指定') AS sales_user_name,
                o.status::text AS status,
                o."totalAmount"::float AS amount
         FROM "Order" o
         LEFT JOIN "User" su ON su.id = o."salesUserId"
         WHERE o."quotationDate" >= $1 AND o."quotationDate" < $2
           ${extraWhere}
         ORDER BY o."quotationDate" DESC
         LIMIT ${rowLimit + 1}`

  return { sql, params }
}

export const quotationDomain: DomainDef = {
  key: 'quotation',
  labelZh: '报价单',
  metrics: METRICS,
  dimensions: DIMENSIONS,
  dimensionLabelsZh: { customer: '客户', salesUser: '业务员', day: '日', week: '周', month: '月' },
  filterKeys: FILTER_KEYS,
  filterLabelsZh: { customerId: '客户', salesUserId: '业务员' },
  buildAggregateSql,
  detail: {
    fields: [
      { key: 'quotation_date', labelZh: '报价日期' },
      { key: 'customer_name', labelZh: '客户' },
      { key: 'sales_user_name', labelZh: '业务员' },
      { key: 'status', labelZh: '当前状态' },
      { key: 'amount', labelZh: '金额' },
    ],
    buildSql: buildDetailSql,
  },
}
