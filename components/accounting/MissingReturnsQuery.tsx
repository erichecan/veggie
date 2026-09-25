'use client'
import { useState } from 'react'
import { apiGet } from '@/lib/api'
import type { Order } from '@/lib/types'
import { formatDriverSlotFromOrder } from '@/lib/driver-slot'

function incTaxAmount(o: Order): number {
  return o.totalAmountIncTax ?? o.totalAmount ?? 0
}

/**
 * 独立于「今日」日常核销之外的核对工具——按时间段倒查更早日期还没回的送货单。
 */
export function MissingReturnsQuery({ today }: { today: string }) {
  const [show, setShow] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<Order[] | null>(null)

  function open() {
    if (!show && !from && !to) {
      setTo(today)
      setFrom(new Date(new Date(today).getTime() - 6 * 86400000).toISOString().slice(0, 10))
    }
    setShow(v => !v)
  }

  async function query() {
    if (!from || !to) return
    setLoading(true)
    try {
      const data = await apiGet<Order[]>(
        `/api/orders?status=CONFIRMED,WAVE_ASSIGNED,COMPLETED,IN_DELIVERY&include_lines=false&deliveryFrom=${from}&deliveryTo=${to}&limit=5000`,
      )
      setResults((data ?? []).filter(o => (o.returnStatus ?? 'PENDING') !== 'RETURNED'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
      <button className="w-full flex items-center justify-between px-5 py-3 bg-gray-50 hover:bg-gray-100 transition-colors" onClick={open}>
        <span className="font-semibold text-gray-700 text-sm">🔍 按时间段查漏单</span>
        <span className="text-xs" style={{ color: '#875A7B' }}>{show ? '收起 ▲' : '展开 ▼'}</span>
      </button>
      {show && (
        <div className="px-5 py-4">
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300" />
            <span className="text-gray-400 text-sm">至</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300" />
            <button onClick={query} disabled={!from || !to || loading} className="px-4 py-1.5 text-white rounded text-sm font-medium disabled:opacity-50" style={{ background: '#875A7B' }}>
              {loading ? '查询中…' : '查询'}
            </button>
          </div>
          {results === null ? (
            <div className="text-xs text-gray-400">选好时间段点「查询」，看这段时间里还有哪些送货单没回或有问题</div>
          ) : results.length === 0 ? (
            <div className="text-xs text-green-600">✅ 这段时间的送货单全部已核销</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-200">
                    <th className="text-left pb-1.5 font-medium">单号</th>
                    <th className="text-left pb-1.5 font-medium">送货日期</th>
                    <th className="text-left pb-1.5 font-medium">客户</th>
                    <th className="text-left pb-1.5 font-medium">批次/司机</th>
                    <th className="text-right pb-1.5 font-medium">含税金额</th>
                    <th className="text-center pb-1.5 font-medium">状态</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {results.map(o => (
                    <tr key={o.id} className="hover:bg-gray-50">
                      <td className="py-1.5 font-mono text-gray-700">{o.code ?? o.id.slice(-8)}</td>
                      <td className="py-1.5 text-gray-600 whitespace-nowrap">{o.deliveryDate ? o.deliveryDate.slice(0, 10) : '—'}</td>
                      <td className="py-1.5 text-gray-800 max-w-[160px] truncate">{o.restaurantName}</td>
                      <td className="py-1.5 text-gray-600">{formatDriverSlotFromOrder(o) || '—'}</td>
                      <td className="py-1.5 text-right font-mono font-medium text-gray-900">€{incTaxAmount(o).toFixed(2)}</td>
                      <td className="py-1.5 text-center">{(o.returnStatus ?? 'PENDING') === 'ISSUE' ? '❗ 有问题' : '⚠️ 未回'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 text-xs text-gray-400">共 {results.length} 张未核销</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
