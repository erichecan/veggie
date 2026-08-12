'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur } from '@/lib/format-money'
import { SCRAP_REASON_LABEL_EN } from '@/lib/scrap-reasons'
import { LOSS_STAGE_LABEL_EN, type LossStage } from '@/lib/loss-attribution'

const PURPLE = '#875A7B'
const BORDER = '#d4b8d0'
const GREEN = '#2f8a4e'
const AMBER = '#a3690e'
const GRAY = '#9ca3af'
const RED = '#b6412a'

interface LossKPIs {
  scrapValueThisPeriod: number
  returnRecoveryRatePct: number | null
  pendingReturnDisposition: number
}

interface LossTrendWeek {
  weekLabel: string
  scrapQty: number
  returnScrapQty: number
}

interface ReturnDispositionSplit {
  sellableQty: number
  scrapQty: number
  pendingQty: number
  sellablePct: number
  scrapPct: number
  pendingPct: number
}

interface LossReasonRow {
  reason: string
  reasonLabel: string
  qty: number
}

interface TopLossProduct {
  productId: string
  productName: string
  scrapQty: number
  scrapValue: number
}

interface LossStageRow {
  stage: LossStage | 'UNKNOWN'
  stageLabel: string
  qty: number
  /** 其中按原因推断出来的量（历史行没有结构化环节）——猜的和填的不混为一谈 */
  inferredQty: number
}

interface DashboardData {
  kpis: LossKPIs
  trend: LossTrendWeek[]
  dispositionSplit: ReturnDispositionSplit
  reasonBreakdown: LossReasonRow[]
  stageBreakdown: LossStageRow[]
  topLoss: TopLossProduct[]
}

const DAYS = 30
const WEEKS = 8

