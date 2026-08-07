import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

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

      return NextResponse.json(
        serializeApi({ lot, orderSales, otherMoves, productReturns })
      )
    } catch (error) {
      console.error('[GET /api/lots/trace]', error)
      return NextResponse.json({ error: '获取批次追溯失败' }, { status: 500 })
    }
  }, { require: 'stock.lot.read' })
}
