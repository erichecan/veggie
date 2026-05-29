import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

/**
 * GET /api/orders/last-price?customerId=X&productId=Y
 *
 * 返回该客户最近一次购买指定商品的成交价（price_unit）。
 * 对应 Odoo Last Price 定价模式。
 *
 * 查询链：Customer.id → User.customerId → User.id (restaurantId) → Order → items[].price
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const customerId = searchParams.get('customerId')
    const productId = searchParams.get('productId')

    if (!customerId || !productId) {
      return NextResponse.json({ error: 'customerId 和 productId 为必填参数' }, { status: 400 })
    }

    // 找到该客户关联的所有餐馆用户 ID
    const users = await prisma.user.findMany({
      where: { customerId },
      select: { id: true },
    })
    const restaurantIds = users.map(u => u.id)

    if (restaurantIds.length === 0) {
      return NextResponse.json({ price: null, message: '该客户无关联餐馆用户' })
    }

    // 查最近的若干条订单（取前20条，避免全表扫）
    const recentOrders = await prisma.order.findMany({
      where: { restaurantId: { in: restaurantIds } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, items: true, createdAt: true },
    })

    // 从 items JSON 中找最近一笔含该 productId 的记录
    for (const order of recentOrders) {
      const items = order.items as Array<{ productId: string; price: number }>
      const found = items.find(i => i.productId === productId)
      if (found && found.price > 0) {
        return NextResponse.json({
          price: found.price,
          orderId: order.id,
          createdAt: order.createdAt,
        })
      }
    }

    return NextResponse.json({ price: null, message: '未找到历史成交记录' })
  } catch (error) {
    console.error('[GET /api/orders/last-price]', error)
    return NextResponse.json({ error: '查询失败' }, { status: 500 })
  }
}
