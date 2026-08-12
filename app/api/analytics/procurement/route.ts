import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { SALES_COUNTED_STATUSES, TURNOVER_WINDOW_DAYS, resolveDateRange } from '@/lib/analytics/metrics'
import { getTopProductPriceTrends } from '@/lib/analytics/price-trend'
import { round2 } from '@/lib/decimal-helpers'
import { withCachedAuth } from '@/lib/analytics/cache'
import { summarizeOnTime, type PoArrivalRow } from '@/lib/receipt-linkage'

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

/** 多单位销售(20260714)：换算逻辑同 analytics/margin/route.ts 的 STOCK_QTY_EXPR，与 lib/inventory.ts toStockQty 一致 */
const SOLD_STOCK_QTY_EXPR = `(CASE WHEN ol."uomId" IS NOT NULL AND ol."uomId" <> pt."uomId"
       AND line_uom.factor IS NOT NULL AND anchor_uom.factor IS NOT NULL AND anchor_uom.factor <> 0
       THEN ol."orderedQty" * (line_uom.factor / anchor_uom.factor)
       ELSE ol."orderedQty" END)`

export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
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

      // 到货准时率（台账 E7）：按供应商统计。口径 SSOT 在 lib/receipt-linkage.summarizeOnTime ——
      // 按收齐日对比预计到货日，且**只统计已收齐的单**；未收齐的单独进 pending，
      // 不进分母（否则一张永远收不齐的单会被静默算成「按期」，考核就成了粉饰）。
      const poArrivals = (await p.$queryRawUnsafe(
        `SELECT po."supplierId" AS supplier_id,
                po."expectedDate" AS expected_date,
                po."lastArrivedAt" AS last_arrived_at,
                BOOL_AND(COALESCE(pol."receivedQty", 0) >= COALESCE(pol."orderedQty", 0)) AS fully_received
         FROM "PurchaseOrder" po
         LEFT JOIN "PurchaseOrderLine" pol ON pol."purchaseOrderId" = po.id
         WHERE po.status::text IN (${PO_COUNTED})
           AND COALESCE(po."confirmedAt", po."orderDate") >= $1
           AND COALESCE(po."confirmedAt", po."orderDate") < $2
         GROUP BY po.id, po."supplierId", po."expectedDate", po."lastArrivedAt"`,
        start, end,
      )) as Array<{
        supplier_id: string; expected_date: Date | null
        last_arrived_at: Date | null; fully_received: boolean | null
      }>
      const arrivalsBySupplier = new Map<string, PoArrivalRow[]>()
      for (const r of poArrivals) {
        const list = arrivalsBySupplier.get(r.supplier_id) ?? []
        list.push({
          expectedDate: r.expected_date,
          lastArrivedAt: r.last_arrived_at,
          fullyReceived: r.fully_received === true,
        })
        arrivalsBySupplier.set(r.supplier_id, list)
      }

      // 进价走势：期内采购额 TOP 20 商品，取每次 PO 行价格点（口径 SSOT：lib/analytics/price-trend.ts）
      const priceTrends = await getTopProductPriceTrends(start, end, 20)

      // 库存周转：qtyOnHand ÷ 日均销量（近 TURNOVER_WINDOW_DAYS 天），慢周转 TOP 20
      const turnover = (await p.$queryRawUnsafe(
        `WITH sold AS (
           SELECT ol."productId" AS product_id,
                  SUM(${SOLD_STOCK_QTY_EXPR})::float / ${TURNOVER_WINDOW_DAYS} AS daily_qty
           FROM "OrderLine" ol
           JOIN "Order" o ON o.id = ol."orderId"
           LEFT JOIN "Product" sp ON sp.id = ol."productId"
           LEFT JOIN "ProductTemplate" pt ON pt.id = sp."templateId"
           LEFT JOIN "Uom" line_uom ON line_uom.id = ol."uomId"
           LEFT JOIN "Uom" anchor_uom ON anchor_uom.id = pt."uomId"
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
        bySupplier: bySupplier.map((r) => {
          const onTime = summarizeOnTime(arrivalsBySupplier.get(r.supplier_id) ?? [])
          return {
            supplierId: r.supplier_id,
            supplierName: r.supplier_name,
            poCount: r.po_count,
            amountExTax: round2(r.amount_ex),
            fulfillmentRate: r.ordered_qty > 0 ? Math.round((r.received_qty / r.ordered_qty) * 10000) / 10000 : null,
            // 准时率：rate 为 null 表示「没有可判定的单」（没填预计到货日或都没收齐），
            // 界面必须显示「—」而不是 0% —— 后者会被读成「这家从不准时」
            onTimeRate: onTime.rate,
            onTimeMeasured: onTime.measured,
            onTimeLate: onTime.late,
            onTimePending: onTime.pending,
            onTimeNoExpected: onTime.noExpected,
          }
        }),
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
  }, { require: 'analytics.purchase_detail.read' })
}
