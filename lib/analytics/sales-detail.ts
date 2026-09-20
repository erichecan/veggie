import { prisma } from '@/lib/db'
import { SALES_COUNTED_STATUSES, toNaiveTimestampParam } from '@/lib/analytics/metrics'
import { DATE_BASIS_EXPR } from '@/lib/analytics/pivot'
import { displayUomName } from '@/lib/sale-uom'

/**
 * 销售明细点货清单（20260915，客户需求4：某段时间+1-3家客户+1-2个产品，逐行看
 * 具体哪天/哪个客户/哪个产品/单价/数量/金额）。
 *
 * 字段结构与口径跟 AI 问数 sales 域的 detail 模式（lib/analytics-chat/domains/sales.ts
 * buildDetailSql）一致，但独立实现，不改共享的 DetailSqlArgs 类型——那个类型给
 * sales/quotation/procurement/delivery 四个域共用，为这一个新需求改成员的多值支持，
 * 影响面会波及一个已经稳定上线的功能（AI 问数），划不来。
 */

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')
/** 换算口径同 app/api/analytics/margin/route.ts 的 STOCK_QTY_EXPR */
const STOCK_QTY_EXPR = `(ol."orderedQty" * COALESCE(psu.factor, 1))`

const DETAIL_ROW_LIMIT = 2000

/**
 * 20260916：日期口径改送货日，与同页「按周」视图（margin?dateBasis=delivery）一致。
 * 客户是"先送货、事后补录确认"的作业方式，按确认日排的明细，日期列跟客户记忆中的
 * 送货日对不上（实测 2026-09-13 送的 6 张单里 3 张 09-16 才确认）。
 */
const DATE_EXPR = DATE_BASIS_EXPR.delivery

export interface SalesDetailFilters {
  customerIds?: string[]
  productIds?: string[]
}

export interface SalesDetailRow {
  orderDate: string
  customerName: string
  productName: string
  unitPrice: number
  qty: number
  subtotal: number
}

export interface SalesDetailResult {
  rows: SalesDetailRow[]
  truncated: boolean
}

export async function fetchSalesDetail(
  start: Date,
  end: Date,
  filters: SalesDetailFilters,
): Promise<SalesDetailResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  const params: unknown[] = [toNaiveTimestampParam(start), toNaiveTimestampParam(end)]
  const clauses: string[] = []
  if (filters.customerIds?.length) {
    params.push(filters.customerIds)
    clauses.push(`o."restaurantId" = ANY($${params.length}::text[])`)
  }
  if (filters.productIds?.length) {
    params.push(filters.productIds)
    clauses.push(`ol."productId" = ANY($${params.length}::text[])`)
  }
  const extraWhere = clauses.length ? ` AND ${clauses.join(' AND ')}` : ''

  const rows = (await p.$queryRawUnsafe(
    `SELECT to_char(${DATE_EXPR}, 'YYYY-MM-DD') AS order_date,
            o."restaurantName" AS customer_name,
            ol."productName" AS product_name,
            ol."uomName" AS uom_name,
            ol."unitPrice"::float AS unit_price,
            ${STOCK_QTY_EXPR}::float AS qty,
            ol.subtotal::float AS subtotal
     FROM "OrderLine" ol
     JOIN "Order" o ON o.id = ol."orderId"
     LEFT JOIN "ProductSaleUom" psu ON psu."productId" = ol."productId" AND psu."uomId" = ol."uomId"
     WHERE o.status::text IN (${SALES_STATUS_SQL})
       AND ${DATE_EXPR} >= $1::timestamp AND ${DATE_EXPR} < $2::timestamp
       AND ol."isGift" = false
       ${extraWhere}
     ORDER BY ${DATE_EXPR} DESC, o."restaurantName", ol."productName"
     LIMIT ${DETAIL_ROW_LIMIT + 1}`,
    ...params,
  )) as Array<{
    order_date: string; customer_name: string; product_name: string
    uom_name: string | null
    unit_price: number; qty: number; subtotal: number
  }>

  const truncated = rows.length > DETAIL_ROW_LIMIT
  const limited = truncated ? rows.slice(0, DETAIL_ROW_LIMIT) : rows

  return {
    truncated,
    rows: limited.map((r) => ({
      orderDate: r.order_date,
      customerName: r.customer_name,
      productName: r.product_name,
      // 单位与单据上同口径：历史行落的 'Unit(s)'/空值统一显示成 ⚠ Unit(s)（见 lib/sale-uom.ts）
      uomName: displayUomName(r.uom_name),
      unitPrice: Math.round(r.unit_price * 100) / 100,
      qty: Math.round(r.qty * 1000) / 1000,
      subtotal: Math.round(r.subtotal * 100) / 100,
    })),
  }
}
