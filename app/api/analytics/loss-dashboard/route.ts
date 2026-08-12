import { NextResponse } from 'next/server'
import { serializeApi } from '@/lib/api-serializer'
import {
  getLossKPIs,
  getLossTrend,
  getReturnDispositionSplit,
  getLossReasonBreakdown,
  getLossStageBreakdown,
  getTopLossProducts,
} from '@/lib/analytics/loss-dashboard'
import { withCachedAuth } from '@/lib/analytics/cache'

/**
 * /api/analytics/loss-dashboard — 损耗与退货仪表盘
 * ============================================================================
 * GET ?days=30&weeks=8
 * 把仓库报废损耗（StockMove type=SCRAP）与客户退货去向（Trip.restaurants[].returns[].disposition）
 * 拼在一起看，背景见 lib/analytics/loss-dashboard.ts 顶部注释。
 * 返回：
 *   kpis             本期报废损耗值 / 退货回收率(可为 null) / 待处置退货条数
 *   trend            近 N 周报废数量趋势（全部 vs 其中客退报废）
 *   dispositionSplit 期内已审批退货去向拆分（可再售/报废/待处置）+ 占比
 *   reasonBreakdown  期内报废原因排行（优先读结构化 lossReason，老数据回退 note 粗筛）
 *   stageBreakdown   期内损耗环节拆分（收货/仓储/分拣/运输/客退），历史行按原因推断并单独计数
 *   topLoss          期内报废损耗值 TOP N 商品
 */
export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const days = clampInt(searchParams.get('days'), 30, 1, 400)
      const weeks = clampInt(searchParams.get('weeks'), 8, 1, 52)

      const [kpis, trend, dispositionSplit, reasonBreakdown, stageBreakdown, topLoss] = await Promise.all([
        getLossKPIs(days),
        getLossTrend(weeks),
        getReturnDispositionSplit(days),
        getLossReasonBreakdown(days),
        getLossStageBreakdown(days),
        getTopLossProducts(days, 10),
      ])

      return NextResponse.json(serializeApi({
        kpis, trend, dispositionSplit, reasonBreakdown, stageBreakdown, topLoss,
      }))
    } catch (error) {
      console.error('[GET /api/analytics/loss-dashboard]', error)
      return NextResponse.json({ error: '获取损耗与退货仪表盘数据失败' }, { status: 500 })
    }
  }, { require: 'analytics.inventory.read' })
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw ? parseInt(raw, 10) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
