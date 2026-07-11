import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { toNum } from '@/lib/decimal-helpers'

/**
 * GET /api/products/[id]/price-history?supplierId=xxx
 * ============================================================================
 * 采购单新建页"查看价格历史"弹窗数据源：最近一次成交价 + 最近 10 次走势。
 *
 * 按（商品+供应商）区分——同一款菜不同供应商价格分开看。
 * 合并两个历史来源（都是只读查询，不产生新的数据所有权分裂）：
 *   - PurchaseRecord：Odoo 导入的历史采购记录，此后不再写入
 *   - PurchaseOrderLine（经 PurchaseOrder 拿 supplierId/orderDate）：新采购单流程的实时 SSOT
 * 不这样合并的话，切到新流程后价格历史会突然"断更"。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: productId } = await params
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const supplierId = searchParams.get('supplierId')?.trim() || null

      const recordWhere: Record<string, unknown> = { productId }
      if (supplierId) recordWhere.supplierId = supplierId

      const [records, lines] = await Promise.all([
        prisma.purchaseRecord.findMany({
          where: recordWhere,
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { unitCost: true, arrivedAt: true, createdAt: true, supplier: true },
        }),
        prisma.purchaseOrderLine.findMany({
          where: {
            productId,
            purchaseOrder: supplierId ? { supplierId } : undefined,
          },
          orderBy: { purchaseOrder: { orderDate: 'desc' } },
          take: 10,
          select: {
            unitCost: true,
            purchaseOrder: { select: { orderDate: true, name: true } },
          },
        }),
      ])

      const merged = [
        ...records.map((r) => ({
          date: r.arrivedAt || r.createdAt.toISOString(),
          unitCost: toNum(r.unitCost),
          source: r.supplier || '历史采购记录',
        })),
        ...lines.map((l) => ({
          date: l.purchaseOrder.orderDate.toISOString(),
          unitCost: toNum(l.unitCost),
          source: l.purchaseOrder.name,
        })),
      ]
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 10)

      return NextResponse.json({
        lastPrice: merged[0]?.unitCost ?? null,
        history: merged,
      })
    } catch (error) {
      console.error('[GET /api/products/[id]/price-history]', error)
      return NextResponse.json({ error: '获取价格历史失败' }, { status: 500 })
    }
  })
}
