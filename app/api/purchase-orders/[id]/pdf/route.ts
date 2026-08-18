import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { renderPurchaseOrderHtml } from '@/lib/purchase-order-pdf'
import { withProductSequence } from '@/lib/print/product-sequence'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const po = await p.purchaseOrder.findUnique({
      where: { id },
      include: { lines: { orderBy: { sequence: 'asc' } } },
    })
    if (!po) return NextResponse.json({ error: '采购单不存在' }, { status: 404 })

    const supplier = await prisma.customer.findUnique({ where: { id: po.supplierId } })
    const html = renderPurchaseOrderHtml({ ...po, lines: await withProductSequence(po.lines) }, supplier)

    return new NextResponse(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  } catch (error) {
    console.error('[GET /api/purchase-orders/[id]/pdf]', error)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
