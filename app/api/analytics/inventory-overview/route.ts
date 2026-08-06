import { NextResponse } from 'next/server'
import { serializeApi } from '@/lib/api-serializer'
import { getInventoryOverviewKPIs, getInventoryAttentionItems, getInventoryByCategoryGroup } from '@/lib/analytics/inventory-overview'
import { withCachedAuth } from '@/lib/analytics/cache'

/** GET /api/analytics/inventory-overview — 库存总览页数据（KPI + 需要关注 + 按品类分组现状） */
export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const isEn = new URL(req.url).searchParams.get('locale') === 'en'
      const [kpis, attention, groups] = await Promise.all([
        getInventoryOverviewKPIs(),
        getInventoryAttentionItems(8, isEn),
        getInventoryByCategoryGroup(),
      ])
      return NextResponse.json(serializeApi({ kpis, attention, groups }))
    } catch (error) {
      console.error('[GET /api/analytics/inventory-overview]', error)
      const isEn = new URL(req.url).searchParams.get('locale') === 'en'
      return NextResponse.json({ error: isEn ? 'Failed to load inventory overview' : '获取库存总览失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'WAREHOUSE', 'BOSS'])
}