export default function LossDashboardPage() {
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiGet<DashboardData>(`/api/analytics/loss-dashboard?days=${DAYS}&weeks=${WEEKS}`)
      .then(setData)
      .catch(e => toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败')))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-400">
        <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: PURPLE }} />
        {isEn ? 'Loading...' : '加载中...'}
      </div>
    )
  }

  const kpis = data?.kpis
  const split = data?.dispositionSplit
  const trend = data?.trend ?? []
  const reasons = data?.reasonBreakdown ?? []
  const topLoss = data?.topLoss ?? []
  const trendMax = Math.max(1, ...trend.map(w => w.scrapQty))
  const reasonMax = Math.max(1, ...reasons.map(r => r.qty))
  const stages = data?.stageBreakdown ?? []
  const stageMax = Math.max(1, ...stages.map(r => r.qty))
  const stageInferred = stages.reduce((s2, r) => s2 + r.inferredQty, 0)

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <button onClick={() => router.push(`${prefix}/classic/operator/inventory`)} className="hover:underline">
          {isEn ? 'Inventory' : '库存管理'}
        </button>
        <span>/</span>
        <span style={{ color: PURPLE }}>{isEn ? 'Loss & Returns Dashboard' : '损耗与退货仪表盘'}</span>
      </div>

      <div>
        <h1 className="text-lg font-semibold" style={{ color: PURPLE }}>{isEn ? 'Loss & Returns Dashboard' : '损耗与退货仪表盘'}</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          {isEn
            ? `Warehouse scrap loss + customer return disposition over the last ${DAYS} days, on one page`
            : `近 ${DAYS} 天仓库报废损耗 + 客户退货去向，一张页面看清货去哪了`}
        </p>
      </div>

      {/* KPI row */}
      <div className="bg-white rounded border grid grid-cols-3 divide-x" style={{ borderColor: BORDER }}>
        <div className="p-4">
          <div className="text-xs text-gray-500 flex items-center gap-1.5 mb-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: AMBER }} />{isEn ? 'Scrap value this period' : '本期报废损耗值'}
          </div>
          <div className="text-lg font-bold" style={{ color: AMBER }}>{eur(kpis?.scrapValueThisPeriod ?? 0)}</div>
          <div className="text-xs text-gray-400 mt-0.5">{isEn ? `Last ${DAYS} days, incl. warehouse scrap & return scrap` : `近 ${DAYS} 天，含仓库报废与客退报废`}</div>
        </div>
        <div className="p-4">
          <div className="text-xs text-gray-500 flex items-center gap-1.5 mb-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN }} />{isEn ? 'Return recovery rate' : '退货回收率'}
          </div>
          <div className="text-lg font-bold" style={{ color: kpis?.returnRecoveryRatePct == null ? GRAY : GREEN }}>
            {kpis?.returnRecoveryRatePct == null ? (isEn ? 'No data' : '暂无数据') : `${kpis.returnRecoveryRatePct}%`}
          </div>
          <div className="text-xs text-gray-400 mt-0.5">{isEn ? 'Share of approved returns restocked as sellable' : '已审批退货中回补可售库存的占比'}</div>
        </div>
        <div className="p-4">
          <div className="text-xs text-gray-500 flex items-center gap-1.5 mb-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: RED }} />{isEn ? 'Pending return disposition' : '待处置退货'}
          </div>
          <div className="text-lg font-bold" style={{ color: (kpis?.pendingReturnDisposition ?? 0) > 0 ? RED : GRAY }}>
            {kpis?.pendingReturnDisposition ?? 0}
          </div>
          <div className="text-xs text-gray-400 mt-0.5">{isEn ? 'Current queue depth, all time' : '当前队列深度，不限时间范围'}</div>
        </div>
      </div>

      {/* 退货去向 split bar */}
      <div className="bg-white rounded border p-4" style={{ borderColor: BORDER }}>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">{isEn ? `Return disposition (last ${DAYS} days)` : `退货去向（近 ${DAYS} 天）`}</h2>
        {split && (split.sellableQty + split.scrapQty + split.pendingQty) > 0 ? (
          <>
            <div className="flex h-6 rounded overflow-hidden border" style={{ borderColor: BORDER }}>
              {split.sellablePct > 0 && (
                <div style={{ width: `${split.sellablePct}%`, background: GREEN }} title={isEn ? `Sellable ${split.sellableQty}` : `可再售 ${split.sellableQty}`} />
              )}
              {split.scrapPct > 0 && (
                <div style={{ width: `${split.scrapPct}%`, background: AMBER }} title={isEn ? `Scrap ${split.scrapQty}` : `报废 ${split.scrapQty}`} />
              )}
              {split.pendingPct > 0 && (
                <div style={{ width: `${split.pendingPct}%`, background: GRAY }} title={isEn ? `Pending ${split.pendingQty}` : `待处置 ${split.pendingQty}`} />
              )}
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1.5 mt-3 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: GREEN }} />
                {isEn ? `Sellable ${split.sellableQty} (${split.sellablePct}%)` : `可再售 ${split.sellableQty} (${split.sellablePct}%)`}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: AMBER }} />
                {isEn ? `Scrap ${split.scrapQty} (${split.scrapPct}%)` : `报废 ${split.scrapQty} (${split.scrapPct}%)`}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: GRAY }} />
                {isEn ? `Pending ${split.pendingQty} (${split.pendingPct}%)` : `待处置 ${split.pendingQty} (${split.pendingPct}%)`}
              </span>
            </div>
          </>
        ) : (
          <div className="py-6 text-center text-sm text-gray-400">{isEn ? 'No return data' : '暂无退货数据'}</div>
        )}
      </div>

      {/* Weekly trend */}
      <div className="bg-white rounded border p-4" style={{ borderColor: BORDER }}>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">{isEn ? `Scrap trend, last ${WEEKS} weeks (qty)` : `近 ${WEEKS} 周报废趋势（数量）`}</h2>
        {trend.length === 0 || trend.every(w => w.scrapQty === 0) ? (
          <div className="py-6 text-center text-sm text-gray-400">{isEn ? 'No scrap records' : '暂无报废记录'}</div>
        ) : (
          <div className="flex items-end gap-3 h-32">
            {trend.map(w => {
              const totalH = Math.max(2, Math.round((w.scrapQty / trendMax) * 100))
              const returnH = w.scrapQty > 0 ? Math.round((w.returnScrapQty / w.scrapQty) * totalH) : 0
              return (
                <div key={w.weekLabel} className="flex-1 flex flex-col items-center justify-end h-full">
                  <div className="w-full flex flex-col justify-end rounded-sm overflow-hidden" style={{ height: `${totalH}%`, minHeight: 2, background: '#f0e4ee' }}>
                    <div style={{ height: `${returnH}%`, background: AMBER }} title={isEn ? `Return scrap ${w.returnScrapQty}` : `客退报废 ${w.returnScrapQty}`} />
                    <div style={{ flex: 1, background: PURPLE }} title={isEn ? `Other scrap ${round1(w.scrapQty - w.returnScrapQty)}` : `其他报废 ${round1(w.scrapQty - w.returnScrapQty)}`} />
                  </div>
                  <span className="text-[10px] text-gray-400 mt-1.5">{w.weekLabel}</span>
                  <span className="text-[10px] font-semibold text-gray-600">{w.scrapQty}</span>
                </div>
              )
            })}
          </div>
        )}
        <div className="flex gap-4 mt-3 text-xs text-gray-500">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: PURPLE }} />{isEn ? 'Warehouse scrap' : '仓库报废'}</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: AMBER }} />{isEn ? 'Return scrap' : '客退报废'}</span>
        </div>
      </div>

      {/* Stage breakdown —— 台账 E4 验收：损耗看板按环节可拆 */}
      <div className="bg-white rounded border p-4" style={{ borderColor: BORDER }}>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          {isEn ? `Loss by stage (last ${DAYS} days)` : `损耗环节拆分（近 ${DAYS} 天）`}
        </h2>
        {stages.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-400">{isEn ? 'No scrap records' : '暂无报废记录'}</div>
        ) : (
          <>
            <div className="space-y-2">
              {stages.map(r => (
                <div key={r.stage} className="flex items-center gap-2">
                  <span className="text-xs text-gray-700 w-24 truncate shrink-0">
                    {isEn ? (r.stage === 'UNKNOWN' ? 'Unattributed' : LOSS_STAGE_LABEL_EN[r.stage]) : r.stageLabel}
                  </span>
                  <div className="flex-1 h-4 bg-gray-100 rounded overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${Math.max(4, (r.qty / stageMax) * 100)}%`, background: r.stage === 'UNKNOWN' ? GRAY : PURPLE }} />
                  </div>
                  <span className="text-xs font-mono text-gray-600 w-14 text-right shrink-0">{r.qty}</span>
                  {r.inferredQty > 0 && (
                    <span className="text-[11px] text-gray-400 w-24 shrink-0" title={isEn ? 'Inferred from the scrap reason (historical rows have no stage field)' : '按报废原因推断（历史记录没有环节字段）'}>
                      {isEn ? `${r.inferredQty} inferred` : `其中 ${r.inferredQty} 为推断`}
                    </span>
                  )}
                </div>
              ))}
            </div>
            {stageInferred > 0 && (
              <p className="text-[11px] text-gray-400 mt-3">
                {isEn
                  ? 'Rows created before the stage field existed are attributed by reason; new entries always carry an explicit stage.'
                  : '环节字段上线前的记录按原因推断归类，不做回填；新录入的损耗一律带明确环节。'}
              </p>
            )}
          </>
        )}
      </div>

      <div className="grid grid-cols-2 gap-5">
        {/* Reason breakdown */}
        <div className="bg-white rounded border p-4" style={{ borderColor: BORDER }}>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">{isEn ? `Scrap reasons ranked (last ${DAYS} days)` : `报废原因排行（近 ${DAYS} 天）`}</h2>
          {reasons.length === 0 ? (
            <div className="py-6 text-center text-sm text-gray-400">{isEn ? 'No scrap records' : '暂无报废记录'}</div>
          ) : (
            <div className="space-y-2">
              {reasons.map(r => (
                <div key={r.reason} className="flex items-center gap-2">
                  <span className="text-xs text-gray-700 w-24 truncate shrink-0">{isEn ? (SCRAP_REASON_LABEL_EN[r.reason] ?? r.reasonLabel) : r.reasonLabel}</span>
                  <div className="flex-1 h-4 bg-gray-100 rounded overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${Math.max(4, (r.qty / reasonMax) * 100)}%`, background: AMBER }} />
                  </div>
                  <span className="text-xs font-mono text-gray-600 w-14 text-right shrink-0">{r.qty}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top loss products */}
        <div className="bg-white rounded border overflow-hidden" style={{ borderColor: BORDER }}>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 pt-4 mb-1">{isEn ? `Top loss products (last ${DAYS} days)` : `损耗 TOP 商品（近 ${DAYS} 天）`}</h2>
          {topLoss.length === 0 ? (
            <div className="py-6 text-center text-sm text-gray-400">{isEn ? 'No scrap records' : '暂无报废记录'}</div>
          ) : (
            <div>
              <div
                className="grid gap-2 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide border-b mt-2"
                style={{ borderColor: BORDER, color: PURPLE, background: '#faf5fb', gridTemplateColumns: '1fr 70px 80px' }}
              >
                <span>{isEn ? 'Product' : '商品'}</span><span className="text-right">{isEn ? 'Qty' : '数量'}</span><span className="text-right">{isEn ? 'Loss value' : '损耗值'}</span>
              </div>
              {topLoss.map(item => (
                <div
                  key={item.productId}
                  className="grid gap-2 px-4 py-2.5 border-b last:border-b-0 items-center text-sm"
                  style={{ borderColor: '#f0e4ee', gridTemplateColumns: '1fr 70px 80px' }}
                >
                  <span className="text-gray-800 truncate">{item.productName}</span>
                  <span className="text-right font-mono text-gray-600">{item.scrapQty}</span>
                  <span className="text-right font-mono font-semibold" style={{ color: AMBER }}>{eur(item.scrapValue)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
