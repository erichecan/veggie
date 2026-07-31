'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur, DateRangeBar, defaultRange, type DateRange } from '@/components/boss/analytics-shared'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend } from 'recharts'

interface DailyPoint { date: string; salesExTax: number; salesIncTax: number; orderCount: number; aov: number }
interface ShortageDayRow { day: string; shortage_lines: number; order_lines: number }
interface TopProduct { productId: string; productName: string; subtotal: number; qty: number }

interface Payload {
  dailySeries: DailyPoint[]
  shortage: { series: ShortageDayRow[]; summary: { shortageLines: number; orderLines: number; shortageRate: number } }
  topProducts: TopProduct[]
}

export default function SalesOverviewPage() {
  const [range, setRange] = useState<DateRange>(defaultRange(7))
  const [data, setData] = useState<Payload | null>(null)

  const load = useCallback((r: DateRange) => {
    setData(null)
    apiGet<Payload>(`/api/analytics/sales-overview?from=${r.from}&to=${r.to}`)
      .then(setData)
      .catch((e) => toast.error(e.message))
  }, [])
  useEffect(() => { load(range) }, [load]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <div className="text-center text-gray-400 py-24 text-sm">加载中…</div>

  const totalSalesExTax = data.dailySeries.reduce((s, d) => s + d.salesExTax, 0)
  const totalOrders = data.dailySeries.reduce((s, d) => s + d.orderCount, 0)
  const avgAov = totalOrders > 0 ? Math.round((totalSalesExTax / totalOrders) * 100) / 100 : 0

  const salesChartData = data.dailySeries.map((d) => ({
    day: String(d.date).slice(5, 10),
    销售额税前: d.salesExTax,
    销售额税后: d.salesIncTax,
  }))
  const aovChartData = data.dailySeries.map((d) => ({
    day: String(d.date).slice(5, 10),
    客单价: d.aov,
  }))
  const shortageChartData = data.shortage.series.map((d) => ({
    day: String(d.day).slice(5, 10),
    缺货率: d.order_lines > 0 ? Math.round((d.shortage_lines / d.order_lines) * 1000) / 10 : 0,
  }))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">销售统计</h1>
          <p className="text-sm text-gray-400 mt-0.5">日销售额 / 客单价 / 缺货率趋势 + 关键商品排行 · 历史读每日快照</p>
        </div>
        <DateRangeBar value={range} onChange={(r) => { setRange(r); load(r) }} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">期间销售额（税前）</div>
          <div className="text-2xl font-semibold mt-1 tabular-nums">{eur(totalSalesExTax)}</div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">期间订单数</div>
          <div className="text-2xl font-semibold mt-1 tabular-nums">{totalOrders}</div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">平均客单价</div>
          <div className="text-2xl font-semibold mt-1 tabular-nums">{eur(avgAov)}</div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">缺货率</div>
          <div className={`text-2xl font-semibold mt-1 tabular-nums ${data.shortage.summary.shortageRate > 0 ? 'text-red-600' : ''}`}>
            {(data.shortage.summary.shortageRate * 100).toFixed(1)}%
          </div>
          <div className="text-xs text-gray-400 mt-1">{data.shortage.summary.shortageLines} / {data.shortage.summary.orderLines} 行</div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="border rounded-lg p-4 bg-white">
          <h2 className="text-sm font-medium text-gray-500 mb-3">日销售额趋势</h2>
          {salesChartData.length === 0 ? (
            <div className="text-center text-gray-400 py-10 text-sm">暂无数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={salesChartData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                <XAxis dataKey="day" fontSize={11} />
                <YAxis fontSize={11} tickFormatter={(v) => `€${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`} />
                <Tooltip formatter={(v: unknown) => eur(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="销售额税前" stroke="#875A7B" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="销售额税后" stroke="#28a745" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="border rounded-lg p-4 bg-white">
          <h2 className="text-sm font-medium text-gray-500 mb-3">客单价趋势</h2>
          {aovChartData.length === 0 ? (
            <div className="text-center text-gray-400 py-10 text-sm">暂无数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={aovChartData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                <XAxis dataKey="day" fontSize={11} />
                <YAxis fontSize={11} tickFormatter={(v) => `€${v}`} />
                <Tooltip formatter={(v: unknown) => eur(Number(v))} />
                <Line type="monotone" dataKey="客单价" stroke="#875A7B" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="border rounded-lg p-4 bg-white">
          <h2 className="text-sm font-medium text-gray-500 mb-3">缺货率趋势</h2>
          {shortageChartData.length === 0 ? (
            <div className="text-center text-gray-400 py-10 text-sm">暂无数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={shortageChartData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                <XAxis dataKey="day" fontSize={11} />
                <YAxis fontSize={11} tickFormatter={(v) => `${v}%`} />
                <Tooltip formatter={(v: unknown) => `${v}%`} />
                <Line type="monotone" dataKey="缺货率" stroke="#dc3545" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="border rounded-lg p-4 bg-white">
          <h2 className="text-sm font-medium text-gray-500 mb-3">关键商品 Top 10（按销售额）</h2>
          {data.topProducts.length === 0 ? (
            <div className="text-center text-gray-400 py-10 text-sm">期内没有销售数据</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-gray-400">
                <tr>
                  <th className="py-1 font-medium">#</th>
                  <th className="py-1 font-medium">商品</th>
                  <th className="py-1 font-medium text-right">数量</th>
                  <th className="py-1 font-medium text-right">销售额</th>
                </tr>
              </thead>
              <tbody>
                {data.topProducts.map((p, i) => (
                  <tr key={p.productId} className="border-t">
                    <td className="py-1.5 text-gray-400">{i + 1}</td>
                    <td className="py-1.5">{p.productName}</td>
                    <td className="py-1.5 text-right tabular-nums text-gray-500">{p.qty}</td>
                    <td className="py-1.5 text-right tabular-nums font-medium">{eur(p.subtotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
