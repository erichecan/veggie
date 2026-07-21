import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { queryLastSoldPriceWithDate } from '@/lib/server-pricing'

/**
 * GET /api/orders/last-price?customerId=X&productId=Y
 *
 * 返回该客户最近一次购买指定商品的成交价（price_unit）。
 * 对应 Odoo Last Price 定价模式。
 *
 * 复用 lib/server-pricing.ts 的 queryLastSoldPriceWithDate，不再自行实现查询——
 * 之前这里单独扫 Order.items JSON 且只走 User.customerId 反查 restaurantId，
 * 对几乎所有客户（restaurantId 直接存 Customer.id 的场景）永远查空，2026-07-20 修复。
 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const customerId = searchParams.get('customerId')
      const productId = searchParams.get('productId')

      if (!customerId || !productId) {
        return NextResponse.json({ error: 'customerId 和 productId 为必填参数' }, { status: 400 })
      }

      const hit = await queryLastSoldPriceWithDate(prisma, customerId, productId)
      if (!hit) {
        return NextResponse.json({ price: null, message: '未找到历史成交记录' })
      }

      return NextResponse.json({ price: hit.price, createdAt: hit.date })
    } catch (error) {
      console.error('[GET /api/orders/last-price]', error)
      return NextResponse.json({ error: '查询失败' }, { status: 500 })
    }
  })
}
