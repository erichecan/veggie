/**
 * AI 问数 · procurement 域（20260910 新建）
 * ============================================================================
 * 结构与 sales 域高度对称：PurchaseOrder/PurchaseOrderLine 两表 JOIN，字段与
 * Order/OrderLine 基本一一对应。口径照抄 app/api/analytics/procurement/route.ts：
 * 计入状态 = CONFIRMED/RECEIVED/INVOICED/LOCKED，时间口径 = COALESCE(confirmedAt, orderDate)。
 * 供应商复用 Customer 表（项目里客户/供应商是同一张表）。
 */
import type { AggregateSqlArgs, DetailSqlArgs, DimensionDef, DomainDef, MetricDef, SqlQuery } from './types'

const PO_COUNTED = `'CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED'`

const DIMENSIONS: Record<string, DimensionDef> = {
  supplier: {
    keyExpr: `po."supplierId"`,
    nameExpr: `COALESCE(MAX(s.name), MAX(po."supplierId"))`,
    extraJoin: `LEFT JOIN "Customer" s ON s.id = po."supplierId"`,
    isTimeBucket: false,
  },
  product: {
    keyExpr: `pol."productId"`,
    nameExpr: `MAX(pol."productName")`,
    extraJoin: '',
    isTimeBucket: false,
  },
  category: {
    keyExpr: `COALESCE(cat.id, 'uncategorized')`,
    nameExpr: `COALESCE(MAX(COALESCE(cat."nameZh", cat.name)), '未分类')`,
    extraJoin: `LEFT JOIN "Product" p ON p.id = pol."productId" LEFT JOIN "ProductCategory" cat ON cat.id = p."categoryId"`,
    isTimeBucket: false,
  },
  day: {
    keyExpr: `to_char(date_trunc('day', COALESCE(po."confirmedAt", po."orderDate")), 'YYYY-MM-DD')`,
    nameExpr: `MAX(to_char(date_trunc('day', COALESCE(po."confirmedAt", po."orderDate")), 'YYYY-MM-DD'))`,
    extraJoin: '',
    isTimeBucket: true,
  },
  week: {
    keyExpr: `to_char(date_trunc('week', COALESCE(po."confirmedAt", po."orderDate")), 'IYYY-"W"IW')`,
    nameExpr: `MAX(to_char(date_trunc('week', COALESCE(po."confirmedAt", po."orderDate")), 'IYYY-"W"IW'))`,
    extraJoin: '',
    isTimeBucket: true,
  },
  month: {
    keyExpr: `to_char(date_trunc('month', COALESCE(po."confirmedAt", po."orderDate")), 'YYYY-MM')`,
    nameExpr: `MAX(to_char(date_trunc('month', COALESCE(po."confirmedAt", po."orderDate")), 'YYYY-MM'))`,
    extraJoin: '',
    isTimeBucket: true,
  },
}

const FILTER_KEYS = ['supplierId', 'categoryId', 'productId'] as const

const METRICS: Record<string, MetricDef> = {
  purchaseAmount: {
    key: 'purchaseAmount',
    labelZh: '采购额（税前）',
    confirmableParams: {},
    allowedDimensions: Object.keys(DIMENSIONS),
    allowedFilters: FILTER_KEYS,
  },
  purchaseQty: {
    key: 'purchaseQty',
    labelZh: '采购数量',
    confirmableParams: {},
    allowedDimensions: Object.keys(DIMENSIONS),
    allowedFilters: FILTER_KEYS,
  },
}

function buildFilterClauses(filters: Record<string, string | undefined>, params: unknown[], needsProductJoin: boolean): string {
  const clauses: string[] = []
  if (filters.supplierId) { params.push(filters.supplierId); clauses.push(`po."supplierId" = $${params.length}`) }
  if (filters.productId) { params.push(filters.productId); clauses.push(`pol."productId" = $${params.length}`) }
  if (filters.categoryId) {
    params.push(filters.categoryId)
    clauses.push(needsProductJoin ? `p."categoryId" = $${params.length}` : `pol."productId" IN (SELECT id FROM "Product" WHERE "categoryId" = $${params.length})`)
  }
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : ''
}

