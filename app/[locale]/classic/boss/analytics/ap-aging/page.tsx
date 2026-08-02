'use client'
import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur } from '@/components/boss/analytics-shared'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts'

/**
 * 应付账龄 —— 与应收账龄（ar-aging）同一套账龄阈值与页面结构，方便两张表对读。
 * 语义反过来：这里的"逾期"是**我们欠供应商**的钱拖过了到期日，属于付款优先级问题，
 * 不是坏账风险，所以配色不用应收那套越红越危险的风险色阶。
 */

type BucketKey = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus' | 'unknown'

interface SupplierRow {
  supplierId: string
  supplierName: string
  total: number
  billCount: number
  buckets: Record<BucketKey, number>
  oldestDue: string | null
  lastPaidAt: string | null
}

interface Payload {
  totalDue: number
  billCount: number
  unknownCount: number
  buckets: Array<{ key: BucketKey; label: string; amount: number }>
  suppliers: SupplierRow[]
  pending: {
    draftCount: number
    draftAmount: number
    postedMissingDueDate: number
  }
}

const BUCKET_COLORS: Record<BucketKey, string> = {
  current: '#2E5C63',
  d1_30: '#4a7c85',
  d31_60: '#c98a2b',
  d61_90: '#c0602c',
  d90_plus: '#a33c30',
  unknown: '#9ca3af',
}

const BUCKET_ORDER: BucketKey[] = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'unknown']

export default function ApAgingPage() {
  const [data, setData] = useState<Payload | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    apiGet<Payload>('/api/analytics/ap-aging').then(setData).catch((e) => toast.error(e.message))
  }, [])

  if (!data) return <div className="text-center text-gray-400 py-24 text-sm">加载中…</div>

  const overdue = data.buckets
    .filter((b) => b.key !== 'current' && b.key !== 'unknown')
    .reduce((s, b) => s + b.amount, 0)

  const filtered = data.suppliers.filter((s) =>
    search.trim() === '' || s.supplierName.toLowerCase().includes(search.trim().toLowerCase()),
  )

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">应付账龄</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          口径：已过账（POSTED）且未付清的供应商账单，按到期日分桶 · 实时 · 账龄阈值与应收账龄一致
        </p>
      </div>

      {(data.pending.draftCount > 0 || data.pending.postedMissingDueDate > 0) && (
        <div className="border-l-4 border-amber-400 bg-amber-50 rounded-r-lg px-4 py-3 text-sm text-amber-900">
          <p className="font-medium mb-1">账龄只统计已过账的账单，下面这些还没进来</p>
          <ul className="space-y-0.5 text-amber-800">
            {data.pending.draftCount > 0 && (
              <li>
                · <span className="tabular-nums font-medium">{data.pending.draftCount}</span> 张草稿账单共{' '}
                <span className="tabular-nums font-medium">{eur(data.pending.draftAmount)}</span> 尚未过账，
                过账后才会出现在账龄里。
              </li>
            )}
            {data.pending.postedMissingDueDate > 0 && (
              <li>
                · <span className="tabular-nums font-medium">{data.pending.postedMissingDueDate}</span> 张已过账账单没填到期日，
                无法排账期，金额落在「未知」一列。
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">应付总额</div>
          <div className="text-2xl font-semibold mt-1 tabular-nums">{eur(data.totalDue)}</div>
          <div className="text-xs text-gray-400 mt-1">{data.billCount} 张未付清账单</div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">已逾期未付</div>
          <div className={`text-2xl font-semibold mt-1 tabular-nums ${overdue > 0 ? 'text-orange-600' : ''}`}>{eur(overdue)}</div>
          <div className="text-xs text-gray-400 mt-1">
            占比 {data.totalDue > 0 ? ((overdue / data.totalDue) * 100).toFixed(0) : 0}%
          </div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">90+ 天（供应商关系风险）</div>
          <div className="text-2xl font-semibold mt-1 tabular-nums text-orange-700">
            {eur(data.buckets.find((b) => b.key === 'd90_plus')?.amount ?? 0)}
          </div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">未填到期日</div>
          <div className="text-2xl font-semibold mt-1">{data.unknownCount}</div>
          <div className="text-xs text-gray-400 mt-1">张账单（无法排账期，金额已单列）</div>
        </div>
      </div>

      <div className="border rounded-lg p-4">
        <h2 className="text-sm font-medium text-gray-500 mb-3">账龄分布</h2>
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
          placeholder="搜索供应商名…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="text-xs text-gray-400">{filtered.length} 个待付供应商，按欠款额降序</span>
      </div>

      <div className="border rounded overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">供应商</th>
              <th className="px-3 py-2 font-medium text-right">合计</th>
              <th className="px-3 py-2 font-medium text-right">未到期</th>
              <th className="px-3 py-2 font-medium text-right">1-30</th>
              <th className="px-3 py-2 font-medium text-right">31-60</th>
              <th className="px-3 py-2 font-medium text-right">61-90</th>
              <th className="px-3 py-2 font-medium text-right">90+</th>
              <th className="px-3 py-2 font-medium text-right">未知</th>
              <th className="px-3 py-2 font-medium text-right">账单数</th>
              <th className="px-3 py-2 font-medium text-right">最早到期</th>
              <th className="px-3 py-2 font-medium text-right">最近付款</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.supplierId} className="border-t hover:bg-gray-50">
                <td className="px-3 py-1.5">{s.supplierName}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-medium">{eur(s.total)}</td>
                {BUCKET_ORDER.map((k) => (
                  <td
                    key={k}
                    className={`px-3 py-1.5 text-right tabular-nums ${
                      s.buckets[k] > 0 && k !== 'current' ? 'text-orange-600' : s.buckets[k] === 0 ? 'text-gray-300' : ''
                    }`}
                  >
                    {s.buckets[k] > 0 ? eur(s.buckets[k]) : '—'}
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right tabular-nums">{s.billCount}</td>
                <td className="px-3 py-1.5 text-right text-gray-500">{s.oldestDue ?? '—'}</td>
                <td className="px-3 py-1.5 text-right text-gray-500">
                  {s.lastPaidAt ? String(s.lastPaidAt).slice(0, 10) : '从未'}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={11} className="px-3 py-8 text-center text-gray-400">当前没有未付清的供应商账单 👍</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
