import { NextResponse } from 'next/server'
import { serializeApi } from '@/lib/api-serializer'
import { getProductPriceTrendsByIds } from '@/lib/analytics/price-trend'
import { withCachedAuth } from '@/lib/analytics/cache'

/** GET /api/analytics/price-trends?productIds=a,b,c — 商品进价环比（最近两次采购价对比） */
export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const ids = (searchParams.get('productIds') ?? '').split(',').map(s => s.trim()).filter(Boolean)
      const trends = await getProductPriceTrendsByIds(ids)
      return NextResponse.json(serializeApi(Object.fromEntries(trends)))
    } catch (error) {
      console.error('[GET /api/analytics/price-trends]', error)
      return NextResponse.json({ error: '获取失败' }, { status: 500 })
    }
  })
}
