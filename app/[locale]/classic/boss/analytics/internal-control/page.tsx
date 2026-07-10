'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur, DateRangeBar, defaultRange, type DateRange } from '@/components/boss/analytics-shared'
import { formatDateTime } from '@/lib/format-date'

interface PriceChange {
  id: string; orderId: string; orderCode: string | null; operator: string
  totalBefore: number; totalAfter: number; delta: number; changedAt: string
}
interface OperatorRow { operator: string; changeCount: number; decreaseCount: number; decreaseAmount: number }
interface TimelinessRow { creator: string; orderCount: number; avgHours: number | null }
interface Payload { priceChanges: PriceChange[]; byOperator: OperatorRow[]; timeliness: TimelinessRow[] }

export default function InternalControlPage() {
  const [range, setRange] = useState<DateRange>(defaultRange())
  const [data, setData] = useState<Payload | null>(null)
  const [tab, setTab] = useState<'changes' | 'operator' | 'timeliness'>('changes')

  const load = useCallback((r: DateRange) => {
    setData(null)
    apiGet<Payload>(`/api/analytics/internal-control?from=${r.from}&to=${r.to}`)
      .then(setData).catch((e) => toast.error(e.message))
  }, [])
  useEffect(() => { load(range) }, [load]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">内控审计</h1>
        <DateRangeBar value={range} onChange={(r) => { setRange(r); load(r) }} />
      </div>

      {!data ? (
        <div className="text-center text-gray-400 py-24 text-sm">加载中…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">期内改单次数</div>
              <div className="text-2xl font-semibold mt-1">{data.priceChanges.length}</div></div>
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">降价总额</div>
              <div className="text-2xl font-semibold mt-1 tabular-nums text-red-600">
                {eur(data.priceChanges.filter(c => c.delta < 0).reduce((s, c) => s - c.delta, 0))}
              </div></div>
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">平均创建→确认耗时</div>
              <div className="text-2xl font-semibold mt-1">
                {data.timeliness.length > 0
                  ? `${(data.timeliness.reduce((s, t) => s + (t.avgHours ?? 0) * t.orderCount, 0) / data.timeliness.reduce((s, t) => s + t.orderCount, 0)).toFixed(1)}h`
                  : '—'}
              </div></div>
          </div>

          <div className="flex items-center gap-2 border-b">
            {([['changes', `改价明细（${data.priceChanges.length}）`], ['operator', '按操作员'], ['timeliness', '操作时效']] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`px-4 py-2 text-sm -mb-px border-b-2 ${tab === k ? 'border-[#875A7B] text-[#875A7B] font-medium' : 'border-transparent text-gray-500'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'changes' && (
            <div className="border rounded overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium">订单</th>
                    <th className="px-3 py-2 font-medium">操作员</th>
                    <th className="px-3 py-2 font-medium text-right">改前金额</th>
                    <th className="px-3 py-2 font-medium text-right">改后金额</th>
                    <th className="px-3 py-2 font-medium text-right">变化</th>
                    <th className="px-3 py-2 font-medium text-right">时间</th>
                  </tr>
                </thead>
                <tbody>
                  {data.priceChanges.map((c) => (
                    <tr key={c.id} className="border-t hover:bg-gray-50">
                      <td className="px-3 py-1.5 text-gray-500">{c.orderCode ?? c.orderId.slice(0, 8)}</td>
                      <td className="px-3 py-1.5">{c.operator}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{eur(c.totalBefore)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{eur(c.totalAfter)}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${c.delta < 0 ? 'text-red-600' : 'text-green-700'}`}>
                        {c.delta > 0 ? `+${eur(c.delta)}` : eur(c.delta)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-400 text-xs">
                        {formatDateTime(c.changedAt)}
                      </td>
                    </tr>
                  ))}
                  {data.priceChanges.length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">期内没有改价记录</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'operator' && (
            <div className="border rounded overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium">操作员</th>
                    <th className="px-3 py-2 font-medium text-right">改单次数</th>
                    <th className="px-3 py-2 font-medium text-right">降价次数</th>
                    <th className="px-3 py-2 font-medium text-right">降价总额</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byOperator.map((o) => (
                    <tr key={o.operator} className="border-t hover:bg-gray-50">
                      <td className="px-3 py-1.5">{o.operator}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{o.changeCount}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{o.decreaseCount}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-red-600 font-medium">{eur(o.decreaseAmount)}</td>
                    </tr>
                  ))}
                  {data.byOperator.length === 0 && (
                    <tr><td colSpan={4} className="px-3 py-8 text-center text-gray-400">期内没有改单记录</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'timeliness' && (
            <div className="border rounded overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium">创建人</th>
                    <th className="px-3 py-2 font-medium text-right">已确认订单数</th>
                    <th className="px-3 py-2 font-medium text-right">平均创建→确认耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {data.timeliness.map((t) => (
                    <tr key={t.creator} className="border-t hover:bg-gray-50">
                      <td className="px-3 py-1.5">{t.creator}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{t.orderCount}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{t.avgHours === null ? '—' : `${t.avgHours.toFixed(1)}h`}</td>
                    </tr>
                  ))}
                  {data.timeliness.length === 0 && (
                    <tr><td colSpan={3} className="px-3 py-8 text-center text-gray-400">期内没有已确认订单</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
