'use client'
import { useState, useEffect, useCallback } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'

const PURPLE = '#875A7B'
const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface SummaryRow {
  waveId: string
  driverName: string
  timeOfDay: string | null
  /** 该波次下全部托盘号(可能横跨多个)，不再是单值 batchNum——一趟车可能挂着好几个托盘 */
  batchNums: number[]
  restaurantCount: number
  orderCount: number
  totalQty: number
  totalAmount: number
  status: string
  waveDate: string | null
  weekday: number | null
}

interface SummaryResp {
  from: string
  to: string
  rows: SummaryRow[]
  totals?: { restaurantCount: number; orderCount: number; totalQty: number; totalAmount: number }
}

const WAVE_STATUS_LABEL_ZH: Record<string, { text: string; cls: string }> = {
  PENDING: { text: '待理货', cls: 'bg-gray-100 text-gray-500' },
  PICKING: { text: '理货中', cls: 'bg-blue-100 text-blue-700' },
  PICKED: { text: '已拣货', cls: 'bg-blue-100 text-blue-700' },
  SORTING: { text: '分货中', cls: 'bg-amber-100 text-amber-700' },
  SORTED: { text: '已就绪', cls: 'bg-green-100 text-green-700' },
}

const WAVE_STATUS_LABEL_EN: Record<string, { text: string; cls: string }> = {
  PENDING: { text: 'Not Picked', cls: 'bg-gray-100 text-gray-500' },
  PICKING: { text: 'Picking', cls: 'bg-blue-100 text-blue-700' },
  PICKED: { text: 'Picked', cls: 'bg-blue-100 text-blue-700' },
  SORTING: { text: 'Sorting', cls: 'bg-amber-100 text-amber-700' },
  SORTED: { text: 'Ready', cls: 'bg-green-100 text-green-700' },
}

function timePill(t: string | null, isEn: boolean) {
  if (t === 'am') return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-sky-100 text-sky-700">{isEn ? 'AM' : '上午'}</span>
  if (t === 'pm') return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">{isEn ? 'PM' : '下午'}</span>
  return <span className="text-gray-400">—</span>
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1 rounded-full text-xs font-medium border transition-colors"
      style={active
        ? { background: PURPLE, color: '#fff', borderColor: PURPLE }
        : { background: '#fff', color: PURPLE, borderColor: '#e5d5e0' }}
    >
      {children}
    </button>
  )
}

type SortKey = 'batch' | 'ampm' | 'driver'

