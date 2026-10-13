import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { renderPurchaseOrdersBatchHtml } from '@/lib/purchase-order-pdf'
import { withProductSequence } from '@/lib/print/product-sequence'

/**
 * GET /api/purchase-orders/batch-pdf?ids=a,b,c —— 采购单列表批量打印(20261013)
 * 版面与单张 /api/purchase-orders/[id]/pdf 完全相同，一张一页，按勾选顺序输出。
 */
const MAX_IDS = 100

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const ids = [...new Set((new URL(req.url).searchParams.get('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean))]
      if (ids.length === 0) return NextResponse.json({ error: '未选择采购单' }, { status: 400 })
      if (ids.length > MAX_IDS) return NextResponse.json({ error: `一次最多打印 ${MAX_IDS} 张` }, { status: 400 })

      const pos = await prisma.purchaseOrder.findMany({
        where: { id: { in: ids } },
        include: { lines: { orderBy: { sequence: 'asc' } } },
      })
      const supplierIds = [...new Set(pos.map(p => p.supplierId))]
      const suppliers = await prisma.customer.findMany({ where: { id: { in: supplierIds } } })
      const supplierById = new Map(suppliers.map(s => [s.id, s]))
      const byId = new Map(pos.map(p => [p.id, p]))

      const items = []
      for (const id of ids) {
        const po = byId.get(id)
        if (!po) continue
        items.push({ po: { ...po, lines: await withProductSequence(po.lines) }, supplier: supplierById.get(po.supplierId) ?? null })
      }
      if (items.length === 0) return NextResponse.json({ error: '采购单不存在' }, { status: 404 })

      return new NextResponse(renderPurchaseOrdersBatchHtml(items), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    } catch (error) {
      console.error('[GET /api/purchase-orders/batch-pdf]', error)
      return NextResponse.json({ error: '批量打印失败' }, { status: 500 })
    }
  })
}
