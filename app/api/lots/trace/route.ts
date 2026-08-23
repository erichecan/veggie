import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { parseStoredQc, qcVerdict, type QcRecord, type QcVerdict } from '@/lib/purchase/qc'

/**
 * GET /api/lots/trace
 * ============================================================================
 * 批次追溯：给定批号（或批次 id），返回该批次的完整流转历史——
 * 卖给了哪些客户（订单出库）+ 其他流水（报废/调整等）。
 *
 * Query params（二选一，优先 id）：
 *   id        — Lot.id
 *   lotNumber — Lot.lotNumber（如 LOT-00918）
 *
 * 返回：serializeApi({ lot, orderSales, otherMoves })
 *   lot         — 批次本身 + 关联商品（name/spec）
 *   orderSales  — 该批次通过订单出库的销售记录：{ orderId, orderCode, restaurantName, qty, movedAt }
 *   otherMoves  — 该批次的其他流水（SCRAP/ADJUSTMENT 等，非订单出库）：{ type, qty, note, sourceType, sourceRef, movedAt }
 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const id = searchParams.get('id')?.trim() || undefined
      const lotNumber = searchParams.get('lotNumber')?.trim() || undefined

      if (!id && !lotNumber) {
        return NextResponse.json({ error: '请提供 id 或 lotNumber 参数' }, { status: 400 })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const lot = await p.lot.findFirst({
        where: id ? { id } : { lotNumber },
        include: {
          product: { select: { id: true, name: true, spec: true } },
        },
      })

      if (!lot) {
        return NextResponse.json({ error: '未找到该批次' }, { status: 404 })
      }

      const moves = await p.stockMove.findMany({
        where: { lotId: lot.id },
        orderBy: { movedAt: 'desc' },
      })

      const orderOutMoves = moves.filter(
        (m: { type: string; sourceType: string | null }) => m.type === 'OUT' && m.sourceType === 'ORDER'
      )
      const otherMoveRows = moves.filter(
        (m: { type: string; sourceType: string | null }) => !(m.type === 'OUT' && m.sourceType === 'ORDER')
      )

      const orderIds = Array.from(
        new Set(orderOutMoves.map((m: { sourceId: string | null }) => m.sourceId).filter(Boolean))
      ) as string[]

      const orders = orderIds.length > 0
        ? await p.order.findMany({
            where: { id: { in: orderIds } },
            select: { id: true, code: true, restaurantName: true },
          })
        : []
      const orderById = new Map(orders.map((o: { id: string }) => [o.id, o]))

      const orderSales = orderOutMoves.map((m: {
        sourceId: string | null; qty: unknown; movedAt: Date
      }) => {
        const order = m.sourceId ? orderById.get(m.sourceId) as { id: string; code: string | null; restaurantName: string } | undefined : undefined
        return {
          orderId: m.sourceId ?? null,
          orderCode: order?.code ?? null,
          restaurantName: order?.restaurantName ?? null,
          qty: Math.abs(Number(m.qty)),
          movedAt: m.movedAt,
        }
      })

      const otherMoves = otherMoveRows.map((m: {
        type: string; qty: unknown; note: string | null; sourceType: string | null; sourceRef: string | null; movedAt: Date
      }) => ({
        type: m.type,
        qty: Math.abs(Number(m.qty)),
        note: m.note,
        sourceType: m.sourceType,
        sourceRef: m.sourceRef,
        movedAt: m.movedAt,
      }))

      // 补充：该商品的产品级 RETURN 流水（RETURN 目前不可靠携带 lotId，仅作参考，非批次级精确追溯）
      const productReturnMoves = await p.stockMove.findMany({
        where: { productId: lot.productId, type: 'RETURN' },
        orderBy: { movedAt: 'desc' },
        take: 50,
      })
      const productReturns = productReturnMoves
        .filter((m: { lotId: string | null }) => m.lotId !== lot.id) // 已在 otherMoves 中精确列出的批次级 RETURN 不重复
        .map((m: { qty: unknown; note: string | null; sourceRef: string | null; movedAt: Date }) => ({
          type: 'RETURN' as const,
          qty: Math.abs(Number(m.qty)),
          note: m.note,
          sourceRef: m.sourceRef,
          movedAt: m.movedAt,
          lotSpecific: false,
        }))

      // 收货质检（台账 F4）：**派生，不复制存储** ——
      // 质检记录写在收货单（GoodsReceipt）的对应行上，不抄一份到 Lot 上，否则
      // 收货单改了、批次上的没改，追溯页显示的就是过期结论。
      // ⚠️ 20260823 起批次由采购确认收货建出（sourceType=PURCHASE_RECEIVE / sourceId=PO id），
      // 不再是某一张具体收货单——一个 PO 名下可能有多张记录到货的 GoodsReceipt，
      // 质检回查因此改按 purchaseOrderId + productId 找最近一张有质检的收货单，
      // 不再是精确到"就是建这个批次的那张单"。
      // 历史批次（20260823 前建的）sourceType 仍是 GOODS_RECEIPT，sourceId 精确指向那张收货单，
      // 两种取法都保留，互不影响。
      // ⚠️ 已知精度：按 productId 匹配收货行。同一张收货单里同一商品拆成多条良品行时
      // （界面不会这么产出，脚本可能）只能定位到第一条带质检的。
      let receiptQc: {
        goodsReceiptId: string; goodsReceiptName: string; arrivedAt: Date
        receivedBy: string | null; qc: QcRecord; verdict: QcVerdict | null
      } | null = null
      if (lot.sourceType === 'GOODS_RECEIPT' && lot.sourceId) {
        const gr = await p.goodsReceipt.findUnique({
          where: { id: lot.sourceId },
          select: { id: true, name: true, arrivedAt: true, receivedBy: true, lines: true },
        })
        const grLines = Array.isArray(gr?.lines) ? gr.lines as Array<Record<string, unknown>> : []
        const hit = grLines.find(
          (l) => l.productId === lot.productId && (l.condition ?? 'ok') === 'ok' && l.qc != null
        )
        const qc = hit ? parseStoredQc(hit.qc) : null
        if (gr && qc) {
          receiptQc = {
            goodsReceiptId: gr.id, goodsReceiptName: gr.name, arrivedAt: gr.arrivedAt,
            receivedBy: gr.receivedBy ?? null, qc, verdict: qcVerdict(qc),
          }
        }
      } else if (lot.sourceType === 'PURCHASE_RECEIVE' && lot.sourceId) {
        const grs = await p.goodsReceipt.findMany({
          where: { purchaseOrderId: lot.sourceId },
          orderBy: { arrivedAt: 'desc' },
          select: { id: true, name: true, arrivedAt: true, receivedBy: true, lines: true },
        })
        for (const gr of grs) {
          const grLines = Array.isArray(gr.lines) ? gr.lines as Array<Record<string, unknown>> : []
          const hit = grLines.find(
            (l) => l.productId === lot.productId && (l.condition ?? 'ok') === 'ok' && l.qc != null
          )
          const qc = hit ? parseStoredQc(hit.qc) : null
          if (qc) {
            receiptQc = {
              goodsReceiptId: gr.id, goodsReceiptName: gr.name, arrivedAt: gr.arrivedAt,
              receivedBy: gr.receivedBy ?? null, qc, verdict: qcVerdict(qc),
            }
            break
          }
        }
      }

      return NextResponse.json(
        serializeApi({ lot, orderSales, otherMoves, productReturns, receiptQc })
      )
    } catch (error) {
      console.error('[GET /api/lots/trace]', error)
      return NextResponse.json({ error: '获取批次追溯失败' }, { status: 500 })
    }
  }, { require: 'stock.lot.read' })
}
