import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { getLastPurchaseOrderDateByGroup } from '@/lib/analytics/last-po-by-group'

/** GET /api/purchase-orders/last-by-group — 各采购品类分组最近一次下单日期 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const data = await getLastPurchaseOrderDateByGroup()
      return NextResponse.json(serializeApi(data))
    } catch (error) {
      console.error('[GET /api/purchase-orders/last-by-group]', error)
      return NextResponse.json({ error: '获取失败' }, { status: 500 })
    }
  })
}
