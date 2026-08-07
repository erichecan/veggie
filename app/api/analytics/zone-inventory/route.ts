import { NextResponse } from 'next/server'
import { serializeApi } from '@/lib/api-serializer'
import { getZoneSummaries, getZoneMismatches, getUnplacedCount } from '@/lib/analytics/zone-inventory'
import { withCachedAuth } from '@/lib/analytics/cache'

export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') ?? '200', 10)))

      const [zones, mismatches, unplacedCount] = await Promise.all([
        getZoneSummaries(),
        getZoneMismatches(limit),
        getUnplacedCount(),
      ])

      return NextResponse.json(serializeApi({ zones, mismatches, unplacedCount }))
    } catch (error) {
      console.error('[GET /api/analytics/zone-inventory]', error)
      const isEn = new URL(req.url).searchParams.get('locale') === 'en'
      return NextResponse.json({ error: isEn ? 'Failed to load zone inventory data' : '获取温区库存数据失败' }, { status: 500 })
    }
  }, { require: 'analytics.inventory.read' })
}
