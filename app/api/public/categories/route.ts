import { NextResponse } from 'next/server'
import { serializeApi } from '@/lib/api-serializer'
import { rateLimit } from '@/lib/rate-limit'
import { listCustomerFacingCategories } from '@/lib/customer-facing-categories'

/**
 * 餐厅自助下单匿名浏览入口（/shop）的分类导航。
 *
 * 过滤名单与聚合逻辑见 lib/customer-facing-categories.ts（customer-portal 的
 * 分类导航共用同一份）。这里额外加 canBeSold: true，跟 /api/public/products
 * 的过滤口径对齐——否则分类下的数量和点进去实际看到的商品数能对不上。
 *
 * 匿名可达，不是鉴权放宽：只回类目名+数量，不碰价格/客户/财务数据，
 * 符合 lib/public-routes.ts 的「零业务数据」标准。
 */
export async function GET(req: Request) {
  const denied = rateLimit(req, { id: 'public-catalog', max: 60, windowMs: 60_000 })
  if (denied) return denied

  try {
    const result = await listCustomerFacingCategories({ canBeSold: true })
    return NextResponse.json(serializeApi(result))
  } catch (error) {
    console.error('[GET /api/public/categories]', error)
    return NextResponse.json({ error: '获取分类失败' }, { status: 500 })
  }
}
