'use client'
import { useState, useEffect } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur } from '@/components/boss/analytics-shared'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts'

type BucketKey = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus' | 'unknown'

interface CustomerRow {
  customerId: string
  customerName: string
  total: number
  invoiceCount: number
  buckets: Record<BucketKey, number>
  oldestDue: string | null
  lastPaidAt: string | null
}

interface Payload {
  totalDue: number
  invoiceCount: number
  unknownCount: number
  buckets: Array<{ key: BucketKey; label: string; amount: number }>
  customers: CustomerRow[]
}

const BUCKET_COLORS: Record<BucketKey, string> = {
  current: '#28a745',
  d1_30: '#ffc107',
  d31_60: '#fd7e14',
  d61_90: '#dc3545',
  d90_plus: '#8b0000',
  unknown: '#9ca3af',
}

export default function ArAgingPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [data, setData] = useState<Payload | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    apiGet<Payload>('/api/analytics/ar-aging').then(setData).catch((e) => toast.error(e.message))
  }, [])

  if (!data) return <div className="text-center text-gray-400 py-24 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>

  const overdue = data.buckets
    .filter((b) => b.key !== 'current' && b.key !== 'unknown')
    .reduce((s, b) => s + b.amount, 0)

  const filtered = data.customers.filter((c) =>
    search.trim() === '' || c.customerName.toLowerCase().includes(search.trim().toLowerCase()),
  )

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{isEn ? 'AR Aging' : '应收账龄'}</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          {isEn
            ? 'Basis: posted (POSTED) invoices not yet fully collected, bucketed by due date · real-time'
            : '口径：已过账（POSTED）且未收清的发票，按到期日分桶 · 实时'}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">{isEn ? 'Total Receivable' : '应收总额'}</div>
          <div className="text-2xl font-semibold mt-1 tabular-nums">{eur(data.totalDue)}</div>
          <div className="text-xs text-gray-400 mt-1">{isEn ? `${data.invoiceCount} unpaid invoices` : `${data.invoiceCount} 张未收清发票`}</div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">{isEn ? 'Overdue' : '已逾期'}</div>
          <div className={`text-2xl font-semibold mt-1 tabular-nums ${overdue > 0 ? 'text-red-600' : ''}`}>{eur(overdue)}</div>
          <div className="text-xs text-gray-400 mt-1">
            {isEn ? `${data.totalDue > 0 ? ((overdue / data.totalDue) * 100).toFixed(0) : 0}% of total` : `占比 ${data.totalDue > 0 ? ((overdue / data.totalDue) * 100).toFixed(0) : 0}%`}
          </div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">{isEn ? '90+ Days (High Risk)' : '90+ 天（高风险）'}</div>
          <div className="text-2xl font-semibold mt-1 tabular-nums text-red-700">
            {eur(data.buckets.find((b) => b.key === 'd90_plus')?.amount ?? 0)}
          </div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">{isEn ? 'Due Date Unresolved' : '到期日无法解析'}</div>
          <div className="text-2xl font-semibold mt-1">{data.unknownCount}</div>
          <div className="text-xs text-gray-400 mt-1">{isEn ? 'invoices (data needs fixing; amount listed separately)' : '张发票（数据待修正，金额已单列）'}</div>
        </div>
      </div>

      <div className="border rounded-lg p-4">
        <h2 className="text-sm font-medium text-gray-500 mb-3">{isEn ? 'Aging Distribution' : '账龄分布'}</h2>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data.buckets} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
            <XAxis dataKey="label" fontSize={12} />
            <YAxis fontSize={11} tickFormatter={(v) => `€${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`} />
            <Tooltip formatter={(v: unknown) => eur(Number(v))} />
            <Bar dataKey="amount" radius={[3, 3, 0, 0]}>
              {data.buckets.map((b) => <Cell key={b.key} fill={BUCKET_COLORS[b.key]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center gap-3">
        <input
          className="border rounded px-3 py-1.5 text-sm w-64"
          placeholder={isEn ? 'Search customer name…' : '搜索客户名…'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="text-xs text-gray-400">{isEn ? `${filtered.length} customers with balance due, sorted desc.` : `${filtered.length} 个欠款客户，按欠款额降序`}</span>
      </div>

      <div className="border rounded overflow-x-auto">
        <table className="w-full text-sm min-w-[840px]">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">{isEn ? 'Customer' : '客户'}</th>
              <th className="px-3 py-2 font-medium text-right">{isEn ? 'Total' : '合计'}</th>
              <th className="px-3 py-2 font-medium text-right">{isEn ? 'Current' : '未到期'}</th>
              <th className="px-3 py-2 font-medium text-right">1-30</th>
              <th className="px-3 py-2 font-medium text-right">31-60</th>
              <th className="px-3 py-2 font-medium text-right">61-90</th>
              <th className="px-3 py-2 font-medium text-right">90+</th>
              <th className="px-3 py-2 font-medium text-right">{isEn ? 'Unknown' : '未知'}</th>
              <th className="px-3 py-2 font-medium text-right">{isEn ? 'Invoices' : '发票数'}</th>
              <th className="px-3 py-2 font-medium text-right">{isEn ? 'Last Payment' : '最近还款'}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.customerId} className="border-t hover:bg-gray-50">
                <td className="px-3 py-1.5">{c.customerName}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-medium">{eur(c.total)}</td>
                {(['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'unknown'] as BucketKey[]).map((k) => (
                  <td key={k} className={`px-3 py-1.5 text-right tabular-nums ${c.buckets[k] > 0 && k !== 'current' ? 'text-red-600' : c.buckets[k] === 0 ? 'text-gray-300' : ''}`}>
                    {c.buckets[k] > 0 ? eur(c.buckets[k]) : '—'}
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right tabular-nums">{c.invoiceCount}</td>
                <td className="px-3 py-1.5 text-right text-gray-500">
                  {c.lastPaidAt ? String(c.lastPaidAt).slice(0, 10) : (isEn ? 'Never' : '从未')}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-400">{isEn ? 'No outstanding invoices right now 👍' : '当前没有未收清的发票 👍'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
