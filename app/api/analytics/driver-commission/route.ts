import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { resolveDateRange } from '@/lib/analytics/metrics'
import { withCachedAuth } from '@/lib/analytics/cache'
import { fetchDriverCommission, type PeriodGrain } from '@/lib/analytics/driver-commission'

/**
 * /api/analytics/driver-commission — 司机提成考核报表（台账 H3）
 * ============================================================================
 * GET ?from&to&driverId&grain=day|week|month&detailLimit
 *
 * 三段输出：按司机汇总 / 按周期×司机 / 逐单明细（含件提成·固定费·比例提成的构成）。
 *
 * 权限：`analytics.commission.read`。这个权限点此前是**装饰性的**——目录里有、
 * 没有任何判定引用（I2 实测 13 个假开关之一）。本路由是它的第一个引用点，
 * 同时随迁移把它发给了 boss / operator / finance（原本就够得着物流分析的管理岗）。
 *
 * ⛔ **司机本人看不到这张表**：DRIVER 在 `role-access` 里够不着 `/api/analytics/**`。
 * 提成金额是薪酬数据，「让司机自查本月提成」是另一个功能（属司机端，见 C8/C9），
 * 要做需要单独决策 —— 顺手放开等于扩大薪酬数据可见面。
 */
export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))

      const grainParam = searchParams.get('grain')
      if (grainParam && !['day', 'week', 'month'].includes(grainParam)) {
        return NextResponse.json({ error: `不支持的周期粒度：${grainParam}` }, { status: 400 })
      }

      // driverId 与 driverName 一起用才等于汇总的分组键 —— 详见 lib 里的说明：
      // 现网数据里同一个 driverId 挂着好几个司机名，只按 id 筛等于没筛。
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

      const payload = await fetchDriverCommission(prisma, {
        start, end, driverId, driverName,
        grain: (grainParam as PeriodGrain | null) ?? 'day',
        detailLimit,
      })

      return NextResponse.json(serializeApi(payload))
    } catch (error) {
      console.error('[GET /api/analytics/driver-commission]', error)
      return NextResponse.json({ error: '获取司机提成报表失败' }, { status: 500 })
    }
  }, { require: 'analytics.commission.read' })
}
