import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { SALES_COUNTED_STATUSES, TURNOVER_WINDOW_DAYS, resolveDateRange } from '@/lib/analytics/metrics'

/**
 * /api/analytics/procurement — 采购运营分析
 * ============================================================================
 * GET ?from&to
 * 返回：
 *   summary     期内采购额（税前）/ PO 数 / 供应商数
 *   bySupplier  按供应商：采购额、PO 数、到货满足率（receivedQty/orderedQty）
 *   priceTrends 采购额 TOP 20 商品的进价走势（最新价 vs 前一次 vs 期内最低/最高）
 *   turnover    库存周转：qtyOnHand ÷ 日均销量（近 30 天），慢周转 TOP 20
 *   scrap       期内损耗（SCRAP + 盘亏）：合计 + 按商品 TOP 10
 * PO 时间口径：COALESCE(confirmedAt, orderDate)，只算 CONFIRMED 及之后状态。
 */

const PO_COUNTED = `'CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED'`
const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const bySupplier = (await p.$queryRawUnsafe(
        `SELECT po."supplierId" AS supplier_id,
                COALESCE(MAX(s.name), po."supplierId") AS supplier_name,
                COUNT(DISTINCT po.id)::int AS po_count,
                SUM(pol."subtotalExTax")::float AS amount_ex,
                SUM(pol."orderedQty")::float AS ordered_qty,
                SUM(pol."receivedQty")::float AS received_qty
         FROM "PurchaseOrderLine" pol
         JOIN "PurchaseOrder" po ON po.id = pol."purchaseOrderId"
         LEFT JOIN "Customer" s ON s.id = po."supplierId"
         WHERE po.status::text IN (${PO_COUNTED})
           AND COALESCE(po."confirmedAt", po."orderDate") >= $1
           AND COALESCE(po."confirmedAt", po."orderDate") < $2
         GROUP BY po."supplierId"
         ORDER BY SUM(pol."subtotalExTax") DESC`,
        start, end,
      )) as Array<{
        supplier_id: string; supplier_name: string; po_count: number
        amount_ex: number; ordered_qty: number; received_qty: number
      }>

      // 进价走势：期内采购额 TOP 20 商品，取每次 PO 行价格点
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
           LIMIT 20
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
        start, end,
      )) as Array<{
        product_id: string; product_name: string; po_date: Date
        supplier_name: string; unit_cost: number
      }>

      const round2 = (n: number) => Math.round(n * 100) / 100
      const trendMap = new Map<string, {
        productId: string; productName: string
        points: Array<{ date: Date; cost: number; supplier: string }>
      }>()
      for (const pt of pricePoints) {
        let t = trendMap.get(pt.product_id)
        if (!t) {
          t = { productId: pt.product_id, productName: pt.product_name, points: [] }
          trendMap.set(pt.product_id, t)
        }
        t.points.push({ date: pt.po_date, cost: pt.unit_cost, supplier: pt.supplier_name })
      }
      const priceTrends = [...trendMap.values()].map((t) => {
        const costs = t.points.map((x) => x.cost)
        const latest = t.points[t.points.length - 1]
        const prev = t.points.length > 1 ? t.points[t.points.length - 2] : null
        return {
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
        }
      }).sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))

      // 库存周转：qtyOnHand ÷ 日均销量（近 TURNOVER_WINDOW_DAYS 天），慢周转 TOP 20
      const turnover = (await p.$queryRawUnsafe(
        `WITH sold AS (
           SELECT ol."productId" AS product_id,
                  SUM(ol."orderedQty")::float / ${TURNOVER_WINDOW_DAYS} AS daily_qty
           FROM "OrderLine" ol
           JOIN "Order" o ON o.id = ol."orderId"
           WHERE o.status::text IN (${SALES_STATUS_SQL})
             AND o."confirmationDate" >= NOW() - INTERVAL '${TURNOVER_WINDOW_DAYS} days'
           GROUP BY ol."productId"
         )
         SELECT p.id AS product_id, p.name AS product_name, p.spec,
                p."qtyOnHand"::float AS qty_on_hand,
                COALESCE(sold.daily_qty, 0) AS daily_qty,
                CASE WHEN COALESCE(sold.daily_qty, 0) > 0
                     THEN p."qtyOnHand"::float / sold.daily_qty
                     ELSE NULL END AS days
         FROM "Product" p
         LEFT JOIN sold ON sold.product_id = p.id
         WHERE p.active = true AND p.status = 'ACTIVE' AND p."qtyOnHand" > 0
         ORDER BY days DESC NULLS FIRST
         LIMIT 20`,
      )) as Array<{
        product_id: string; product_name: string; spec: string | null
        qty_on_hand: number; daily_qty: number; days: number | null
      }>

      // 损耗：SCRAP + 盘亏，按商品
      const scrapRows = (await p.$queryRawUnsafe(
        `SELECT sm."productId" AS product_id, MAX(sm."productName") AS product_name,
                SUM(ABS(sm.qty))::float AS qty,
                SUM(ABS(sm.qty) * COALESCE(l."unitCost", p."standardPrice", pt."standardPrice", 0))::float AS amount
         FROM "StockMove" sm
         LEFT JOIN "Lot" l ON l.id = sm."lotId"
         LEFT JOIN "Product" p ON p.id = sm."productId"
         LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
         WHERE sm."movedAt" >= $1 AND sm."movedAt" < $2
           AND (sm.type = 'SCRAP' OR (sm.type = 'ADJUSTMENT' AND sm."sourceType" = 'STOCK_TAKE' AND sm.qty < 0))
         GROUP BY sm."productId"
         ORDER BY SUM(ABS(sm.qty) * COALESCE(l."unitCost", p."standardPrice", pt."standardPrice", 0)) DESC
         LIMIT 10`,
        start, end,
      )) as Array<{ product_id: string; product_name: string; qty: number; amount: number }>

      const totalAmount = bySupplier.reduce((s, r) => s + r.amount_ex, 0)
      return NextResponse.json(serializeApi({
        summary: {
          purchaseExTax: round2(totalAmount),
          poCount: bySupplier.reduce((s, r) => s + r.po_count, 0),
          supplierCount: bySupplier.length,
          scrapAmount: round2(scrapRows.reduce((s, r) => s + r.amount, 0)),
        },
        bySupplier: bySupplier.map((r) => ({
          supplierId: r.supplier_id,
          supplierName: r.supplier_name,
          poCount: r.po_count,
          amountExTax: round2(r.amount_ex),
          fulfillmentRate: r.ordered_qty > 0 ? Math.round((r.received_qty / r.ordered_qty) * 10000) / 10000 : null,
        })),
        priceTrends,
        turnover: turnover.map((r) => ({
          productId: r.product_id,
          productName: r.spec ? `${r.product_name} (${r.spec})` : r.product_name,
          qtyOnHand: r.qty_on_hand,
          dailyQty: Math.round(r.daily_qty * 100) / 100,
          days: r.days === null ? null : Math.round(r.days * 10) / 10,
        })),
        scrap: scrapRows.map((r) => ({
          productId: r.product_id, productName: r.product_name,
          qty: r.qty, amount: round2(r.amount),
        })),
      }))
    } catch (error) {
      console.error('[GET /api/analytics/procurement]', error)
      return NextResponse.json({ error: '获取采购分析失败' }, { status: 500 })
    }
  }, ['BOSS', 'OPERATOR'])
}
