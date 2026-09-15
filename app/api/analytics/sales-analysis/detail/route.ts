import { NextResponse } from 'next/server'
import { serializeApi } from '@/lib/api-serializer'
import { resolveDateRange } from '@/lib/analytics/metrics'
import { fetchSalesDetail } from '@/lib/analytics/sales-detail'
import { withCachedAuth } from '@/lib/analytics/cache'

/**
 * /api/analytics/sales-analysis/detail — 销售明细点货清单（20260915，需求4）
 * ============================================================================
 * GET ?from&to&customerIds=a,b,c&productIds=x,y
 * 逐行返回：日期/客户/产品/单价/数量/金额，不聚合。customerIds/productIds 均可选，
 * 不传则返回该时间段全部（受 DETAIL_ROW_LIMIT 截断保护）。
 */
export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      const customerIds = searchParams.get('customerIds')?.split(',').filter(Boolean)
      const productIds = searchParams.get('productIds')?.split(',').filter(Boolean)

      const result = await fetchSalesDetail(start, end, { customerIds, productIds })
      return NextResponse.json(serializeApi(result))
    } catch (error) {
      console.error('[GET /api/analytics/sales-analysis/detail]', error)
      return NextResponse.json({ error: '获取销售明细失败' }, { status: 500 })
    }
  }, { require: 'analytics.margin.read' })
}
