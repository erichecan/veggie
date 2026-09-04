'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur, DateRangeBar, defaultRange, type DateRange } from '@/components/boss/analytics-shared'
import { SummaryTable, PeriodTable, DetailTable } from '@/components/boss/driver-commission-tables'
import { detailToCsv, type DriverCommissionPayload, type PeriodGrain } from '@/lib/analytics/driver-commission'

const GRAINS_ZH: Array<{ v: PeriodGrain; label: string }> = [
  { v: 'day', label: '日' }, { v: 'week', label: '周' }, { v: 'month', label: '月' },
]
const GRAINS_EN: Array<{ v: PeriodGrain; label: string }> = [
  { v: 'day', label: 'Day' }, { v: 'week', label: 'Week' }, { v: 'month', label: 'Month' },
]

export default function DriverCommissionPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const GRAINS = isEn ? GRAINS_EN : GRAINS_ZH
  const [range, setRange] = useState<DateRange>(defaultRange())
  const [grain, setGrain] = useState<PeriodGrain>('day')
  // 选中的司机用 (id, name) 这一对表示 —— 与汇总的分组键一致。
  // 只存 id 的话，同一个 driverId 下的几个司机名会被一起选中（实测数据就是这样）。
  const [picked, setPicked] = useState<{ id: string | null; name: string } | null>(null)
  const [data, setData] = useState<DriverCommissionPayload | null>(null)

  const load = useCallback((r: DateRange, g: PeriodGrain, d: { id: string | null; name: string } | null) => {
    setData(null)
    const qs = new URLSearchParams({ from: r.from, to: r.to, grain: g })
    if (d?.id) qs.set('driverId', d.id)
    if (d?.name) qs.set('driverName', d.name)
    apiGet<DriverCommissionPayload>(`/api/analytics/driver-commission?${qs}`)
      .then(setData).catch((e) => toast.error(e.message))
  }, [])
  useEffect(() => { load(range, grain, picked) }, [load, grain, picked]) // eslint-disable-line react-hooks/exhaustive-deps

  const grainLabel = useMemo(() => GRAINS.find(g => g.v === grain)?.label ?? GRAINS[0].label, [grain, GRAINS])

  const download = () => {
    if (!data) return
    const blob = new Blob([detailToCsv(data.detail)], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${isEn ? 'driver-commission' : '司机提成'}_${range.from}_${range.to}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const t = data?.totals
  const pending = t ? t.orderCount - t.frozenOrderCount : 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">{isEn ? 'Driver Commission' : '司机提成考核'}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded border overflow-hidden text-sm">
            {GRAINS.map(g => (
              <button
                key={g.v}
                onClick={() => setGrain(g.v)}
                className={`px-3 py-1 ${grain === g.v ? 'bg-purple-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >{g.label}</button>
            ))}
          </div>
          <button
            onClick={download}
            disabled={!data || data.detail.length === 0}
            className="px-3 py-1 text-sm border rounded text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >{isEn ? 'Export Detail CSV' : '导出明细 CSV'}</button>
          <DateRangeBar value={range} onChange={(r) => { setRange(r); load(r, grain, picked) }} />
        </div>
      </div>

      {picked && (
        <div className="text-sm text-purple-800 bg-purple-50 border border-purple-200 rounded px-3 py-1.5 flex items-center justify-between">
          <span>{isEn ? `Filtered: only ${picked.name}` : `已筛选：只看 ${picked.name}`}</span>
          <button className="underline" onClick={() => setPicked(null)}>{isEn ? 'Clear' : '清除'}</button>
        </div>
      )}

      {!data ? (
        <div className="text-center text-gray-400 py-24 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(isEn ? [
              { label: 'Recomputed Total', value: eur(t!.computedTotal), hint: `${t!.driverCount} drivers / ${t!.orderCount} orders` },
              { label: 'Frozen Total', value: eur(t!.frozenTotal), hint: `${t!.frozenOrderCount} orders frozen` },
              { label: 'Pending Freeze', value: String(pending), hint: pending > 0 ? 'Not yet payable' : 'All frozen' },
              { label: 'Recomputed − Frozen', value: eur(t!.diff), hint: Math.abs(t!.diff) < 0.01 ? 'Matches' : 'Delivered qty changed after freeze' },
            ] : [
              { label: '重算合计', value: eur(t!.computedTotal), hint: `${t!.driverCount} 名司机 / ${t!.orderCount} 单` },
              { label: '已冻结合计', value: eur(t!.frozenTotal), hint: `${t!.frozenOrderCount} 单已冻结` },
              { label: '待冻结', value: String(pending), hint: pending > 0 ? '这些单还不能据以发钱' : '全部已冻结' },
              { label: '重算 − 冻结', value: eur(t!.diff), hint: Math.abs(t!.diff) < 0.01 ? '一致' : '冻结后实送量被改过' },
            ]).map((k, i) => (
              <div key={k.label} className="border rounded-lg p-3">
                <div className="text-xs text-gray-500">{k.label}</div>
                <div className={`text-xl font-semibold ${i === 2 && pending > 0 ? 'text-amber-700' : 'text-gray-900'}`}>{k.value}</div>
                <div className="text-xs text-gray-400 mt-0.5">{k.hint}</div>
              </div>
            ))}
          </div>

          <SummaryTable rows={data.byDriver} onPick={setPicked} picked={picked} isEn={isEn} />
          <PeriodTable rows={data.byPeriod} grainLabel={grainLabel} isEn={isEn} />
          <DetailTable rows={data.detail} truncated={data.detailTruncated} locale={locale} isEn={isEn} />

          <p className="text-xs text-gray-400 leading-relaxed">
            {isEn ? (
              <>Basis: commission belongs to <strong className="text-gray-500">the driver who actually ran the trip</strong> (the
              trip&apos;s driver), not the driver planned on the order. &ldquo;Recomputed Total&rdquo; is computed live from the formula in{' '}
              <code>lib/commission.ts</code>; &ldquo;Frozen Total&rdquo; is the snapshot persisted at delivery. A mismatch usually means the
              delivered quantity was changed after freezing (e.g. a return review) — the difference is listed separately, not
              smoothed over.</>
            ) : (
              <>口径：提成归属于<strong className="text-gray-500">实际跑这趟的司机</strong>（行程上的司机），不是订单上计划派的司机。
              「重算合计」按 <code>lib/commission.ts</code> 的公式即时算出；「冻结合计」是送达时落库的快照。
              两者不一致通常意味着冻结之后实送量又被改过（例如退货审核），差额单列一列而不是抹平。</>
            )}
          </p>
        </>
      )}
    </div>
  )
}
