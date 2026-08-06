import { NextResponse } from 'next/server'
import { serializeApi } from '@/lib/api-serializer'
import {
  getOverviewKPIs,
  getGroupOverview,
  getAttentionItems,
  getTopSuppliers,
  getRestockForecastItems,
} from '@/lib/analytics/procurement-overview'
import { withCachedAuth } from '@/lib/analytics/cache'

/** GET /api/analytics/procurement-overview — 采购总览页数据（KPI + Top10供应商 + 补货预测 + 需要关注 + 四品类现状） */
export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const isEn = new URL(req.url).searchParams.get('locale') === 'en'
      const [kpis, groups, attention, topSuppliers, forecast] = await Promise.all([
        getOverviewKPIs(),
        getGroupOverview(),
        getAttentionItems(8, isEn),
        getTopSuppliers(10, isEn),
        getRestockForecastItems(6),
      ])
      return NextResponse.json(serializeApi({ kpis, groups, attention, topSuppliers, forecast }))
    } catch (error) {
      console.error('[GET /api/analytics/procurement-overview]', error)
      const isEn = new URL(req.url).searchParams.get('locale') === 'en'
      return NextResponse.json({ error: isEn ? 'Failed to load procurement overview' : '获取采购总览失败' }, { status: 500 })
    }
  })
}
