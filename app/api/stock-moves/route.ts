import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const productId = searchParams.get('productId')
    const limit = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') ?? '1000', 10)))
    const moves = await prisma.stockMove.findMany({
      where: productId ? { productId } : undefined,
      orderBy: { movedAt: 'desc' },
      take: limit,
      include: { lot: { select: { lotNumber: true, bestBefore: true } } },
    })
    return NextResponse.json(serializeApi(moves))
  } catch (error) {
    console.error('[GET /api/stock-moves]', error)
    return NextResponse.json({ error: '获取库存记录失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()

      // 服务端校验
      const productId = data.productId?.toString().trim()
      const productName = data.productName?.toString().trim().slice(0, 200)
      const qty = Number(data.qty)
      const note = data.note?.toString().trim().slice(0, 500) ?? ''

      if (!productId) return NextResponse.json({ error: '商品 ID 不能为空' }, { status: 400 })
      if (!Number.isFinite(qty) || qty === 0 || Math.abs(qty) > 100000) {
        return NextResponse.json({ error: '数量不能为 0，且绝对值不超过 100,000' }, { status: 400 })
      }

      const sourceType = data.sourceType?.toString().trim().slice(0, 50) || null
      const sourceId = data.sourceId?.toString().trim() || null
      const sourceRef = data.sourceRef?.toString().trim().slice(0, 100) || null

      const movedAt = data.movedAt ? new Date(data.movedAt) : new Date()
      const lotId = data.lotId?.toString().trim() || null
      const moveType: string = data.type?.toString().toUpperCase() ?? 'ADJUSTMENT'

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      // 校验商品存在（库存调整需更新其在手量）
      const product = await p.product.findUnique({ where: { id: productId }, select: { id: true, name: true } })
      if (!product) return NextResponse.json({ error: '商品不存在' }, { status: 404 })

      // 出库/报废/负向调整时，如果指定了 lotId，扣减 Lot.currentQty
      const isConsumption = lotId && qty < 0
      if (isConsumption) {
        const lot = await p.lot.findUnique({ where: { id: lotId } })
        if (!lot) return NextResponse.json({ error: '批次不存在' }, { status: 404 })
        if (lot.productId !== productId) {
          return NextResponse.json({ error: '批次与商品不匹配' }, { status: 400 })
        }
        const absQty = Math.abs(qty)
        if (Number(lot.currentQty) < absQty) {
          return NextResponse.json({ error: `批次剩余库存不足（剩余 ${lot.currentQty}）` }, { status: 400 })
        }
      }

      const move = await p.$transaction(async (tx: typeof p) => {
        const created = await tx.stockMove.create({
          data: {
            productId,
            productName: productName || product.name || '未知商品',
            qty,
            note,
            type: moveType,
            movedAt,
            lotId,
            sourceType,
            sourceId,
            sourceRef,
          },
        })

        if (isConsumption) {
          const absQty = Math.abs(qty)
          const updated = await tx.lot.update({
            where: { id: lotId },
            data: { currentQty: { decrement: absQty } },
          })
          if (Number(updated.currentQty) <= 0) {
            await tx.lot.update({
              where: { id: lotId },
              data: { status: 'DEPLETED' },
            })
          }
        }

        // 正向入库且指定了 lotId，增加 Lot.currentQty
        if (lotId && qty > 0) {
          await tx.lot.update({
            where: { id: lotId },
            data: { currentQty: { increment: qty } },
          })
        }

        // 同步商品在手库存：move 数量正增负减（手动调整/入库/出库统一在此回写）
        await tx.product.update({
          where: { id: productId },
          data: { qtyOnHand: { increment: qty } },
        })

        return created
      })

      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'stock-move', resourceId: move.id,
        detail: `创建库存移动: ${move.id}${lotId ? ` (批次 ${lotId})` : ''}` })
      return NextResponse.json(serializeApi(move), { status: 201 })
    } catch (error) {
      console.error('[POST /api/stock-moves]', error)
      return NextResponse.json({ error: '创建库存记录失败' }, { status: 500 })
    }
  }, { require: 'stock.move.create' })
}
