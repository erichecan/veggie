import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import { writeLog } from '@/lib/action-log'

async function nextDiscCode(): Promise<string> {
  const count = await prisma.orderDiscrepancy.count()
  return `DISC-${String(count + 1).padStart(5, '0')}`
}

export async function GET(req: NextRequest) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const status = searchParams.get('status')
      const orderId = searchParams.get('orderId')
      const limit = Math.min(Number(searchParams.get('limit') || 50), 200)
      const offset = Number(searchParams.get('offset') || 0)

      const where: Record<string, unknown> = {}
      if (status) where.status = status
      if (orderId) where.orderId = orderId

      const [items, total] = await Promise.all([
        prisma.orderDiscrepancy.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          include: {
            order: { select: { code: true, restaurantName: true, status: true, deliveryDate: true } },
          },
        }),
        prisma.orderDiscrepancy.count({ where }),
      ])

      return NextResponse.json(serializeApi({ items, total }))
    } catch (error) {
      console.error('[GET /api/order-discrepancies]', error)
      return NextResponse.json({ error: '获取差异记录失败' }, { status: 500 })
    }
  })
}

export async function POST(req: NextRequest) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()
      const { orderId, orderLineId, productId, productName, orderedQty, pickedQty, type, note } = body

      if (!orderId || !orderLineId || !productId || orderedQty === undefined || pickedQty === undefined || !type) {
        return NextResponse.json({ error: '缺少必填字段' }, { status: 400 })
      }

      const validTypes = ['SHORTAGE', 'SUBSTITUTE', 'WEIGHT_DIFF']
      if (!validTypes.includes(type)) {
        return NextResponse.json({ error: `差异类型无效，允许: ${validTypes.join(', ')}` }, { status: 400 })
      }

      const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, code: true, status: true } })
      if (!order) return NextResponse.json({ error: '订单不存在' }, { status: 404 })

      const statusStr = String(order.status).toUpperCase()
      const allowedStatuses = new Set(['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY'])
      if (!allowedStatuses.has(statusStr)) {
        return NextResponse.json({ error: `只有已确认/拣货中/配送中的订单可以上报差异` }, { status: 409 })
      }

      const line = await prisma.orderLine.findUnique({ where: { id: orderLineId } })
      if (!line || line.orderId !== orderId) {
        return NextResponse.json({ error: '订单行不存在或不属于该订单' }, { status: 404 })
      }

      const code = await nextDiscCode()
      const diffQty = Number(orderedQty) - Number(pickedQty)

      const disc = await prisma.orderDiscrepancy.create({
        data: {
          code,
          orderId,
          orderLineId,
          productId,
          productName: productName || line.productName,
          orderedQty: Number(orderedQty),
          pickedQty: Number(pickedQty),
          diffQty,
          type,
          note: note || null,
          reportedBy: user.userId,
          reportedByName: user.name,
        },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'order_discrepancy', resourceId: disc.id,
        detail: `上报拣货差异 ${code}: 订单 ${order.code ?? orderId}, ${productName || line.productName}, 下单 ${orderedQty} 实拣 ${pickedQty}, 类型 ${type}`,
      })

      return NextResponse.json(serializeApi(disc), { status: 201 })
    } catch (error) {
      console.error('[POST /api/order-discrepancies]', error)
      return NextResponse.json({ error: '创建差异记录失败' }, { status: 500 })
    }
  })
}
