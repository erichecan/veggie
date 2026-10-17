import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'

/**
 * PUT /api/goods-receipts/[id]
 * ============================================================================
 * 订正一张已录入的收货单的到货日期（仓库手填错日期后的更正入口，20261016）。
 * 只改 arrivedAt，不动 lines/qc/photos —— 那些是「当时实际看到的」，不该被事后改写；
 * 日期录错是纯粹的操作失误，允许订正。
 *
 * body: { arrivedAt: string }
 *
 * 改完必须在同一事务里按 PO 下全部收货单重新取 min/max 回写
 * firstArrivedAt/lastArrivedAt —— 和 POST 创建时的口径（台账 E7）完全一致，
 * 否则订正会把「首次到货/末次到货」改成跟实际收货单不一致的野值。
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const data = await req.json()
      const arrivedAtRaw = data.arrivedAt
      if (!arrivedAtRaw) return NextResponse.json({ error: 'arrivedAt 必填' }, { status: 400 })
      const arrivedAt = new Date(arrivedAtRaw)
      if (Number.isNaN(arrivedAt.getTime())) return NextResponse.json({ error: 'arrivedAt 不是有效日期' }, { status: 400 })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const existing = await p.goodsReceipt.findUnique({ where: { id } })
      if (!existing) return NextResponse.json({ error: '收货单不存在' }, { status: 404 })
      const poId = existing.purchaseOrderId
      const before = existing.arrivedAt

      const result = await p.$transaction(async (tx: typeof p) => {
        const gr = await tx.goodsReceipt.update({ where: { id }, data: { arrivedAt } })

        const arrivals = await tx.goodsReceipt.aggregate({
          where: { purchaseOrderId: poId },
          _min: { arrivedAt: true },
          _max: { arrivedAt: true },
        })
        await tx.purchaseOrder.update({
          where: { id: poId },
          data: {
            firstArrivedAt: arrivals._min.arrivedAt ?? arrivedAt,
            lastArrivedAt: arrivals._max.arrivedAt ?? arrivedAt,
          },
        })

        return gr
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'goods_receipt', resourceId: id,
        detail: `${existing.name} 订正到货日期：${before.toISOString().slice(0, 10)} → ${arrivedAt.toISOString().slice(0, 10)}`,
      })

      return NextResponse.json(serializeApi(result))
    } catch (error) {
      console.error('[PUT /api/goods-receipts/[id]]', error)
      return NextResponse.json({ error: '订正到货日期失败' }, { status: 500 })
    }
  }, { require: 'stock.receipt.create' })
}
