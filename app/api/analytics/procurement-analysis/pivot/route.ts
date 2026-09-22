import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { resolveDateRange, toNaiveTimestampParam, SALES_COUNTED_STATUSES } from '@/lib/analytics/metrics'
import { round2 } from '@/lib/decimal-helpers'
import { withCachedAuth } from '@/lib/analytics/cache'

/**
 * /api/analytics/procurement-analysis/pivot — 进销对比分析（20260915 需求5/7，20260922 加销售/毛利列）
 * ============================================================================
 * GET ?from&to&supplierId=<单选>&productIds=<逗号多选>&groupBy=product|supplier（默认 product）
 * 需求5「某一家供货商进货情况」：传 supplierId，看这段时间该供应商的各商品数量/金额
 * 需求7「某几种产品进货情况」：传 productIds，看这几个商品的进货数量/金额（可跨供应商）
 * 两者可叠加。采购口径同 app/api/analytics/procurement/route.ts 的 bySupplier 查询
 * （PO 状态 CONFIRMED/RECEIVED/INVOICED/LOCKED，时间按 COALESCE(confirmedAt, orderDate)）。
 *
 * 20260922：客户在毛利分析页截图批注加需求——"某时间段/某几个产品/进货数量/购进金额/
 * 销售数量/销售额/毛利，excel输出"。决定不改毛利分析（那是纯销售侧口径），而是在这个
 * 已经支持"时间段+多选产品+进货数量/金额"的页面上补销售侧三列，两条口径拼成一行。
 * 只在 groupBy=product 时才拼——按供应商维度里"毛利"没有意义（一个供应商供多个商品，
 * 采购价与该商品的销售价不是一一对应关系），保持原样不动。
 * 毛利成本口径与 app/api/analytics/margin/route.ts 完全一致（批次成本优先→标准成本兜底），
 * 不直接拿本次统计到的"购进金额"当成本——进货量与销售量在同一时间段内经常对不上
 * （比如这段时间没进货、纯卖库存），拿购进金额当成本会把毛利算错。
 */

