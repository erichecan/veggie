import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'

const SCRAP_REASONS = [
  'CUSTOMER_RETURN_EXPIRED',
  'CUSTOMER_RETURN_DAMAGED',
  'WAREHOUSE_EXPIRY',
  'WAREHOUSE_DAMAGE',
  'OTHER',
] as const

const REASON_LABEL: Record<string, string> = {
  CUSTOMER_RETURN_EXPIRED: '客退过期',
  CUSTOMER_RETURN_DAMAGED: '客退损坏',
  WAREHOUSE_EXPIRY: '仓库过期',
  WAREHOUSE_DAMAGE: '仓库损坏',
  OTHER: '其他',
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const limit = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') ?? '200', 10)))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const moves = await p.stockMove.findMany({
      where: { type: 'SCRAP' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return NextResponse.json(serializeApi(moves))
  } catch (error) {
    console.error('[GET /api/scrap]', error)
    return NextResponse.json({ error: '获取报废记录失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()

      const productId = data.productId?.toString().trim()
      const productName = data.productName?.toString().trim().slice(0, 200)
      const qty = Number(data.qty)
      const reason = data.reason?.toString().trim() ?? ''
      const notes = data.notes?.toString().trim().slice(0, 500) ?? ''

      if (!productId) return NextResponse.json({ error: '商品 ID 不能为空' }, { status: 400 })
      if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) {
        return NextResponse.json({ error: '报废数量必须大于 0 且不超过 100,000' }, { status: 400 })
      }
      if (reason && !SCRAP_REASONS.includes(reason as typeof SCRAP_REASONS[number])) {
        return NextResponse.json({ error: `无效的报废原因: ${reason}` }, { status: 400 })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const product = await p.product.findUnique({
        where: { id: productId },
        include: { template: { select: { type: true } } },
      })
      if (!product) return NextResponse.json({ error: '商品不存在' }, { status: 404 })
      if (product.template?.type !== 'PRODUCT') {
        return NextResponse.json({ error: '只有实物商品可以报废' }, { status: 400 })
      }

      const onHand = toNum(product.qtyOnHand)
      if (onHand < qty) {
        return NextResponse.json({
          error: `库存不足，当前库存 ${onHand}，报废数量 ${qty}`,
        }, { status: 409 })
      }

      // Generate scrap reference
      const scrapCount = await p.stockMove.count({ where: { type: 'SCRAP' } })
      const scrapRef = `SCRAP-${String(scrapCount + 1).padStart(5, '0')}`

      const reasonLabel = REASON_LABEL[reason] ?? reason
      const noteText = [reasonLabel, notes].filter(Boolean).join(' - ')

      // Atomic: decrement stock + create scrap move
      const result = await p.$transaction(async (tx: typeof p) => {
        await tx.product.update({
          where: { id: productId },
          data: { qtyOnHand: { decrement: qty } },
        })

        const move = await tx.stockMove.create({
          data: {
            productId,
            productName: productName || product.name || '未知商品',
            type: 'SCRAP',
            qty: -qty,
            note: noteText || `报废 ${scrapRef}`,
            sourceType: 'SCRAP',
            sourceId: null,
            sourceRef: scrapRef,
          },
        })
        return move
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'scrap', resourceId: result.id,
        detail: `报废 ${scrapRef}: ${productName ?? product.name} x${qty} (${reasonLabel})`,
      })

      return NextResponse.json(serializeApi(result), { status: 201 })
    } catch (error) {
      console.error('[POST /api/scrap]', error)
      return NextResponse.json({ error: '创建报废记录失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'WAREHOUSE', 'BOSS'])
}
