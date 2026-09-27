import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { businessTodayStart } from '@/lib/analytics/metrics'

/**
 * 客户门户首页顶部轮播图 —— 只返回生效中的（active=true 且在 dateStart/dateEnd 区间内）
 *
 * 20260927（code-review 发现）：dateEnd 存的是那一天的业务时区 00:00（见
 * lib/banner-dates.ts），如果这里拿完整时间戳的 `now` 去比较，banner 会在
 * dateEnd 当天一开始（凌晨）就提前下线，少展示了一整天。改成按业务日比较——
 * 只要"今天"还没过 dateEnd 这一天，banner 就该还在。
 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const today = businessTodayStart()
      const banners = await prisma.banner.findMany({
        where: {
          active: true,
          AND: [
            { OR: [{ dateStart: null }, { dateStart: { lte: today } }] },
            { OR: [{ dateEnd: null }, { dateEnd: { gte: today } }] },
          ],
        },
        orderBy: { sequence: 'asc' },
        select: { id: true, title: true, imageUrl: true, linkUrl: true, productId: true },
      })
      return NextResponse.json(serializeApi(banners))
    } catch (error) {
      console.error('[GET /api/customer-portal/banners]', error)
      return NextResponse.json({ error: '获取轮播图失败' }, { status: 500 })
    }
  }, { require: 'portal.self.access' })
}
