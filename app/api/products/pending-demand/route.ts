import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'

/**
 * 聚合"尚未反映在 qtyOnHand 里"的需求量，前端用来计算"可承诺量" = qtyOnHand - pendingDemand。
 *
 * ⛔ 只能统计 PENDING（草稿/未确认）订单。CONFIRMED/WAVE_ASSIGNED/IN_DELIVERY 的数量
 * 在订单确认那一刻已经从 qtyOnHand 里扣减过了（见 orders/[id]/route.ts 的 CONFIRMED 分支），
 * 若在这里再次计入会造成双重扣减——同一份已确认库存被减两次，ATP 显示的可用量比实际低一倍。
 * 这正是 /api/products/forecast 里 outboundReserved 特意排除 CONFIRMED 的同一个坑
 * （20260904 排查 forecast 死字段时顺带发现这里还留着旧逻辑）。
 */
export async function GET() {
  try {
    const pendingStatuses = ['PENDING']

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
