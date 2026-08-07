import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * /api/lots
 * ============================================================================
 * 查询库存批次
 *
 * GET params:
 *   productId  — 按商品过滤
 *   status     — AVAILABLE | DEPLETED（默认只返回 AVAILABLE）
 *   limit      — 最多返回条数（默认 200）
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const productId = searchParams.get('productId')?.trim() || undefined
    const status = searchParams.get('status')?.trim().toUpperCase() || 'AVAILABLE'
    const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') ?? '200', 10)))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const where: Record<string, unknown> = {}
    if (productId) where.productId = productId
    if (status !== 'ALL') where.status = status

    const lots = await p.lot.findMany({
      where,
      orderBy: { arrivedAt: 'asc' },
      take: limit,
    })

    return NextResponse.json(serializeApi(lots))
  } catch (error) {
    console.error('[GET /api/lots]', error)
    return NextResponse.json({ error: '获取批次列表失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const productId = data.productId?.toString().trim()
      if (!productId) return NextResponse.json({ error: '商品 ID 不能为空' }, { status: 400 })

      const qty = Number(data.qty)
      if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) {
        return NextResponse.json({ error: '数量必须在 0–100,000 之间' }, { status: 400 })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const product = await p.product.findUnique({ where: { id: productId } })
      if (!product) return NextResponse.json({ error: '商品不存在' }, { status: 404 })

      const lotName = data.lotName?.toString().trim()
      let lotNumber: string
      if (lotName) {
        lotNumber = lotName.slice(0, 50)
      } else {
        const count = await p.lot.count()
        lotNumber = `LOT-${String(count + 1).padStart(5, '0')}`
      }

      const bestBefore = data.bestBefore ? new Date(data.bestBefore) : null
      const noteText = data.note?.toString().trim().slice(0, 500) || ''

      const lot = await p.$transaction(async (tx: typeof p) => {
        const created = await tx.lot.create({
          data: {
            lotNumber,
            productId,
            initialQty: qty,
            currentQty: qty,
            sourceType: 'MANUAL',
            sourceRef: null,
            bestBefore,
            arrivedAt: new Date(),
          },
        })

        await tx.product.update({
          where: { id: productId },
          data: { qtyOnHand: { increment: qty } },
        })

        await tx.stockMove.create({
          data: {
            productId,
            productName: product.name,
            type: 'IN',
            qty,
            lotId: created.id,
            movedAt: new Date(),
            note: noteText ? `手动创建批次 ${lotNumber}: ${noteText}` : `手动创建批次 ${lotNumber}`,
            sourceType: 'MANUAL',
          },
        })

        return created
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'lot', resourceId: lot.id,
        detail: `手动创建批次 ${lotNumber}，商品 ${product.name}，数量 ${qty}`,
      })

      return NextResponse.json(serializeApi(lot), { status: 201 })
    } catch (error) {
      console.error('[POST /api/lots]', error)
      const msg = error instanceof Error && error.message.includes('Unique constraint')
        ? '批号已存在' : '创建批次失败'
      return NextResponse.json({ error: msg }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'WAREHOUSE'])
}
