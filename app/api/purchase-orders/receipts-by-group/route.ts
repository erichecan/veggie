import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { getRecentGoodsReceiptsForGroup } from '@/lib/analytics/receipts-by-group'

/** GET /api/purchase-orders/receipts-by-group?groupKey=DRY_GOODS&months=12 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const groupKey = searchParams.get('groupKey')
      if (!groupKey) return NextResponse.json({ error: '缺少 groupKey' }, { status: 400 })
      const months = Math.min(36, Math.max(1, Number(searchParams.get('months')) || 12))
      const rows = await getRecentGoodsReceiptsForGroup(groupKey, months)
      return NextResponse.json(serializeApi(rows))
    } catch (error) {
      console.error('[GET /api/purchase-orders/receipts-by-group]', error)
      return NextResponse.json({ error: '获取失败' }, { status: 500 })
    }
  })
}
