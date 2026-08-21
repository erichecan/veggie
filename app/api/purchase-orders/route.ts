import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { buildPurchaseOrdersWhere } from '@/lib/purchase-orders-query'
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
    // 之前这里只有 take，没有 skip/count —— 列表页(purchases/page.tsx)传的 offset 被静默
    // 无视，翻页永远拿到同一批最新的 limit 条，totalPages 也是按"返回了多少条"算的假值。
    // 上限从 500→5000 那次是拿"一次性多拿点"顶替"全部"视图的真分页；现在有了真分页(skip+count)，
    // 这个顶替不再需要，单页上限收回到合理值。
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') ?? '200', 10)))
    const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10))

    // 筛选口径抽在 lib/purchase-orders-query.ts，导出路由用同一个函数
    const where = await buildPurchaseOrdersWhere(searchParams)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const [rows, total] = await Promise.all([
      p.purchaseOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: { lines: true },
      }),
      p.purchaseOrder.count({ where }),
    ])

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

    return NextResponse.json(serializeApi({ items: enriched, total }))
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
  }, { require: 'purchase.order.create' })
}