function buildAggregateSql({ metric, dimension, filters, start, end, rowLimit }: AggregateSqlArgs): SqlQuery {
  const dimDef = dimension ? DIMENSIONS[dimension] : null
  const params: unknown[] = [start, end]
  // category 维度已经自带 Product JOIN（别名 p），筛选条件复用它，不重复 JOIN
  const extraWhere = buildFilterClauses(filters, params, dimension === 'category')

  const groupExpr = dimDef ? dimDef.keyExpr : `'__total__'`
  const nameExpr = dimDef ? dimDef.nameExpr : `'合计'`
  const extraJoin = dimDef ? dimDef.extraJoin : ''
  const groupByClause = dimDef ? `GROUP BY ${groupExpr}` : ''

  const valueExpr = metric.key === 'purchaseQty' ? `SUM(pol."orderedQty")` : `SUM(pol."subtotalExTax")`

  const sql = `SELECT ${groupExpr} AS row_key, ${nameExpr} AS row_name,
                SUM(pol."orderedQty")::float AS qty,
                ${valueExpr}::float AS value
         FROM "PurchaseOrderLine" pol
         JOIN "PurchaseOrder" po ON po.id = pol."purchaseOrderId"
         ${extraJoin}
         WHERE po.status::text IN (${PO_COUNTED})
           AND COALESCE(po."confirmedAt", po."orderDate") >= $1
           AND COALESCE(po."confirmedAt", po."orderDate") < $2
           ${extraWhere}
         ${groupByClause}
         ORDER BY value DESC
         LIMIT ${rowLimit + 1}`

  return { sql, params }
}

function buildDetailSql({ filters, start, end, rowLimit }: DetailSqlArgs): SqlQuery {
  const params: unknown[] = [start, end]
  const extraWhere = buildFilterClauses(filters, params, false)

  const sql = `SELECT to_char(COALESCE(po."confirmedAt", po."orderDate"), 'YYYY-MM-DD') AS po_date,
                COALESCE(s.name, po."supplierId") AS supplier_name,
                pol."productName" AS product_name,
                pol."unitCost"::float AS unit_cost,
                pol."orderedQty"::float AS ordered_qty,
                pol."receivedQty"::float AS received_qty,
                pol."subtotalExTax"::float AS subtotal
         FROM "PurchaseOrderLine" pol
         JOIN "PurchaseOrder" po ON po.id = pol."purchaseOrderId"
         LEFT JOIN "Customer" s ON s.id = po."supplierId"
         WHERE po.status::text IN (${PO_COUNTED})
           AND COALESCE(po."confirmedAt", po."orderDate") >= $1
           AND COALESCE(po."confirmedAt", po."orderDate") < $2
           ${extraWhere}
         ORDER BY COALESCE(po."confirmedAt", po."orderDate") DESC
         LIMIT ${rowLimit + 1}`

  return { sql, params }
}

export const procurementDomain: DomainDef = {
  key: 'procurement',
  labelZh: '采购',
  metrics: METRICS,
  dimensions: DIMENSIONS,
  dimensionLabelsZh: { supplier: '供应商', product: '商品', category: '分类', day: '日', week: '周', month: '月' },
  filterKeys: FILTER_KEYS,
  filterLabelsZh: { supplierId: '供应商', categoryId: '分类', productId: '商品' },
  buildAggregateSql,
  detail: {
    fields: [
      { key: 'po_date', labelZh: '日期' },
      { key: 'supplier_name', labelZh: '供应商' },
      { key: 'product_name', labelZh: '商品' },
      { key: 'unit_cost', labelZh: '单价' },
      { key: 'ordered_qty', labelZh: '订购数量', summable: true },
      { key: 'received_qty', labelZh: '已收数量', summable: true },
      { key: 'subtotal', labelZh: '金额', summable: true },
    ],
    buildSql: buildDetailSql,
  },
}
