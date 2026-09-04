'use client'
import { useState, useEffect, useCallback } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur, DateRangeBar, defaultRange, type DateRange } from '@/components/boss/analytics-shared'

interface AbcRow {
  rank: number; customerId: string; customerName: string
  orderCount: number; salesExTax: number; avgOrder: number
  lastOrderAt: string; klass: 'A' | 'B' | 'C'
}
interface ChurnRow {
  customer_id: string; customer_name: string
  prior_orders: number; prior_amount: number; last_order_at: string
}
interface Payload {
  summary: { activeCustomers: number; newCustomers: number; salesExTax: number; churnCount: number }
  abc: AbcRow[]
  churn: ChurnRow[]
}

const KLASS_CLS: Record<string, string> = {
  A: 'bg-green-100 text-green-800',
  B: 'bg-amber-100 text-amber-800',
  C: 'bg-gray-100 text-gray-500',
}

export default function CustomersAnalyticsPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [range, setRange] = useState<DateRange>(defaultRange())
  const [data, setData] = useState<Payload | null>(null)
  const [tab, setTab] = useState<'abc' | 'churn'>('abc')
  const [search, setSearch] = useState('')
  const [klassFilter, setKlassFilter] = useState<'ALL' | 'A' | 'B' | 'C'>('ALL')

  const load = useCallback((r: DateRange) => {
    setData(null)
    apiGet<Payload>(`/api/analytics/customers?from=${r.from}&to=${r.to}`)
      .then(setData)
      .catch((e) => toast.error(e.message))
  }, [])
  useEffect(() => { load(range) }, [load]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = (data?.abc ?? []).filter((r) =>
    (klassFilter === 'ALL' || r.klass === klassFilter) &&
    (search.trim() === '' || r.customerName.toLowerCase().includes(search.trim().toLowerCase())),
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">{isEn ? 'Customer Analysis' : '客户分析'}</h1>
        <DateRangeBar value={range} onChange={(r) => { setRange(r); load(r) }} />
      </div>

      {!data ? (
        <div className="text-center text-gray-400 py-24 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">{isEn ? 'Active Customers' : '期内活跃客户'}</div>
              <div className="text-2xl font-semibold mt-1">{data.summary.activeCustomers}</div></div>
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">{isEn ? 'New Customers (first order in period)' : '新客户（首单在期内）'}</div>
              <div className="text-2xl font-semibold mt-1">{data.summary.newCustomers}</div></div>
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">{isEn ? 'Revenue (ex. Tax)' : '期内销售额（税前）'}</div>
              <div className="text-2xl font-semibold mt-1 tabular-nums">{eur(data.summary.salesExTax)}</div></div>
            <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">{isEn ? 'Churn Alerts' : '流失预警'}</div>
              <div className={`text-2xl font-semibold mt-1 ${data.summary.churnCount > 0 ? 'text-red-600' : ''}`}>
                {data.summary.churnCount}
              </div></div>
          </div>

          <div className="flex items-center gap-2 border-b">
            {(isEn
              ? [['abc', `ABC Tiering (${data.abc.length})`], ['churn', `Churn Alerts (${data.churn.length})`]] as const
              : [['abc', `ABC 分层（${data.abc.length}）`], ['churn', `流失预警（${data.churn.length}）`]] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`px-4 py-2 text-sm -mb-px border-b-2 ${tab === k ? 'border-[#875A7B] text-[#875A7B] font-medium' : 'border-transparent text-gray-500'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'abc' && (
            <>
              <div className="flex items-center gap-2">
                <input
                  className="border rounded px-3 py-1.5 text-sm w-64"
                  placeholder={isEn ? 'Search customer name…' : '搜索客户名…'}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {(['ALL', 'A', 'B', 'C'] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setKlassFilter(k)}
                    className={`text-xs border rounded px-2.5 py-1 ${klassFilter === k ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'text-gray-600'}`}
                  >
                    {k === 'ALL' ? (isEn ? 'All' : '全部') : (isEn ? `Class ${k}` : `${k} 类`)}
                  </button>
                ))}
                <span className="text-xs text-gray-400 ml-2">
                  {isEn
                    ? 'A = top customers contributing 80% of cumulative revenue; B = 80~95%; C = long tail'
                    : 'A = 累计贡献 80% 销售额的头部客户；B = 80~95%；C = 长尾'}
                </span>
              </div>
              <div className="border rounded overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left">
                    <tr>
                      <th className="px-3 py-2 font-medium w-14">#</th>
                      <th className="px-3 py-2 font-medium">{isEn ? 'Customer' : '客户'}</th>
                      <th className="px-3 py-2 font-medium w-16">{isEn ? 'Tier' : '分层'}</th>
                      <th className="px-3 py-2 font-medium text-right">{isEn ? 'Orders' : '单数'}</th>
                      <th className="px-3 py-2 font-medium text-right">{isEn ? 'Revenue (ex. Tax)' : '销售额（税前）'}</th>
                      <th className="px-3 py-2 font-medium text-right">{isEn ? 'Avg. Order' : '客单价'}</th>
                      <th className="px-3 py-2 font-medium text-right">{isEn ? 'Last Order' : '最后下单'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.customerId} className="border-t hover:bg-gray-50">
                        <td className="px-3 py-1.5 text-gray-400">{r.rank}</td>
                        <td className="px-3 py-1.5">{r.customerName}</td>
                        <td className="px-3 py-1.5">
                          <span className={`text-xs px-2 py-0.5 rounded ${KLASS_CLS[r.klass]}`}>{r.klass}</span>
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.orderCount}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-medium">{eur(r.salesExTax)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{eur(r.avgOrder)}</td>
                        <td className="px-3 py-1.5 text-right text-gray-500">{String(r.lastOrderAt).slice(0, 10)}</td>
                      </tr>
                    ))}
                    {filtered.length === 0 && (
                      <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">{isEn ? 'No matching customers in this period' : '期内没有匹配的客户'}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {tab === 'churn' && (
            <div className="border rounded overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium">{isEn ? 'Customer' : '客户'}</th>
                    <th className="px-3 py-2 font-medium text-right">{isEn ? 'Orders (prior 30d)' : '前 30 天单数'}</th>
                    <th className="px-3 py-2 font-medium text-right">{isEn ? 'Amount (prior 30d, ex. Tax)' : '前 30 天金额（税前）'}</th>
                    <th className="px-3 py-2 font-medium text-right">{isEn ? 'Last Order' : '最后下单'}</th>
                    <th className="px-3 py-2 font-medium text-right">{isEn ? 'Days Silent' : '沉默天数'}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.churn.map((c) => {
                    const silentDays = Math.floor((Date.now() - new Date(c.last_order_at).getTime()) / 86400000)
                    return (
                      <tr key={c.customer_id} className="border-t hover:bg-gray-50">
                        <td className="px-3 py-1.5">{c.customer_name}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{c.prior_orders}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-medium">{eur(c.prior_amount)}</td>
                        <td className="px-3 py-1.5 text-right text-gray-500">{String(c.last_order_at).slice(0, 10)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-red-600">{isEn ? `${silentDays} days` : `${silentDays} 天`}</td>
                      </tr>
                    )
                  })}
                  {data.churn.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-8 text-center text-gray-400">{isEn ? 'No churn alerts 👍' : '没有流失预警 👍'}</td></tr>
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
