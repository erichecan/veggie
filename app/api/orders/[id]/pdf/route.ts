import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { formatDriverSlotFromOrder } from '@/lib/driver-slot'
import { getOrderWaveDisplayMap } from '@/lib/wave-assign'
import { renderOrderHtml, type OrderDocInput } from '@/lib/order-pdf'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { sequence: 'asc' } },
        driverSlot: { select: { id: true, batchNum: true, timeOfDay: true, driverName: true } },
        salesUser: { select: { id: true, name: true } },
      },
    })
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

    const customer = order.restaurantId
      ? await prisma.customer.findUnique({ where: { id: order.restaurantId } })
      : null

    // SSOT(P0-1): 司机归属以所属 wave 派生为准,Order.driverSlotId 只是下单意向列——
    // 调度台拖拽改派只写 wave.orderIds,不回写 order.driverSlotId,直接读会印出旧司机。
    const waveDisplay = await getOrderWaveDisplayMap([order.id])
    const deliveryBatch = formatDriverSlotFromOrder({
      ...(order as unknown as { driverSlot?: { id: string; batchNum: number; timeOfDay: string; driverName: string } | null; deliveryBatch?: string | null }),
      deliveryBatchDisplay: waveDisplay[order.id] ?? null,
    })

    // 单据模板抽在 lib/order-pdf.ts —— 发邮件时要拿同一份当 PDF 附件，
    // 留在这里的话邮件那边只能复制一份，两份日后必然各改各的。
    const html = renderOrderHtml(order as unknown as OrderDocInput, customer, deliveryBatch)

    return new NextResponse(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  } catch (error) {
    console.error('[GET /api/orders/[id]/pdf]', error)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
