import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { resolveDateRange } from '@/lib/analytics/metrics'
import { withCachedAuth } from '@/lib/analytics/cache'
import { fetchDriverProductDetail } from '@/lib/analytics/driver-commission'

/**
 * /api/analytics/driver-commission/product-detail — 司机×客户×产品×半天送货明细（20260922）
 * ============================================================================
 * GET ?from&to&driverId&driverName&detailLimit
 * 客户手写需求原话："每个司机 每个客户，每个产品，每天（上午下午）的明细要输出。司机一份，公司留一份。"
 * 不是提成计算，是核对用的送货清单——按 driverId/driverName 筛就是"司机一份"（只含他自己的行）。
 * 权限与主报表共用 analytics.commission.read：这是同一张报表的另一种粒度，不是新数据面。
 */
export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      const driverId = searchParams.get('driverId')?.trim() || null
      const driverName = searchParams.get('driverName')?.trim() || null

      const limitParam = searchParams.get('detailLimit')
      let detailLimit = 500
      if (limitParam !== null) {
        const parsed = Number(limitParam)
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2000) {
          return NextResponse.json({ error: 'detailLimit 需为 1–2000 的整数' }, { status: 400 })
        }
        detailLimit = parsed
      }

      const payload = await fetchDriverProductDetail(prisma, { start, end, driverId, driverName, detailLimit })
      return NextResponse.json(serializeApi(payload))
    } catch (error) {
      console.error('[GET /api/analytics/driver-commission/product-detail]', error)
      return NextResponse.json({ error: '获取司机送货明细失败' }, { status: 500 })
    }
  }, { require: 'analytics.commission.read' })
}
