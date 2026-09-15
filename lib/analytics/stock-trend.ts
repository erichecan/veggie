import { prisma } from '@/lib/db'
import { SALES_COUNTED_STATUSES, toNaiveTimestampParam } from '@/lib/analytics/metrics'

/**
 * 库存 on-hand + 出货趋势（20260915，采购分析需求6：选定产品，按周/月展开，同时看
 * 当前口径的 on-hand 和"forecast"）。
 *
 * ⛔ forecast 口径（已跟用户确认，20260915）：这里的 forecast 不是真正的需求预测算法
 * （不做移动平均/线性回归），而是"该分桶的历史实际出货数量"——帮助判断囤货趋势，
 * 语义上更诚实。真预测算法留待以后有明确需求再做。
 *
 * on-hand 历史重建：StockMove.qty 带符号、净额恒等于 Product.qtyOnHand 的变化量
 * （见 schema.prisma StockMove 注释），所以任意历史时点 t 的 on-hand =
 * 当前 Product.qtyOnHand − Σ(StockMove.qty WHERE productId=P AND movedAt >= t)。
 * 只对调用方选中的少数产品重建（不会扫全表），bucket 数量也有限（周/月分桶），
 * 相关子查询在这个规模下可接受。
 */

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')
const STOCK_QTY_EXPR = `(ol."orderedQty" * COALESCE(psu.factor, 1))`

export type StockTrendGranularity = 'week' | 'month'

export interface StockTrendPoint {
  bucketStart: string
  bucketEnd: string
  onHand: number
  soldQty: number
}

export interface StockTrendProductSeries {
  productId: string
  productName: string
  points: StockTrendPoint[]
}

/** 白名单校验，granularity 直接拼进 SQL 文本前必须先过这一关 */
export function isValidGranularity(v: string): v is StockTrendGranularity {
  return v === 'week' || v === 'month'
}

export async function fetchStockTrend(
  start: Date,
  end: Date,
  productIds: string[],
  granularity: StockTrendGranularity,
): Promise<StockTrendProductSeries[]> {
  if (productIds.length === 0) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  const bucketUnit = granularity // 'week' | 'month'，已由调用方 isValidGranularity 校验

  const rows = (await p.$queryRawUnsafe(
    `WITH buckets AS (
       SELECT gs AS bucket_start, gs + interval '1 ${bucketUnit}' AS bucket_end
       FROM generate_series(
         date_trunc('${bucketUnit}', $1::timestamp),
         date_trunc('${bucketUnit}', $2::timestamp - interval '1 second'),
         interval '1 ${bucketUnit}'
       ) AS gs
     ),
     targets AS (
       SELECT id AS product_id, name AS product_name, "qtyOnHand"::float AS current_qty
       FROM "Product" WHERE id = ANY($3::text[])
     )
     SELECT t.product_id, t.product_name,
            to_char(b.bucket_start, 'YYYY-MM-DD') AS bucket_start,
            to_char(b.bucket_end, 'YYYY-MM-DD') AS bucket_end,
            (t.current_qty - COALESCE((
              SELECT SUM(sm.qty) FROM "StockMove" sm
              WHERE sm."productId" = t.product_id AND sm."movedAt" >= b.bucket_end
            ), 0))::float AS on_hand_at_bucket_end,
            COALESCE((
              SELECT SUM(${STOCK_QTY_EXPR})
              FROM "OrderLine" ol
              JOIN "Order" o ON o.id = ol."orderId"
              LEFT JOIN "ProductSaleUom" psu ON psu."productId" = ol."productId" AND psu."uomId" = ol."uomId"
              WHERE ol."productId" = t.product_id
                AND o.status::text IN (${SALES_STATUS_SQL})
                AND ol."isGift" = false
                AND o."confirmationDate" >= b.bucket_start AND o."confirmationDate" < b.bucket_end
            ), 0)::float AS sold_qty
     FROM targets t CROSS JOIN buckets b
     ORDER BY t.product_id, b.bucket_start`,
    toNaiveTimestampParam(start), toNaiveTimestampParam(end), productIds,
  )) as Array<{
    product_id: string; product_name: string
    bucket_start: string; bucket_end: string
    on_hand_at_bucket_end: number; sold_qty: number
  }>

  const byProduct = new Map<string, StockTrendProductSeries>()
  for (const r of rows) {
    let series = byProduct.get(r.product_id)
    if (!series) {
      series = { productId: r.product_id, productName: r.product_name, points: [] }
      byProduct.set(r.product_id, series)
    }
    series.points.push({
      bucketStart: r.bucket_start,
      bucketEnd: r.bucket_end,
      onHand: Math.round(r.on_hand_at_bucket_end * 1000) / 1000,
      soldQty: Math.round(r.sold_qty * 1000) / 1000,
    })
  }
  // 按 productIds 传入顺序返回，前端筛选器选了哪几个就按那个顺序显示
  return productIds.map((id) => byProduct.get(id)).filter((v): v is StockTrendProductSeries => !!v)
}
