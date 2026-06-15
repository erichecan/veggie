'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'

const PURPLE = '#875A7B'

interface SummaryRow {
  waveId: string
  driverName: string
  timeOfDay: string | null
  batchNum: number | null
  restaurantCount: number
  orderCount: number
  totalQty: number
  totalAmount: number
  status: string
}

interface SummaryResp {
  date: string
  rows: SummaryRow[]
  totals?: { restaurantCount: number; orderCount: number; totalQty: number; totalAmount: number }
}

const WAVE_STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  PENDING: { text: '待理货', cls: 'bg-gray-100 text-gray-500' },
  PICKING: { text: '理货中', cls: 'bg-blue-100 text-blue-700' },
  PICKED: { text: '已拣货', cls: 'bg-blue-100 text-blue-700' },
  SORTING: { text: '分货中', cls: 'bg-amber-100 text-amber-700' },
  SORTED: { text: '已就绪', cls: 'bg-green-100 text-green-700' },
}

function timePill(t: string | null) {
  if (t === 'am') return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-sky-100 text-sky-700">上午</span>
  if (t === 'pm') return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">下午</span>
  return <span className="text-gray-400">—</span>
}

export default function DriverDispatchTab({ date }: { date: string }) {
  const [rows, setRows] = useState<SummaryRow[]>([])
  const [totals, setTotals] = useState<SummaryResp['totals']>()
  const [loading, setLoading] = useState(false)
  const [kw, setKw] = useState('')
  const [slot, setSlot] = useState('')

  const load = useCallback(async () => {
    if (!date) return
    setLoading(true)
    try {
      const data = await apiGet<SummaryResp>(`/api/dispatch/driver-summary?date=${date}`)
      setRows(data.rows)
      setTotals(data.totals)
    } catch {
      toast.error('加载司机汇总失败')
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => { load() }, [load])

  const filtered = rows.filter(r => {
    if (slot && r.timeOfDay !== slot) return false
    if (kw && !r.driverName.toLowerCase().includes(kw.toLowerCase())) return false
    return true
  })

  const driverCount = new Set(filtered.map(r => r.driverName)).size

  return (
    <div className="bg-white rounded-lg border" style={{ borderColor: '#e5e7eb' }}>
      <div className="flex items-center justify-between px-4 py-3 border-b flex-wrap gap-2" style={{ borderColor: '#e5e7eb' }}>
        <h3 className="text-sm font-semibold">司机调度总览 · 每个司机送多少家、多少单</h3>
        <div className="flex gap-2 items-center">
          <select value={slot} onChange={e => setSlot(e.target.value)} className="border rounded-lg px-2 py-1.5 text-sm" style={{ borderColor: '#e5e7eb' }}>
            <option value="">全部时段</option>
            <option value="am">上午</option>
            <option value="pm">下午</option>
          </select>
          <input value={kw} onChange={e => setKw(e.target.value)} placeholder="搜索司机" className="border rounded-lg px-3 py-1.5 text-sm outline-none w-44" style={{ borderColor: '#e5e7eb' }} />
          <button onClick={load} className="px-3 py-1.5 rounded-lg text-sm font-medium text-white" style={{ background: PURPLE }}>刷新</button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500" style={{ background: '#faf5fb' }}>
              <th className="text-left font-semibold px-3 py-2.5">司机</th>
              <th className="text-left font-semibold px-3 py-2.5">时段</th>
              <th className="text-left font-semibold px-3 py-2.5">批次</th>
              <th className="text-right font-semibold px-3 py-2.5">餐馆数</th>
              <th className="text-right font-semibold px-3 py-2.5">订单数</th>
              <th className="text-right font-semibold px-3 py-2.5">品项数</th>
              <th className="text-right font-semibold px-3 py-2.5">总金额</th>
              <th className="text-left font-semibold px-3 py-2.5">状态</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="text-center py-10 text-gray-400">加载中…</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={8} className="text-center py-10 text-gray-400">该日期暂无批次数据</td></tr>
            )}
            {!loading && filtered.map(r => {
              const st = WAVE_STATUS_LABEL[r.status] ?? { text: r.status, cls: 'bg-gray-100 text-gray-500' }
              return (
                <tr key={r.waveId} className="border-t hover:bg-gray-50" style={{ borderColor: '#f0f0f0' }}>
                  <td className="px-3 py-2.5 font-medium">{r.driverName || '—'}</td>
                  <td className="px-3 py-2.5">{timePill(r.timeOfDay)}</td>
                  <td className="px-3 py-2.5">批次 {r.batchNum ?? '—'}</td>
                  <td className="px-3 py-2.5 text-right">{r.restaurantCount}</td>
                  <td className="px-3 py-2.5 text-right">{r.orderCount}</td>
                  <td className="px-3 py-2.5 text-right">{r.totalQty}</td>
                  <td className="px-3 py-2.5 text-right">€{r.totalAmount.toLocaleString()}</td>
                  <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${st.cls}`}>{st.text}</span></td>
                </tr>
              )
            })}
          </tbody>
          {totals && filtered.length > 0 && (
            <tfoot>
              <tr className="border-t font-semibold" style={{ borderColor: '#e5e7eb', background: '#f9fafb' }}>
                <td className="px-3 py-2.5" colSpan={3}>合计 {driverCount} 名司机 · {filtered.length} 趟</td>
                <td className="px-3 py-2.5 text-right">{filtered.reduce((s, r) => s + r.restaurantCount, 0)}</td>
                <td className="px-3 py-2.5 text-right">{filtered.reduce((s, r) => s + r.orderCount, 0)}</td>
                <td className="px-3 py-2.5 text-right">{Math.round(filtered.reduce((s, r) => s + r.totalQty, 0) * 1000) / 1000}</td>
                <td className="px-3 py-2.5 text-right">€{filtered.reduce((s, r) => s + r.totalAmount, 0).toLocaleString()}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className="text-xs text-gray-400 px-4 py-3">
        与日销售报表共用口径：同一司机出现多行（如上午批次1 + 批次2）说明他上午跑了多趟。
      </p>
    </div>
  )
}
