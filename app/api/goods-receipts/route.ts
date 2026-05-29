import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'
import { toNum } from '@/lib/decimal-helpers'

/**
 * /api/goods-receipts
 * ============================================================================
 * 收货单（对应 Odoo stock.picking type=incoming）
 *
 * POST body:
 *   { purchaseOrderId, arrivedAt, lines: [{productId, qty, uomId?, condition:'ok'|'damaged'}] }
 *
 * 业务：
 *   1) 校验 PO 存在且状态 ∈ {CONFIRMED, RECEIVED}（允许分批到货）
 *   2) 生成 GR 编号
 *   3) 事务内：
 *      - 创建 GoodsReceipt
 *      - 更新 PO 各 Line 的 receivedQty
 *      - 给 Product.qtyOnHand 加上收到的数量，并写 StockMove(type=IN)
 *      - 如果所有 line 的 receivedQty >= orderedQty，把 PO 状态改为 RECEIVED
 */

interface InLine {
  productId: string
  productName?: string
  qty: number
  uomId?: string
  condition?: 'ok' | 'damaged'
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') ?? '100', 10)))
    const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10))
    const search = searchParams.get('search')?.trim() ?? ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const where = search
      ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { purchaseOrder: { name: { contains: search, mode: 'insensitive' } } }] }
      : {}
    const [total, items] = await Promise.all([
      p.goodsReceipt.count({ where }),
      p.goodsReceipt.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: { purchaseOrder: { select: { id: true, name: true, supplierId: true } } },
      }),
    ])
    return NextResponse.json(serializeApi({ items, total }))
  } catch (error) {
    console.error('[GET /api/goods-receipts]', error)
    return NextResponse.json({ error: '获取收货单失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const poId = String(data.purchaseOrderId ?? '').trim()
      if (!poId) return NextResponse.json({ error: 'purchaseOrderId 必填' }, { status: 400 })
      const lines: InLine[] = Array.isArray(data.lines) ? data.lines : []
      if (lines.length === 0) return NextResponse.json({ error: '收货行不能为空' }, { status: 400 })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const po = await p.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } })
      if (!po) return NextResponse.json({ error: '采购订单不存在' }, { status: 404 })
      if (!['CONFIRMED', 'RECEIVED'].includes(po.status)) {
        return NextResponse.json({
          error: `PO 状态 ${po.status}，无法收货（应为 CONFIRMED 或 RECEIVED）`,
        }, { status: 409 })
      }

      const grCount = await p.goodsReceipt.count()
      const grName = `GR-${String(grCount + 1).padStart(5, '0')}`

      const result = await p.$transaction(async (tx: typeof p) => {
        const gr = await tx.goodsReceipt.create({
          data: {
            name: grName,
            purchaseOrderId: poId,
            arrivedAt: data.arrivedAt ? new Date(data.arrivedAt) : new Date(),
            receivedBy: user.name,
            lines: lines.map((l) => ({
              productId: l.productId,
              productName: l.productName ?? '',
              qty: Number(l.qty),
              uomId: l.uomId ?? null,
              condition: l.condition ?? 'ok',
            })),
            notes: data.notes ?? null,
          },
        })

        // 更新每条 PO line 的 receivedQty + StockMove + Product.qtyOnHand
        for (const l of lines) {
          const poLine = po.lines.find((pl: { productId: string }) => pl.productId === l.productId)
          if (!poLine) continue
          const qty = Number(l.qty)
          if (qty <= 0) continue
          await tx.purchaseOrderLine.update({
            where: { id: poLine.id },
            data: { receivedQty: { increment: qty } },
          })
          // damaged 的货不入库
          if ((l.condition ?? 'ok') === 'ok') {
            await tx.product.update({
              where: { id: l.productId },
              data: { qtyOnHand: { increment: qty } },
            })
            await tx.stockMove.create({
              data: {
                productId: l.productId,
                productName: l.productName ?? poLine.productName,
                type: 'IN',
                qty,
                note: `收货 ${grName} / PO ${po.name}`,
                sourceType: 'GOODS_RECEIPT',
                sourceId: gr.id,
                sourceRef: grName,
              },
            })
          }
        }

        // 检查是否全量到货
        const updatedPo = await tx.purchaseOrder.findUnique({
          where: { id: poId },
          include: { lines: true },
        })
        const allReceived = updatedPo.lines.every(
          (l: { receivedQty: unknown; orderedQty: unknown }) =>
            toNum(l.receivedQty) >= toNum(l.orderedQty),
        )
        if (allReceived && po.status !== 'RECEIVED') {
          await tx.purchaseOrder.update({
            where: { id: poId },
            data: { status: 'RECEIVED' },
          })
        }

        return gr
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'goods_receipt', resourceId: result.id,
        detail: `${grName} 收货，PO=${po.name}`,
      })
      return NextResponse.json(serializeApi(result), { status: 201 })
    } catch (error) {
      console.error('[POST /api/goods-receipts]', error)
      return NextResponse.json({ error: '收货失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'WAREHOUSE', 'BOSS'])
}
