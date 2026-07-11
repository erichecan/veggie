import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import {
  getOverviewKPIs,
  getGroupOverview,
  getAttentionItems,
  getTopSuppliers,
  getRestockForecastItems,
} from '@/lib/analytics/procurement-overview'

/** GET /api/analytics/procurement-overview — 采购总览页数据（KPI + Top10供应商 + 补货预测 + 需要关注 + 四品类现状） */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const [kpis, groups, attention, topSuppliers, forecast] = await Promise.all([
        getOverviewKPIs(),
        getGroupOverview(),
        getAttentionItems(8),
        getTopSuppliers(10),
        getRestockForecastItems(6),
      ])
      return NextResponse.json(serializeApi({ kpis, groups, attention, topSuppliers, forecast }))
    } catch (error) {
      console.error('[GET /api/analytics/procurement-overview]', error)
      return NextResponse.json({ error: '获取采购总览失败' }, { status: 500 })
    }
  })
}
