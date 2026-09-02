'use client'
import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur, DateRangeBar, defaultRange, type DateRange } from '@/components/boss/analytics-shared'

interface Payload {
  periodFrom: string | null
  periodTo: string | null
  revenue: number
  cogs: number
  grossMargin: number
  grossMarginPct: number
  posted: { journalEntryCount: number }
}

export default function IncomeStatementPage() {
  const [range, setRange] = useState<DateRange>(defaultRange())
  const [data, setData] = useState<Payload | null>(null)

  const load = useCallback((r: DateRange) => {
    apiGet<Payload>(`/api/analytics/income-statement?from=${r.from}&to=${r.to}`)
      .then(setData)
      .catch((e) => toast.error(e.message))
  }, [])

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">利润表</h1>
        <p className="text-sm text-gray-400 mt-0.5">口径：营收 − COGS（毛利），按已过账日记账凭证聚合</p>
      </div>

      <div className="border-l-4 border-amber-400 bg-amber-50 rounded-r-lg px-4 py-3 text-sm text-amber-900">
        <p className="font-medium">当前为毛利口径，运营费用尚未纳入</p>
        <p className="text-amber-800 mt-0.5">
          工资、房租、物流等运营费用目前还没有录入和过账的流程，下面的"毛利"不等于净利润。
          等运营费用记账体系补齐后，这张表会自动把它们算进去，不需要改代码。
        </p>
      </div>

      <DateRangeBar value={range} onChange={(r) => { setRange(r); load(r) }} />

      {!data && <div className="text-center text-gray-400 py-24 text-sm">选择区间后加载…</div>}

      {data && (
        <>
          {data.posted.journalEntryCount === 0 && (
            <div className="border-l-4 border-gray-300 bg-gray-50 rounded-r-lg px-4 py-3 text-sm text-gray-600">
              这个区间内没有任何已过账的日记账凭证，所以下面全是 0——不是功能坏了，是发票/供应商账单
              还没有走"过账"这一步。过账之后数字会自动出现。
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div className="border rounded-lg p-4">
              <div className="text-xs text-gray-500">营收</div>
              <div className="text-2xl font-semibold mt-1 tabular-nums">{eur(data.revenue)}</div>
            </div>
            <div className="border rounded-lg p-4">
              <div className="text-xs text-gray-500">COGS</div>
              <div className="text-2xl font-semibold mt-1 tabular-nums">{eur(data.cogs)}</div>
            </div>
            <div className="border rounded-lg p-4">
              <div className="text-xs text-gray-500">毛利</div>
              <div className={`text-2xl font-semibold mt-1 tabular-nums ${data.grossMargin < 0 ? 'text-red-600' : ''}`}>
                {eur(data.grossMargin)}
              </div>
              <div className="text-xs text-gray-400 mt-1">毛利率 {data.grossMarginPct.toFixed(1)}%</div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
