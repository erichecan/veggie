import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { getZoneSummaries, getZoneMismatches, getUnplacedCount } from '@/lib/analytics/zone-inventory'

export async function GET(req: Request) {
  return withAuth(req, async () => {
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
      return NextResponse.json({ error: '获取温区库存数据失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'WAREHOUSE', 'BOSS'])
}
