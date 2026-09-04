'use client'
import { useState, useEffect, useCallback } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur, DateRangeBar, defaultRange, type DateRange } from '@/components/boss/analytics-shared'
import PivotView from './PivotView'

type GroupBy = 'product' | 'category' | 'customer' | 'salesUser'
type Mode = 'single' | 'pivot'

interface Row {
  key: string; name: string; lineCount: number; qty: number
  revenueExTax: number; cost: number; grossProfit: number
  marginPct: number; costCoverage: number
}

interface Payload {
  summary: { revenueExTax: number; grossProfit: number; marginPct: number; costCoverageRate: number }
  rows: Row[]
}

const GROUP_TABS_ZH: Array<{ key: GroupBy; label: string; short: string }> = [
  { key: 'product', label: '按商品', short: '商品' },
  { key: 'category', label: '按分类', short: '分类' },
  { key: 'customer', label: '按客户', short: '客户' },
  { key: 'salesUser', label: '按业务员', short: '业务员' },
]
const GROUP_TABS_EN: Array<{ key: GroupBy; label: string; short: string }> = [
  { key: 'product', label: 'By Product', short: 'Product' },
  { key: 'category', label: 'By Category', short: 'Category' },
  { key: 'customer', label: 'By Customer', short: 'Customer' },
  { key: 'salesUser', label: 'By Salesperson', short: 'Salesperson' },
]

export default function MarginAnalyticsPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const GROUP_TABS = isEn ? GROUP_TABS_EN : GROUP_TABS_ZH
  const [range, setRange] = useState<DateRange>(defaultRange())
  const [mode, setMode] = useState<Mode>('single')
  const [groupBy, setGroupBy] = useState<GroupBy>('product')
  const [data, setData] = useState<Payload | null>(null)
  const [search, setSearch] = useState('')

  const load = useCallback((r: DateRange, g: GroupBy) => {
    setData(null)
    apiGet<Payload>(`/api/analytics/margin?from=${r.from}&to=${r.to}&groupBy=${g}`)
      .then(setData)
      .catch((e) => toast.error(e.message))
  }, [])
  useEffect(() => { if (mode === 'single') load(range, groupBy) }, [load, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  const coverage = (data?.summary.costCoverageRate ?? 0) * 100
  const filtered = (data?.rows ?? []).filter((r) =>
    search.trim() === '' || r.name.toLowerCase().includes(search.trim().toLowerCase()),
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">{isEn ? 'Margin Analysis' : '毛利分析'}</h1>
        <div className="flex items-center gap-3">
          <div className="flex border rounded overflow-hidden text-sm">
            {(['single', 'pivot'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 ${mode === m ? 'bg-[#875A7B] text-white' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                {m === 'single' ? (isEn ? 'Single Dimension' : '单维度') : (isEn ? 'Pivot Mode' : '透视模式')}
              </button>
            ))}
          </div>
          <DateRangeBar value={range} onChange={(r) => { setRange(r); if (mode === 'single') load(r, groupBy) }} />
        </div>
      </div>

      {mode === 'pivot' ? (
        <PivotView range={range} isEn={isEn} />
      ) : (
        <>
          {data && coverage < 70 && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded px-4 py-2.5">
              {isEn
                ? `⚠ Actual lot-cost coverage is only ${coverage.toFixed(0)}% — the rest is estimated at standard cost (weighted-average on receipt). Lot cost accumulates automatically through the receiving process, so coverage rises over time.`
                : `⚠ 实际批次成本覆盖率仅 ${coverage.toFixed(0)}%，其余按标准成本（收货加权平均）估算。批次成本随收货流程自动积累，覆盖率会逐步上升。`}
            </div>
          )}

          {!data ? (
            <div className="text-center text-gray-400 py-24 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">{isEn ? 'Revenue (ex. Tax)' : '销售额（税前）'}</div>
                  <div className="text-2xl font-semibold mt-1 tabular-nums">{eur(data.summary.revenueExTax)}</div></div>
                <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">{isEn ? 'Gross Profit' : '毛利'}</div>
                  <div className={`text-2xl font-semibold mt-1 tabular-nums ${data.summary.grossProfit < 0 ? 'text-red-600' : 'text-green-700'}`}>
                    {eur(data.summary.grossProfit)}</div></div>
                <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">{isEn ? 'Margin %' : '毛利率'}</div>
                  <div className="text-2xl font-semibold mt-1 tabular-nums">{data.summary.marginPct.toFixed(1)}%</div></div>
                <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">{isEn ? 'Actual Cost Coverage' : '实际成本覆盖率'}</div>
                  <div className="text-2xl font-semibold mt-1 tabular-nums">{coverage.toFixed(0)}%</div>
                  <div className="text-xs text-gray-400 mt-1">{isEn ? 'Rest estimated at standard cost' : '其余按标准成本估算'}</div></div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex border rounded overflow-hidden">
                  {GROUP_TABS.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => { setGroupBy(t.key); load(range, t.key) }}
                      className={`px-4 py-1.5 text-sm ${groupBy === t.key ? 'bg-[#875A7B] text-white' : 'text-gray-600 hover:bg-gray-50'}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <input
                  className="border rounded px-3 py-1.5 text-sm w-64"
                  placeholder={isEn ? 'Search…' : '搜索…'}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <span className="text-xs text-gray-400">{isEn ? `${filtered.length} rows, sorted by margin desc.` : `${filtered.length} 行，按毛利降序`}</span>
              </div>

              <div className="border rounded overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left">
                    <tr>
                      <th className="px-3 py-2 font-medium">{GROUP_TABS.find(t => t.key === groupBy)?.short}</th>
                      <th className="px-3 py-2 font-medium text-right">{isEn ? 'Qty' : '数量'}</th>
                      <th className="px-3 py-2 font-medium text-right">{isEn ? 'Revenue (ex. Tax)' : '销售额（税前）'}</th>
                      <th className="px-3 py-2 font-medium text-right">{isEn ? 'Cost' : '成本'}</th>
                      <th className="px-3 py-2 font-medium text-right">{isEn ? 'Gross Profit' : '毛利'}</th>
                      <th className="px-3 py-2 font-medium text-right">{isEn ? 'Margin %' : '毛利率'}</th>
                      <th className="px-3 py-2 font-medium text-right">{isEn ? 'Cost Basis' : '成本口径'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.key} className="border-t hover:bg-gray-50">
                        <td className="px-3 py-1.5">{r.name}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{r.qty}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{eur(r.revenueExTax)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{eur(r.cost)}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${r.grossProfit < 0 ? 'text-red-600' : ''}`}>
                          {eur(r.grossProfit)}
                        </td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${r.marginPct < 0 ? 'text-red-600' : r.marginPct < 10 ? 'text-amber-600' : ''}`}>
                          {r.marginPct.toFixed(1)}%
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${r.costCoverage >= 0.999 ? 'bg-green-100 text-green-700' : r.costCoverage > 0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                            {r.costCoverage >= 0.999 ? (isEn ? 'Lot' : '批次') : r.costCoverage > 0 ? (isEn ? `Lot ${(r.costCoverage * 100).toFixed(0)}%` : `批次 ${(r.costCoverage * 100).toFixed(0)}%`) : (isEn ? 'Standard' : '标准')}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {filtered.length === 0 && (
                      <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">{isEn ? 'No data in this period' : '期内没有数据'}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
