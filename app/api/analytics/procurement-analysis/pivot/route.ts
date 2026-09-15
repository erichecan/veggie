import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { resolveDateRange, toNaiveTimestampParam } from '@/lib/analytics/metrics'
import { round2 } from '@/lib/decimal-helpers'
import { withCachedAuth } from '@/lib/analytics/cache'

/**
 * /api/analytics/procurement-analysis/pivot — 采购进货情况（20260915，需求5/7）
 * ============================================================================
 * GET ?from&to&supplierId=<单选>&productIds=<逗号多选>&groupBy=product|supplier（默认 product）
 * 需求5「某一家供货商进货情况」：传 supplierId，看这段时间该供应商的各商品数量/金额
 * 需求7「某几种产品进货情况」：传 productIds，看这几个商品的进货数量/金额（可跨供应商）
 * 两者可叠加。口径同 app/api/analytics/procurement/route.ts 的 bySupplier 查询
 * （PO 状态 CONFIRMED/RECEIVED/INVOICED/LOCKED，时间按 COALESCE(confirmedAt, orderDate)）。
 */

const PO_COUNTED = `'CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED'`

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

      const summary = {
        amountExTax: round2(rows.reduce((s, r) => s + r.amount_ex, 0)),
        taxAmount: round2(rows.reduce((s, r) => s + r.tax_amount, 0)),
        amountIncTax: round2(rows.reduce((s, r) => s + r.amount_inc, 0)),
        orderedQty: rows.reduce((s, r) => s + r.ordered_qty, 0),
      }

      return NextResponse.json(serializeApi({
        summary,
        groupBy,
        rows: rows.map((r) => ({
          key: r.row_key,
          name: r.row_name,
          poCount: r.po_count,
          orderedQty: Math.round(r.ordered_qty * 1000) / 1000,
          receivedQty: Math.round(r.received_qty * 1000) / 1000,
          amountExTax: round2(r.amount_ex),
          taxAmount: round2(r.tax_amount),
          amountIncTax: round2(r.amount_inc),
          avgUnitCost: r.ordered_qty > 0 ? round2(r.amount_ex / r.ordered_qty) : 0,
        })),
      }))
    } catch (error) {
      console.error('[GET /api/analytics/procurement-analysis/pivot]', error)
      return NextResponse.json({ error: '获取采购进货情况失败' }, { status: 500 })
    }
  }, { require: 'analytics.purchase_detail.read' })
}
