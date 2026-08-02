import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { buildFacetWhere } from '@/lib/facet-sql'
import { PURCHASE_ORDER_FACET_DEFS } from '@/lib/facets/purchase-orders'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { createPurchaseOrder } from '@/lib/create-purchase-order'

/**
 * /api/purchase-orders
 * ============================================================================
 * 采购订单（Odoo purchase.order）
 *
 * GET  → 列表（支持 supplierId / status / 分页）
 * POST → 新建 RFQ / DRAFT 订单。金额由服务端重算。
 *
 * 工作流：
 *   DRAFT(RFQ) → SENT → CONFIRMED → RECEIVED（通过 GoodsReceipt）→ INVOICED（通过 VendorBill）
 *   任何阶段都可以 CANCELLED（除 RECEIVED 后不建议再撤）
 */

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const supplierId = searchParams.get('supplierId')
    const status = searchParams.get('status')?.toUpperCase()
    // 上限从 500 提到 5000：采购单量远小于销售单，之前的 500 上限在"全部"视图里会随采购单
    // 增多悄悄丢掉更早的历史数据（正确性问题，不只是性能问题），见 docs/20260717-odoo-single-source-migration-plan.md 第四节
    const limit = Math.min(5000, Math.max(1, parseInt(searchParams.get('limit') ?? '200', 10)))

    const where: Record<string, unknown> = {}
    if (supplierId) where.supplierId = supplierId
    if (status) where.status = status

    // 分面搜索：同维度 OR、跨维度 AND
    const facetClauses = await buildFacetWhere(searchParams, PURCHASE_ORDER_FACET_DEFS)
    if (facetClauses.length > 0) where.AND = facetClauses

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const rows = await p.purchaseOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { lines: true },
    })

    // 补全 supplierName —— PurchaseOrder 只存 supplierId，需要从 Customer 表查名字
    const supplierIds = [...new Set(rows.map((r: { supplierId: string }) => r.supplierId).filter(Boolean))]
    const suppliers = supplierIds.length > 0
      ? await p.customer.findMany({
          where: { id: { in: supplierIds } },
          select: { id: true, name: true },
        })
      : []
    const supplierMap = new Map(suppliers.map((s: { id: string; name: string }) => [s.id, s.name]))

    const enriched = rows.map((r: Record<string, unknown>) => ({
      ...r,
      supplierName: supplierMap.get(r.supplierId as string) ?? r.supplierId,
    }))

    return NextResponse.json(serializeApi(enriched))
  } catch (error) {
    console.error('[GET /api/purchase-orders]', error)
    return NextResponse.json({ error: '获取采购订单失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const po = await p.$transaction((tx: typeof p) => createPurchaseOrder(tx, {
        supplierId: String(data.supplierId ?? ''),
        lines: Array.isArray(data.lines) ? data.lines : [],
        orderDate: data.orderDate ?? null,
        expectedDate: data.expectedDate ?? null,
        currency: data.currency,
        exchangeRate: data.exchangeRate ?? null,
        freightAmount: data.freightAmount ?? null,
        sourceDocumentUrl: data.sourceDocumentUrl ?? null,
        sourceDocumentName: data.sourceDocumentName ?? null,
        notes: data.notes ?? null,
        createdBy: user.userId,
      }))

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'purchase_order', resourceId: po.id,
        detail: `创建采购订单 ${po.name}, 金额 €${Number(po.totalIncTax)}`,
      })

      return NextResponse.json(serializeApi(po), { status: 201 })
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: err.status })
      }
      console.error('[POST /api/purchase-orders]', error)
      return NextResponse.json({ error: '创建采购订单失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'WAREHOUSE'])
}