export default function DriverDispatchTab({ date }: { date: string }) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const WEEKDAYS = isEn ? WEEKDAYS_EN : WEEKDAYS_ZH
  const WAVE_STATUS_LABEL = isEn ? WAVE_STATUS_LABEL_EN : WAVE_STATUS_LABEL_ZH

  const [rows, setRows] = useState<SummaryRow[]>([])
  const [loading, setLoading] = useState(false)

  // 筛选状态
  const [from, setFrom] = useState(date)
  const [to, setTo] = useState(date)
  const [driverSel, setDriverSel] = useState<Set<string>>(new Set())
  const [slotSel, setSlotSel] = useState<'' | 'am' | 'pm'>('')
  const [batchSel, setBatchSel] = useState<Set<number>>(new Set())
  const [weekdaySel, setWeekdaySel] = useState<Set<number>>(new Set())
  const [sortBy, setSortBy] = useState<SortKey>('batch')

  // 父级日期变化时同步范围
  useEffect(() => { setFrom(date); setTo(date) }, [date])

  const load = useCallback(async () => {
    if (!from) return
    setLoading(true)
    try {
      const data = await apiGet<SummaryResp>(`/api/dispatch/driver-summary?from=${from}&to=${to || from}`)
      setRows(Array.isArray(data.rows) ? data.rows : [])
    } catch {
      toast.error(isEn ? 'Failed to load driver summary' : '加载司机汇总失败')
    } finally {
      setLoading(false)
    }
  }, [from, to, isEn])

  useEffect(() => { load() }, [load])

  // 可选项（从已加载数据提取）
  const driverOpts = [...new Set(rows.map(r => r.driverName).filter(Boolean))].sort()
  const batchOpts = [...new Set(rows.flatMap(r => r.batchNums))].sort((a, b) => a - b)

  function toggleNum(set: Set<number>, v: number, setter: (s: Set<number>) => void) {
    const next = new Set(set); next.has(v) ? next.delete(v) : next.add(v); setter(next)
  }
  function toggleStr(set: Set<string>, v: string, setter: (s: Set<string>) => void) {
    const next = new Set(set); next.has(v) ? next.delete(v) : next.add(v); setter(next)
  }

  const filtered = rows.filter(r => {
    if (driverSel.size && !driverSel.has(r.driverName)) return false
    if (slotSel && r.timeOfDay !== slotSel) return false
    if (batchSel.size && !r.batchNums.some(b => batchSel.has(b))) return false
    if (weekdaySel.size && !(r.weekday != null && weekdaySel.has(r.weekday))) return false
    return true
  })

  const sorted = [...filtered].sort((a, b) => {
    const aNum = a.batchNums[0] ?? 0
    const bNum = b.batchNums[0] ?? 0
    if (sortBy === 'driver') return a.driverName.localeCompare(b.driverName) || aNum - bNum
    if (sortBy === 'ampm') return (a.timeOfDay ?? '').localeCompare(b.timeOfDay ?? '') || aNum - bNum
    return aNum - bNum || (a.timeOfDay ?? '').localeCompare(b.timeOfDay ?? '')
  })

  const driverCount = new Set(filtered.map(r => r.driverName)).size
  const sumAmount = Math.round(filtered.reduce((s, r) => s + r.totalAmount, 0) * 100) / 100

  const labelCls = 'text-xs text-gray-500 w-20 shrink-0 pt-1'
  const inputCls = 'border rounded-lg px-3 py-1.5 text-sm outline-none'

  return (
    <div className="bg-white rounded-lg border" style={{ borderColor: '#e5e7eb' }}>
      {/* ── 筛选区 ── */}
      <div className="px-4 py-4 border-b space-y-3" style={{ borderColor: '#e5e7eb' }}>
        {/* 日期范围 */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className={labelCls.replace('pt-1', '')}>From</span>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className={inputCls} style={{ borderColor: '#e5e7eb' }} />
          <span className="text-xs text-gray-500">To</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className={inputCls} style={{ borderColor: '#e5e7eb' }} />
          <button onClick={load} className="px-3 py-1.5 rounded-lg text-sm font-medium text-white" style={{ background: PURPLE }}>{isEn ? 'Refresh' : '刷新'}</button>
        </div>

        {/* 司机 */}
        <div className="flex items-start gap-2">
          <span className={labelCls}>{isEn ? 'Driver' : '司机'}</span>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={driverSel.size === 0} onClick={() => setDriverSel(new Set())}>{isEn ? 'All Drivers' : '全部司机'}</Chip>
            {driverOpts.length === 0 && <span className="text-xs text-gray-300 pt-1">{isEn ? 'No options' : '无可选项'}</span>}
            {driverOpts.map(d => (
              <Chip key={d} active={driverSel.has(d)} onClick={() => toggleStr(driverSel, d, setDriverSel)}>{d}</Chip>
            ))}
          </div>
        </div>

        {/* AM / PM */}
        <div className="flex items-start gap-2">
          <span className={labelCls}>AM / PM</span>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={slotSel === ''} onClick={() => setSlotSel('')}>{isEn ? 'All Slots' : '全部时段'}</Chip>
            <Chip active={slotSel === 'am'} onClick={() => setSlotSel('am')}>{isEn ? 'AM' : '上午'}</Chip>
            <Chip active={slotSel === 'pm'} onClick={() => setSlotSel('pm')}>{isEn ? 'PM' : '下午'}</Chip>
          </div>
        </div>

        {/* 批次 */}
        <div className="flex items-start gap-2">
          <span className={labelCls}>{isEn ? 'Batch' : '批次'}</span>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={batchSel.size === 0} onClick={() => setBatchSel(new Set())}>{isEn ? 'All Batches' : '全部批次'}</Chip>
            {batchOpts.length === 0 && <span className="text-xs text-gray-300 pt-1">{isEn ? 'No options' : '无可选项'}</span>}
            {batchOpts.map(b => (
              <Chip key={b} active={batchSel.has(b)} onClick={() => toggleNum(batchSel, b, setBatchSel)}>{isEn ? `Batch ${b}` : `批次 ${b}`}</Chip>
            ))}
          </div>
        </div>

        {/* 按星期筛选 */}
        <div className="flex items-start gap-2">
          <span className={labelCls}>{isEn ? 'Filter by Weekday' : '按星期筛选'}</span>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((w, i) => (
              <Chip key={i} active={weekdaySel.has(i)} onClick={() => toggleNum(weekdaySel, i, setWeekdaySel)}>{w}</Chip>
            ))}
          </div>
        </div>
      </div>

      {/* ── 排序 + 合计 ── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b flex-wrap gap-2" style={{ borderColor: '#e5e7eb', background: '#faf5fb' }}>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 mr-1">{isEn ? 'Sort:' : '排序：'}</span>
          <Chip active={sortBy === 'batch'} onClick={() => setSortBy('batch')}>{isEn ? 'Batch' : '批次'}</Chip>
          <Chip active={sortBy === 'ampm'} onClick={() => setSortBy('ampm')}>AM/PM</Chip>
          <Chip active={sortBy === 'driver'} onClick={() => setSortBy('driver')}>{isEn ? 'Driver' : '司机'}</Chip>
        </div>
        <div className="text-sm font-semibold">
          {/* 一行=一个波次=一趟车(不再按批次号拆分,批次号只是波次内部的托盘编号,见 DEV-PLAN.md)，
              不能再用 batchNum 去重当车次数——同一趟车可能挂着好几个批次号，会把车次数算少。 */}
          {isEn
            ? `${filtered.length} trips, ${filtered.reduce((s, r) => s + r.orderCount, 0)} orders`
            : `共 ${filtered.length} 趟, ${filtered.reduce((s, r) => s + r.orderCount, 0)} 单`}
          <span className="ml-3">{isEn ? 'Total' : '合计'} €{sumAmount.toLocaleString()}</span>
        </div>
      </div>

      {/* ── 汇总表 ── */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500" style={{ background: '#faf5fb' }}>
              <th className="text-left font-semibold px-3 py-2.5">{isEn ? 'Driver' : '司机'}</th>
              <th className="text-left font-semibold px-3 py-2.5">{isEn ? 'Date' : '日期'}</th>
              <th className="text-left font-semibold px-3 py-2.5">{isEn ? 'Slot' : '时段'}</th>
              <th className="text-left font-semibold px-3 py-2.5">{isEn ? 'Batch' : '批次'}</th>
              <th className="text-right font-semibold px-3 py-2.5">{isEn ? 'Customers' : '餐馆数'}</th>
              <th className="text-right font-semibold px-3 py-2.5">{isEn ? 'Orders' : '订单数'}</th>
              <th className="text-right font-semibold px-3 py-2.5">{isEn ? 'Items' : '品项数'}</th>
              <th className="text-right font-semibold px-3 py-2.5">{isEn ? 'Total Amount' : '总金额'}</th>
              <th className="text-left font-semibold px-3 py-2.5">{isEn ? 'Status' : '状态'}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} className="text-center py-10 text-gray-400">{isEn ? 'Loading…' : '加载中…'}</td></tr>
            )}
            {!loading && sorted.length === 0 && (
              <tr><td colSpan={9} className="text-center py-10 text-gray-400">{isEn ? 'No batch data for this filter' : '该筛选条件下暂无批次数据'}</td></tr>
            )}
            {!loading && sorted.map(r => {
              const st = WAVE_STATUS_LABEL[r.status] ?? { text: r.status, cls: 'bg-gray-100 text-gray-500' }
              return (
                <tr key={r.waveId} className="border-t hover:bg-gray-50" style={{ borderColor: '#f0f0f0' }}>
                  <td className="px-3 py-2.5 font-medium">{r.driverName || '—'}</td>
                  <td className="px-3 py-2.5 text-gray-500">{r.waveDate ?? '—'}{r.weekday != null ? ` ${WEEKDAYS[r.weekday]}` : ''}</td>
                  <td className="px-3 py-2.5">{timePill(r.timeOfDay, isEn)}</td>
                  <td className="px-3 py-2.5">{r.batchNums.length > 0 ? (isEn ? `Batch ${r.batchNums.join('·')}` : `批次 ${r.batchNums.join('·')}`) : (isEn ? 'No Pallet' : '未分托盘')}</td>
                  <td className="px-3 py-2.5 text-right">{r.restaurantCount}</td>
                  <td className="px-3 py-2.5 text-right">{r.orderCount}</td>
                  <td className="px-3 py-2.5 text-right">{r.totalQty}</td>
                  <td className="px-3 py-2.5 text-right">€{r.totalAmount.toLocaleString()}</td>
                  <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${st.cls}`}>{st.text}</span></td>
                </tr>
              )
            })}
          </tbody>
          {sorted.length > 0 && (
            <tfoot>
              <tr className="border-t font-semibold" style={{ borderColor: '#e5e7eb', background: '#f9fafb' }}>
                <td className="px-3 py-2.5" colSpan={4}>{isEn ? `Total ${driverCount} drivers · ${sorted.length} trips` : `合计 ${driverCount} 名司机 · ${sorted.length} 趟`}</td>
                <td className="px-3 py-2.5 text-right">{filtered.reduce((s, r) => s + r.restaurantCount, 0)}</td>
                <td className="px-3 py-2.5 text-right">{filtered.reduce((s, r) => s + r.orderCount, 0)}</td>
                <td className="px-3 py-2.5 text-right">{Math.round(filtered.reduce((s, r) => s + r.totalQty, 0) * 1000) / 1000}</td>
                <td className="px-3 py-2.5 text-right">€{sumAmount.toLocaleString()}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className="text-xs text-gray-400 px-4 py-3">
        {isEn
          ? 'Filter by date range / driver / slot / batch / weekday combined; shares conventions with the daily sales report.'
          : '支持按日期范围 / 司机 / 时段 / 批次 / 星期组合筛选；与日销售报表共用口径。'}
      </p>
    </div>
  )
}
