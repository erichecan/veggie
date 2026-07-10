import { prisma } from '@/lib/db'

/**
 * 商品进价环比 —— SSOT，从 app/api/analytics/procurement/route.ts 的"进价趋势"tab
 * 抽出来，供采购目录挑选页（超市/日韩）复用同一套"环比怎么算"的口径，避免两处各写一遍。
 *
 * 环比 = 按 PO 粒度取价格点（同一 PO 内同商品多行会 AVG 成一个点），按时间升序排列后
 * 比较最新一次 vs 前一次。只统计 CONFIRMED/RECEIVED/INVOICED/LOCKED 状态的 PO。
 */

const PO_COUNTED = `'CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED'`

export interface ProductPriceTrend {
  productId: string
  productName: string
  buys: number
  minCost: number
  maxCost: number
  latestCost: number
  latestSupplier: string
  latestDate: Date
  prevCost: number | null
  changePct: number | null
  /** 最近若干次价格点（按时间升序），供采购目录挑选页画迷你走势图用 */
  recentCosts: number[]
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function buildTrends(pricePoints: Array<{ product_id: string; product_name: string; po_date: Date; supplier_name: string; unit_cost: number }>, recentLimit = 8) {
  const trendMap = new Map<string, { productId: string; productName: string; points: Array<{ date: Date; cost: number; supplier: string }> }>()
  for (const pt of pricePoints) {
    let t = trendMap.get(pt.product_id)
    if (!t) {
      t = { productId: pt.product_id, productName: pt.product_name, points: [] }
      trendMap.set(pt.product_id, t)
    }
    t.points.push({ date: pt.po_date, cost: pt.unit_cost, supplier: pt.supplier_name })
  }
  const result = new Map<string, ProductPriceTrend>()
  for (const t of trendMap.values()) {
    const costs = t.points.map(x => x.cost)
    const latest = t.points[t.points.length - 1]
    const prev = t.points.length > 1 ? t.points[t.points.length - 2] : null
    result.set(t.productId, {
      productId: t.productId,
      productName: t.productName,
      buys: t.points.length,
      minCost: round2(Math.min(...costs)),
      maxCost: round2(Math.max(...costs)),
      latestCost: round2(latest.cost),
      latestSupplier: latest.supplier,
      latestDate: latest.date,
      prevCost: prev ? round2(prev.cost) : null,
      changePct: prev && prev.cost > 0 ? round2(((latest.cost - prev.cost) / prev.cost) * 100) : null,
      recentCosts: costs.slice(-recentLimit).map(round2),
    })
  }
  return result
}

/**
 * 按 productId 列表查进价环比（不限时间窗口，取该商品全部历史采购里的最后两个价格点）。
 * 用于采购目录挑选页：给列表里每个商品挂一个"进价环比"标签。
 */
export async function getProductPriceTrendsByIds(productIds: string[]): Promise<Map<string, ProductPriceTrend>> {
  if (productIds.length === 0) return new Map()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  const pricePoints = (await p.$queryRawUnsafe(
    `SELECT pol."productId" AS product_id,
            MAX(pol."productName") AS product_name,
            COALESCE(po."confirmedAt", po."orderDate") AS po_date,
            COALESCE(MAX(s.name), '') AS supplier_name,
            AVG(pol."unitCost")::float AS unit_cost
     FROM "PurchaseOrderLine" pol
     JOIN "PurchaseOrder" po ON po.id = pol."purchaseOrderId"
     LEFT JOIN "Customer" s ON s.id = po."supplierId"
     WHERE po.status::text IN (${PO_COUNTED})
       AND pol."productId" = ANY($1)
     GROUP BY pol."productId", COALESCE(po."confirmedAt", po."orderDate"), po.id
     ORDER BY pol."productId", po_date ASC`,
    productIds,
  )) as Array<{ product_id: string; product_name: string; po_date: Date; supplier_name: string; unit_cost: number }>

  return buildTrends(pricePoints)
}

/**
 * 期内采购额 TOP N 商品的进价走势（原 /api/analytics/procurement 用法，时间窗口限定）。
 */
export async function getTopProductPriceTrends(start: Date, end: Date, topN = 20): Promise<ProductPriceTrend[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  const pricePoints = (await p.$queryRawUnsafe(
    `WITH top_products AS (
       SELECT pol."productId" AS product_id, SUM(pol."subtotalExTax") AS amt
       FROM "PurchaseOrderLine" pol
       JOIN "PurchaseOrder" po ON po.id = pol."purchaseOrderId"
       WHERE po.status::text IN (${PO_COUNTED})
         AND COALESCE(po."confirmedAt", po."orderDate") >= $1
         AND COALESCE(po."confirmedAt", po."orderDate") < $2
       GROUP BY pol."productId"
       ORDER BY SUM(pol."subtotalExTax") DESC
       LIMIT $3
     )
     SELECT pol."productId" AS product_id,
            MAX(pol."productName") AS product_name,
            COALESCE(po."confirmedAt", po."orderDate") AS po_date,
            COALESCE(MAX(s.name), '') AS supplier_name,
            AVG(pol."unitCost")::float AS unit_cost
     FROM "PurchaseOrderLine" pol
     JOIN "PurchaseOrder" po ON po.id = pol."purchaseOrderId"
     LEFT JOIN "Customer" s ON s.id = po."supplierId"
     JOIN top_products tp ON tp.product_id = pol."productId"
     WHERE po.status::text IN (${PO_COUNTED})
       AND COALESCE(po."confirmedAt", po."orderDate") >= $1
       AND COALESCE(po."confirmedAt", po."orderDate") < $2
     GROUP BY pol."productId", COALESCE(po."confirmedAt", po."orderDate"), po.id
     ORDER BY pol."productId", po_date ASC`,
    start, end, topN,
  )) as Array<{ product_id: string; product_name: string; po_date: Date; supplier_name: string; unit_cost: number }>

  return [...buildTrends(pricePoints).values()].sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))
}
