'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur, DateRangeBar, defaultRange, type DateRange } from '@/components/boss/analytics-shared'
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend } from 'recharts'

interface DriverRow {
  driver: string; tripCount: number; stopCount: number
  totalPayment: number; amountPerStop: number
  totalCollected: number; difference: number; settledCount: number
}
interface DispatchRow {
  day: string; wave_type: string | null; driver: string | null
  order_count: number; dispatched_at: string
}
interface Payload {
  byDriver: DriverRow[]
  daily: Array<{ day: string; trip_count: number; stop_count: number; total_payment: number }>
  dispatchLog: DispatchRow[]
}

export default function LogisticsAnalyticsPage() {
  const [range, setRange] = useState<DateRange>(defaultRange())
  const [data, setData] = useState<Payload | null>(null)

  const load = useCallback((r: DateRange) => {
    setData(null)
    apiGet<Payload>(`/api/analytics/logistics?from=${r.from}&to=${r.to}`)
      .then(setData).catch((e) => toast.error(e.message))
  }, [])
  useEffect(() => { load(range) }, [load]) // eslint-disable-line react-hooks/exhaustive-deps

  const trendData = (data?.daily ?? []).map((d) => ({
    day: String(d.day).slice(5, 10),
    配送金额: d.total_payment,
    行程数: d.trip_count,
  }))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">物流分析</h1>
        <DateRangeBar value={range} onChange={(r) => { setRange(r); load(r) }} />
      </div>

      {!data ? (
        <div className="text-center text-gray-400 py-24 text-sm">加载中…</div>
      ) : (
        <>
          <div className="border rounded-lg p-4">
            <h2 className="text-sm font-medium text-gray-500 mb-3">每日配送金额 / 行程数</h2>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={trendData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                <XAxis dataKey="day" fontSize={11} />
                <YAxis yAxisId="amt" fontSize={11} tickFormatter={(v) => `€${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`} />
                <YAxis yAxisId="cnt" orientation="right" fontSize={11} allowDecimals={false} />
                <Tooltip formatter={(v: unknown, name: unknown) => name === '行程数' ? Number(v) : eur(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar yAxisId="cnt" dataKey="行程数" fill="#E5E0EC" radius={[2, 2, 0, 0]} />
                <Line yAxisId="amt" type="monotone" dataKey="配送金额" stroke="#875A7B" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="border rounded overflow-hidden">
            <div className="px-3 py-2 bg-gray-50 text-sm font-medium">司机日装载 & 交账差异</div>
            <table className="w-full text-sm">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="px-3 py-1.5 font-medium">司机</th>
                  <th className="px-3 py-1.5 font-medium text-right">行程数</th>
                  <th className="px-3 py-1.5 font-medium text-right">配送站点数</th>
                  <th className="px-3 py-1.5 font-medium text-right">配送金额</th>
                  <th className="px-3 py-1.5 font-medium text-right">单站均金额</th>
                  <th className="px-3 py-1.5 font-medium text-right">已收金额</th>
                  <th className="px-3 py-1.5 font-medium text-right">交账差异</th>
                  <th className="px-3 py-1.5 font-medium text-right">已确认交账</th>
                </tr>
              </thead>
              <tbody>
                {data.byDriver.map((d) => (
                  <tr key={d.driver} className="border-t">
                    <td className="px-3 py-1.5">{d.driver}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{d.tripCount}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{d.stopCount}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-medium">{eur(d.totalPayment)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{eur(d.amountPerStop)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{eur(d.totalCollected)}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${Math.abs(d.difference) > 0.01 ? 'text-red-600 font-medium' : 'text-gray-400'}`}>
                      {d.difference > 0 ? `+${eur(d.difference)}` : eur(d.difference)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{d.settledCount}/{d.tripCount}</td>
                  </tr>
                ))}
                {data.byDriver.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400">期内没有行程记录</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="border rounded overflow-hidden">
            <div className="px-3 py-2 bg-gray-50 text-sm font-medium">出发记录（最近 100 条，按出发时间倒序）</div>
            <table className="w-full text-sm">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="px-3 py-1.5 font-medium">日期</th>
                  <th className="px-3 py-1.5 font-medium">班次</th>
                  <th className="px-3 py-1.5 font-medium">司机</th>
                  <th className="px-3 py-1.5 font-medium text-right">订单数</th>
                  <th className="px-3 py-1.5 font-medium text-right">出发时间</th>
                </tr>
              </thead>
              <tbody>
                {data.dispatchLog.map((d, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-1.5 text-gray-500">{String(d.day).slice(0, 10)}</td>
                    <td className="px-3 py-1.5">{d.wave_type ?? '—'}</td>
                    <td className="px-3 py-1.5">{d.driver ?? '未指定'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{d.order_count}</td>
                    <td className="px-3 py-1.5 text-right text-gray-500">
                      {new Date(d.dispatched_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}
                    </td>
                  </tr>
                ))}
                {data.dispatchLog.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-8 text-center text-gray-400">期内没有出发记录</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