const PO_COUNTED = `'CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED'`
const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      const supplierId = searchParams.get('supplierId')
      const productIds = searchParams.get('productIds')?.split(',').filter(Boolean)
      const groupBy = searchParams.get('groupBy') === 'supplier' ? 'supplier' : 'product'

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const params: unknown[] = [toNaiveTimestampParam(start), toNaiveTimestampParam(end)]
      const filters: string[] = []
      if (supplierId) { params.push(supplierId); filters.push(`po."supplierId" = $${params.length}`) }
      if (productIds?.length) { params.push(productIds); filters.push(`pol."productId" = ANY($${params.length}::text[])`) }
      const extraWhere = filters.length ? ` AND ${filters.join(' AND ')}` : ''

      const groupKeyExpr = groupBy === 'supplier' ? `po."supplierId"` : `pol."productId"`
      const groupNameExpr = groupBy === 'supplier' ? `MAX(COALESCE(s.name, po."supplierId"))` : `MAX(pol."productName")`

      const rows = (await p.$queryRawUnsafe(
        `SELECT ${groupKeyExpr} AS row_key,
                ${groupNameExpr} AS row_name,
                COUNT(DISTINCT po.id)::int AS po_count,
                SUM(pol."orderedQty")::float AS ordered_qty,
                SUM(pol."receivedQty")::float AS received_qty,
                SUM(pol."subtotalExTax")::float AS amount_ex,
                SUM(pol."taxAmount")::float AS tax_amount,
                SUM(pol."subtotalIncTax")::float AS amount_inc
         FROM "PurchaseOrderLine" pol
         JOIN "PurchaseOrder" po ON po.id = pol."purchaseOrderId"
         LEFT JOIN "Customer" s ON s.id = po."supplierId"
         WHERE po.status::text IN (${PO_COUNTED})
           AND COALESCE(po."confirmedAt", po."orderDate") >= $1::timestamp
           AND COALESCE(po."confirmedAt", po."orderDate") < $2::timestamp
           ${extraWhere}
         GROUP BY ${groupKeyExpr}
         ORDER BY SUM(pol."subtotalExTax") DESC`,
        ...params,
      )) as Array<{
        row_key: string; row_name: string; po_count: number
        ordered_qty: number; received_qty: number
        amount_ex: number; tax_amount: number; amount_inc: number
      }>

      // 20260922：groupBy=product 时补销售侧聚合，按 productId 跟采购行拼成一行。
      // 用同一段 [from,to] 时间窗，但状态/日期口径换成销售侧的 SALES_COUNTED_STATUSES +
      // confirmationDate（与毛利分析默认口径一致）。
      //
      // ⛔ code review 20260922 抓到的 bug：products 过滤原来只传 productIds，没传
      // supplierId ——用户只选供应商、不选具体产品时（页面这两个筛选本来就能独立用），
      // purchase 那一半正确按供应商过滤了，销售那一半却把全公司所有产品的销售額都
      // 算了进来，供应商筛选对销售/毛利列形同虚设。修法：supplierId 有值时，销售侧
      // 产品范围收窄成"这段时间从该供应商实际采购过的产品"（即 rows 已经算出来的
      // row_key 集合），而不是不筛。
      let salesMap = new Map<string, { name: string; qty: number; amount: number; grossProfit: number }>()
      // supplierId 有值但该供应商这段时间没有任何采购记录（rows 为空）时，scopedProductIds
      // 会是空数组——跳过查询：SQL 层 ANY(空数组) 本来就返回空集，不查省一次往返。
      const scopedProductIds = supplierId ? rows.map((r) => r.row_key) : (productIds ?? [])
      if (groupBy === 'product' && !(supplierId && scopedProductIds.length === 0)) {
        const salesParams: unknown[] = [toNaiveTimestampParam(start), toNaiveTimestampParam(end)]
        let salesProductFilter = ''
        if (scopedProductIds?.length) { salesParams.push(scopedProductIds); salesProductFilter = `AND ol."productId" = ANY($${salesParams.length}::text[])` }

        const salesRows = (await p.$queryRawUnsafe(
          `SELECT ol."productId" AS product_id,
                  MAX(ol."productName") AS product_name,
                  SUM(ol."orderedQty" * COALESCE(psu.factor, 1))::float AS sales_qty,
                  SUM(ol.subtotal)::float AS sales_amount,
                  SUM(ol.subtotal - COALESCE(lc.unit_cost, p."standardPrice", 0) * (ol."orderedQty" * COALESCE(psu.factor, 1)))::float AS gross_profit
           FROM "OrderLine" ol
           JOIN "Order" o ON o.id = ol."orderId"
           LEFT JOIN "Product" p ON p.id = ol."productId"
           LEFT JOIN "ProductSaleUom" psu ON psu."productId" = ol."productId" AND psu."uomId" = ol."uomId"
           LEFT JOIN LATERAL (
             SELECT c.unit_cost FROM v_lot_daily_cost c
             WHERE c.product_id = ol."productId"
               AND c.cost_date <= COALESCE(o."confirmationDate", o."createdAt")::date
             ORDER BY c.cost_date DESC LIMIT 1
           ) lc ON TRUE
           WHERE o.status::text IN (${SALES_STATUS_SQL})
             AND o."confirmationDate" >= $1::timestamp AND o."confirmationDate" < $2::timestamp
             AND ol."isGift" = false
             ${salesProductFilter}
           GROUP BY ol."productId"`,
          ...salesParams,
        )) as Array<{ product_id: string; product_name: string; sales_qty: number; sales_amount: number; gross_profit: number }>

        salesMap = new Map(salesRows.map((r) => [r.product_id, {
          name: r.product_name,
          qty: r.sales_qty,
          amount: r.sales_amount,
          grossProfit: r.gross_profit,
        }]))
      }

      const summary = {
        amountExTax: round2(rows.reduce((s, r) => s + r.amount_ex, 0)),
        taxAmount: round2(rows.reduce((s, r) => s + r.tax_amount, 0)),
        amountIncTax: round2(rows.reduce((s, r) => s + r.amount_inc, 0)),
        orderedQty: rows.reduce((s, r) => s + r.ordered_qty, 0),
        ...(groupBy === 'product' ? {
          salesQty: Array.from(salesMap.values()).reduce((s, v) => s + v.qty, 0),
          salesAmount: round2(Array.from(salesMap.values()).reduce((s, v) => s + v.amount, 0)),
          grossProfit: round2(Array.from(salesMap.values()).reduce((s, v) => s + v.grossProfit, 0)),
        } : {}),
      }

      const purchaseKeys = new Set(rows.map((r) => r.row_key))
      const mergedRows = rows.map((r) => {
        const sales = salesMap.get(r.row_key)
        return {
          key: r.row_key,
          name: r.row_name,
          poCount: r.po_count,
          orderedQty: Math.round(r.ordered_qty * 1000) / 1000,
          receivedQty: Math.round(r.received_qty * 1000) / 1000,
          amountExTax: round2(r.amount_ex),
          taxAmount: round2(r.tax_amount),
          amountIncTax: round2(r.amount_inc),
          avgUnitCost: r.ordered_qty > 0 ? round2(r.amount_ex / r.ordered_qty) : 0,
          ...(groupBy === 'product' ? {
            salesQty: Math.round((sales?.qty ?? 0) * 1000) / 1000,
            salesAmount: round2(sales?.amount ?? 0),
            grossProfit: round2(sales?.grossProfit ?? 0),
          } : {}),
        }
      })
      // 20260922：产品在这段时间只卖了没进货（该期间纯卖库存）时，采购查询里没有这一行，
      // 不能漏掉——否则客户选的产品里"只卖没买"的那部分会从报表里静默消失。
      const salesOnlyRows = groupBy === 'product'
        ? Array.from(salesMap.entries())
            .filter(([productId]) => !purchaseKeys.has(productId))
            .map(([productId, sales]) => ({
              key: productId,
              name: sales.name,
              poCount: 0,
              orderedQty: 0,
              receivedQty: 0,
              amountExTax: 0,
              taxAmount: 0,
              amountIncTax: 0,
              avgUnitCost: 0,
              salesQty: Math.round(sales.qty * 1000) / 1000,
              salesAmount: round2(sales.amount),
              grossProfit: round2(sales.grossProfit),
            }))
        : []

      return NextResponse.json(serializeApi({
        summary,
        groupBy,
        rows: [...mergedRows, ...salesOnlyRows],
      }))
    } catch (error) {
      console.error('[GET /api/analytics/procurement-analysis/pivot]', error)
      return NextResponse.json({ error: '获取采购进货情况失败' }, { status: 500 })
    }
  }, { require: 'analytics.purchase_detail.read' })
}
