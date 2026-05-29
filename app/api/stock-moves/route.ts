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
      orderBy: { createdAt: 'desc' },
      take: limit,
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

      const move = await prisma.stockMove.create({
        data: {
          productId,
          productName: productName || '未知商品',
          qty,
          note,
          type: data.type?.toString().toUpperCase() ?? 'ADJUSTMENT',
          sourceType,
          sourceId,
          sourceRef,
        },
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'stock-move', resourceId: move.id,
        detail: `创建库存移动: ${move.id}` })
      return NextResponse.json(serializeApi(move), { status: 201 })
    } catch (error) {
      console.error('[POST /api/stock-moves]', error)
      return NextResponse.json({ error: '创建库存记录失败' }, { status: 500 })
    }
  })
}
