import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { resolveDateRange } from '@/lib/analytics/metrics'
import { withCachedAuth } from '@/lib/analytics/cache'
import { fetchDriverDaySalesByOrder } from '@/lib/analytics/driver-commission'

/**
 * /api/analytics/driver-commission/day-sales — 按司机的销售额/毛利/提成（Sales Analysis 页用）
 * ============================================================================
 * GET ?from&to（通常 from=to=同一天，跟本页其余"按天"面板一样按单日查）
 * 20260916：归属从 Trip 换成订单自身（所属波次的司机 → Order.driverSlotId 兜底），
 * 日期口径改为 COALESCE(deliveryDate, confirmationDate)，与本页其余面板一致。
 * 换的原因（Trip 口径在生产上恒为空）详见 lib/analytics/driver-commission.ts
 * fetchDriverDaySalesByOrder 的口径说明。
 * 权限跟 /api/analytics/driver-commission 一致：提成是薪酬数据，只放开给够得着
 * analytics.commission.read 的角色，不因为挂在 Sales Analysis 页下就放宽。
 */
export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      const rows = await fetchDriverDaySalesByOrder(prisma, start, end)
      return NextResponse.json(serializeApi({ rows }))
    } catch (error) {
      console.error('[GET /api/analytics/driver-commission/day-sales]', error)
      return NextResponse.json({ error: '获取按司机销售额失败' }, { status: 500 })
    }
  }, { require: 'analytics.commission.read' })
}
