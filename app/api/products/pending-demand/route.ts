import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'

/**
 * 聚合所有未出库订单（PENDING / CONFIRMED / WAVE_ASSIGNED）中每个商品的待履行需求量。
 * 返回 Record<productId, demandQty>，前端用来计算"可承诺量" = qtyOnHand - pendingDemand。
 */
export async function GET() {
  try {
    const pendingStatuses = ['PENDING', 'CONFIRMED', 'WAVE_ASSIGNED']

    const lines = await prisma.orderLine.groupBy({
      by: ['productId'],
      where: {
        order: { status: { in: pendingStatuses as never[] } },
      },
      _sum: { orderedQty: true },
    })

    const demand: Record<string, number> = {}
    for (const line of lines) {
      const qty = Number(line._sum.orderedQty ?? 0)
      if (qty > 0) demand[line.productId] = qty
    }

    return NextResponse.json(serializeApi(demand))
  } catch (error) {
    console.error('[GET /api/products/pending-demand]', error)
    return NextResponse.json({ error: '获取待履行需求失败' }, { status: 500 })
  }
}
