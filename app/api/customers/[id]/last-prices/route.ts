import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { queryLastSoldPrices } from '@/lib/server-pricing'

/**
 * GET /api/customers/[id]/last-prices?productIds=p1,p2,p3
 *
 * 批量返回该客户对一组商品的最近一次成交价（price_unit）。
 * 用于销售下单页 priceType='last' 模式实时显示历史售价，避免按行 N 次请求。
 *
 * Response:
 *   {
 *     prices: { [productId: string]: number }   // 仅包含有历史的商品
 *     missing: string[]                         // 无历史成交记录的 productIds
 *   }
 *
 * - 没有传 productIds → 400
 * - productIds 上限 200，超过截断（防止前端误传过大列表）
 * - 客户不存在 → 404
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: customerId } = await params
    const { searchParams } = new URL(req.url)
    const raw = searchParams.get('productIds') ?? ''

    const productIds = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200)

    if (productIds.length === 0) {
      return NextResponse.json(
        { error: 'productIds 为必填参数（逗号分隔）' },
        { status: 400 },
      )
    }

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    })
    if (!customer) {
      return NextResponse.json({ error: '客户不存在' }, { status: 404 })
    }

    const prices = await queryLastSoldPrices(prisma, customerId, productIds)

    const missing = productIds.filter((pid) => !(pid in prices))

    return NextResponse.json({ prices, missing })
  } catch (error) {
    console.error('[GET /api/customers/[id]/last-prices]', error)
    return NextResponse.json({ error: '查询历史成交价失败' }, { status: 500 })
  }
}
