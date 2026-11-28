
import { apiRouteErrorResponse } from '@/lib/api-route-error'
import { NextResponse } from 'next/server'
import { findSimilarProducts } from '@/lib/product-similarity'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const name = searchParams.get('name') ?? ''
    const excludeId = searchParams.get('excludeId') ?? undefined
    if (!name.trim() || name.trim().length < 2) {
      return NextResponse.json({ candidates: [] })
    }
    const candidates = await findSimilarProducts(name, excludeId)
    return NextResponse.json({ candidates })
  } catch (error) {
    console.error('[GET /api/products/similar]', error)
    return apiRouteErrorResponse(error, '查询相似商品失败')
  }
}
