'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur, DateRangeBar, defaultRange, type DateRange } from '@/components/boss/analytics-shared'

type GroupBy = 'product' | 'category' | 'customer' | 'salesUser'

interface Row {
  key: string; name: string; lineCount: number; qty: number
  revenueExTax: number; cost: number; grossProfit: number
  marginPct: number; costCoverage: number
}

interface Payload {
  summary: { revenueExTax: number; grossProfit: number; marginPct: number; costCoverageRate: number }
  rows: Row[]
}

const GROUP_TABS: Array<{ key: GroupBy; label: string }> = [
  { key: 'product', label: '按商品' },
  { key: 'category', label: '按分类' },
  { key: 'customer', label: '按客户' },
  { key: 'salesUser', label: '按业务员' },
]

export default function MarginAnalyticsPage() {
  const [range, setRange] = useState<DateRange>(defaultRange())
  const [groupBy, setGroupBy] = useState<GroupBy>('product')
  const [data, setData] = useState<Payload | null>(null)
  const [search, setSearch] = useState('')

  const load = useCallback((r: DateRange, g: GroupBy) => {
    setData(null)
    apiGet<Payload>(`/api/analytics/margin?from=${r.from}&to=${r.to}&groupBy=${g}`)
      .then(setData)
      .catch((e) => toast.error(e.message))
  }, [])
  useEffect(() => { load(range, groupBy) }, [load]) // eslint-disable-line react-hooks/exhaustive-deps

  const coverage = (data?.summary.costCoverageRate ?? 0) * 100
  const filtered = (data?.rows ?? []).filter((r) =>
    search.trim() === '' || r.name.toLowerCase().includes(search.trim().toLowerCase()),
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">毛利分析</h1>
        <DateRangeBar value={range} onChange={(r) => { setRange(r); load(r, groupBy) }} />
      </div>

      {data && coverage < 70 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded px-4 py-2.5">
          ⚠ 实际批次成本覆盖率仅 {coverage.toFixed(0)}%，其余按标准成本（收货加权平均）估算。
          批次成本随收货流程自动积累，覆盖率会逐步上升。
        </div>
      )}

      {!data ? (
        <div className="text-center text-gray-400 py-24 text-sm">加载中…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">销售额（税前）</div>
              <div className="text-2xl font-semibold mt-1 tabular-nums">{eur(data.summary.revenueExTax)}</div></div>
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">毛利</div>
              <div className={`text-2xl font-semibold mt-1 tabular-nums ${data.summary.grossProfit < 0 ? 'text-red-600' : 'text-green-700'}`}>
                {eur(data.summary.grossProfit)}</div></div>
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">毛利率</div>
              <div className="text-2xl font-semibold mt-1 tabular-nums">{data.summary.marginPct.toFixed(1)}%</div></div>
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">实际成本覆盖率</div>
              <div className="text-2xl font-semibold mt-1 tabular-nums">{coverage.toFixed(0)}%</div>
              <div className="text-xs text-gray-400 mt-1">其余按标准成本估算</div></div>
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
              placeholder="搜索…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="text-xs text-gray-400">{filtered.length} 行，按毛利降序</span>
          </div>

          <div className="border rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">{GROUP_TABS.find(t => t.key === groupBy)?.label.slice(1)}</th>
                  <th className="px-3 py-2 font-medium text-right">数量</th>
                  <th className="px-3 py-2 font-medium text-right">销售额（税前）</th>
                  <th className="px-3 py-2 font-medium text-right">成本</th>
                  <th className="px-3 py-2 font-medium text-right">毛利</th>
                  <th className="px-3 py-2 font-medium text-right">毛利率</th>
                  <th className="px-3 py-2 font-medium text-right">成本口径</th>
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
                        {r.costCoverage >= 0.999 ? '批次' : r.costCoverage > 0 ? `批次 ${(r.costCoverage * 100).toFixed(0)}%` : '标准'}
                      </span>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">期内没有数据</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
