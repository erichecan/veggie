import { NextResponse } from 'next/server'
import { serializeApi } from '@/lib/api-serializer'
import { resolveDateRange } from '@/lib/analytics/metrics'
import { fetchStockTrend, isValidGranularity } from '@/lib/analytics/stock-trend'
import { withCachedAuth } from '@/lib/analytics/cache'

/**
 * /api/analytics/procurement-analysis/stock-trend — on-hand + 出货趋势（需求6）
 * ============================================================================
 * GET ?from&to&productIds=<逗号多选，必填>&granularity=week|month（默认 week）
 * 口径/风险说明见 lib/analytics/stock-trend.ts 顶部注释：forecast 是历史实际出货量
 * 近似，不是预测算法。
 */
export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      const productIds = searchParams.get('productIds')?.split(',').filter(Boolean) ?? []
      const granularityParam = searchParams.get('granularity') ?? 'week'

      if (productIds.length === 0) {
        return NextResponse.json({ error: '请至少选择一个产品' }, { status: 400 })
      }
      if (productIds.length > 10) {
        return NextResponse.json({ error: '最多同时看 10 个产品的趋势' }, { status: 400 })
      }
      if (!isValidGranularity(granularityParam)) {
        return NextResponse.json({ error: 'granularity 必须是 week/month' }, { status: 400 })
      }

      const series = await fetchStockTrend(start, end, productIds, granularityParam)
      return NextResponse.json(serializeApi({ granularity: granularityParam, series }))
    } catch (error) {
      console.error('[GET /api/analytics/procurement-analysis/stock-trend]', error)
      return NextResponse.json({ error: '获取库存趋势失败' }, { status: 500 })
    }
  }, { require: 'analytics.purchase_detail.read' })
}
