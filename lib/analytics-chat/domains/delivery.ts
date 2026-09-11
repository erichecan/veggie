/**
 * AI 问数 · delivery 域（20260910 新建）
 * ============================================================================
 * ⛔ 四个域里实现复杂度最高的一个：数据模型是数组/JSON 快照，不是关系表。
 * `Trip.restaurants` 是 `TripRestaurant[]`（lib/types.ts），每个元素含
 * `items: OrderItem[]`——这正是客户截图想问的"某天某司机送了什么货给哪家/
 * 单价数量"，但要靠 `jsonb_array_elements` 展开两层 JSON，不能标准 JOIN。
 * 日期口径照抄 app/api/analytics/logistics/route.ts：
 * COALESCE(PickingWave.waveDate, Trip.createdAt::date)（Trip 无自身业务日期字段）。
 * 司机归属以 Trip.driverId/driverName 为准，不读 wave.orderIds
 * （driverSlotId 与 wave.orderIds 历史上分叉过，见 memory
 * driver-slot-divergence-fixed-20260708——Trip 快照字段更贴近"实际执行"）。
 */
import type { AggregateSqlArgs, DetailSqlArgs, DimensionDef, DomainDef, MetricDef, SqlQuery } from './types'

const TRIP_DATE_EXPR = `COALESCE(w."waveDate", t."createdAt"::date)`

const DIMENSIONS: Record<string, DimensionDef> = {
  driver: {
    keyExpr: `COALESCE(t."driverId", t."driverName", 'unknown')`,
    nameExpr: `COALESCE(MAX(t."driverName"), '未指定')`,
    extraJoin: '',
    isTimeBucket: false,
  },
  day: {
    keyExpr: `to_char(date_trunc('day', ${TRIP_DATE_EXPR}), 'YYYY-MM-DD')`,
    nameExpr: `MAX(to_char(date_trunc('day', ${TRIP_DATE_EXPR}), 'YYYY-MM-DD'))`,
    extraJoin: '',
    isTimeBucket: true,
  },
  week: {
    keyExpr: `to_char(date_trunc('week', ${TRIP_DATE_EXPR}), 'IYYY-"W"IW')`,
    nameExpr: `MAX(to_char(date_trunc('week', ${TRIP_DATE_EXPR}), 'IYYY-"W"IW'))`,
    extraJoin: '',
    isTimeBucket: true,
  },
  month: {
    keyExpr: `to_char(date_trunc('month', ${TRIP_DATE_EXPR}), 'YYYY-MM')`,
    nameExpr: `MAX(to_char(date_trunc('month', ${TRIP_DATE_EXPR}), 'YYYY-MM'))`,
    extraJoin: '',
    isTimeBucket: true,
  },
}

const FILTER_KEYS = ['driverId'] as const

const METRICS: Record<string, MetricDef> = {
  tripCount: {
    key: 'tripCount',
    labelZh: '行程数',
    confirmableParams: {},
    allowedDimensions: Object.keys(DIMENSIONS),
    allowedFilters: FILTER_KEYS,
  },
  stopCount: {
    key: 'stopCount',
    labelZh: '配送站点数',
    confirmableParams: {},
    allowedDimensions: Object.keys(DIMENSIONS),
    allowedFilters: FILTER_KEYS,
  },
  totalPayment: {
    key: 'totalPayment',
    labelZh: '应收总额',
    confirmableParams: {},
    allowedDimensions: Object.keys(DIMENSIONS),
    allowedFilters: FILTER_KEYS,
  },
}

function buildFilterClauses(filters: Record<string, string | undefined>, params: unknown[]): string {
  const clauses: string[] = []
  if (filters.driverId) { params.push(filters.driverId); clauses.push(`t."driverId" = $${params.length}`) }
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : ''
}

function buildAggregateSql({ metric, dimension, filters, start, end, rowLimit }: AggregateSqlArgs): SqlQuery {
  const dimDef = dimension ? DIMENSIONS[dimension] : null
  const params: unknown[] = [start, end]
  const extraWhere = buildFilterClauses(filters, params)

  const groupExpr = dimDef ? dimDef.keyExpr : `'__total__'`
  const nameExpr = dimDef ? dimDef.nameExpr : `'合计'`
  const groupByClause = dimDef ? `GROUP BY ${groupExpr}` : ''

  const valueExpr = metric.key === 'stopCount'
    ? `SUM(COALESCE(jsonb_array_length(t.restaurants), 0))`
    : metric.key === 'totalPayment'
      ? `SUM(t."totalPayment")`
      : `COUNT(DISTINCT t.id)`

  const sql = `SELECT ${groupExpr} AS row_key, ${nameExpr} AS row_name,
                SUM(COALESCE(jsonb_array_length(t.restaurants), 0))::float AS qty,
                ${valueExpr}::float AS value
         FROM "Trip" t
         LEFT JOIN "PickingWave" w ON w.id = t."waveId"
         WHERE ${TRIP_DATE_EXPR} >= $1 AND ${TRIP_DATE_EXPR} < $2
           ${extraWhere}
         ${groupByClause}
         ORDER BY value DESC
         LIMIT ${rowLimit + 1}`

  return { sql, params }
}

function buildDetailSql({ filters, start, end, rowLimit }: DetailSqlArgs): SqlQuery {
  const params: unknown[] = [start, end]
  const extraWhere = buildFilterClauses(filters, params)

  const sql = `SELECT to_char(${TRIP_DATE_EXPR}, 'YYYY-MM-DD') AS trip_date,
                COALESCE(t."driverName", '未指定') AS driver_name,
                r->>'restaurantName' AS restaurant_name,
                i->>'productName' AS product_name,
                NULLIF(i->>'price', '')::float AS unit_price,
                NULLIF(i->>'quantity', '')::float AS qty
         FROM "Trip" t
         LEFT JOIN "PickingWave" w ON w.id = t."waveId"
         CROSS JOIN LATERAL jsonb_array_elements(t.restaurants) r
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r->'items', '[]'::jsonb)) i
         WHERE ${TRIP_DATE_EXPR} >= $1 AND ${TRIP_DATE_EXPR} < $2
           ${extraWhere}
         ORDER BY ${TRIP_DATE_EXPR} DESC
         LIMIT ${rowLimit + 1}`

  return { sql, params }
}

export const deliveryDomain: DomainDef = {
  key: 'delivery',
  labelZh: '配送',
  metrics: METRICS,
  dimensions: DIMENSIONS,
  dimensionLabelsZh: { driver: '司机', day: '日', week: '周', month: '月' },
  filterKeys: FILTER_KEYS,
  filterLabelsZh: { driverId: '司机' },
  buildAggregateSql,
  detail: {
    fields: [
      { key: 'trip_date', labelZh: '日期' },
      { key: 'driver_name', labelZh: '司机' },
      { key: 'restaurant_name', labelZh: '客户' },
      { key: 'product_name', labelZh: '商品' },
      { key: 'unit_price', labelZh: '单价' },
      { key: 'qty', labelZh: '数量' },
    ],
    buildSql: buildDetailSql,
  },
}
