'use client'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet, apiPost } from '@/lib/api'
import type { Order } from '@/lib/types'
import { formatDriverSlotFromOrder, type DriverSlotInfo } from '@/lib/driver-slot'

const FLOW_STEPS_ZH = [
  { step: 1, icon: '📋', title: '确认已送订单', desc: '查看当日所有已确认（CONFIRMED）的订单，这些货已出仓' },
  { step: 2, icon: '🚚', title: '司机带回签收单', desc: '司机送货回来后，签收单（纸质）交到会计手里' },
  { step: 3, icon: '🔍', title: '核对漏单', desc: '按订单列表逐一核对，没有带回签收单的即为"漏单"，需立即追查' },
  { step: 4, icon: '✅', title: '核销确认', desc: '签收单到手后，扫码或勾选，点击"批量核销"，标记送货单已回' },
  { step: 5, icon: '💰', title: '现金核对', desc: '现付订单需核对司机带回的现金金额，与系统金额一致后完成核销' },
]
const FLOW_STEPS_EN = [
  { step: 1, icon: '📋', title: 'Confirmed Orders', desc: "View all CONFIRMED orders for today — these have left the warehouse" },
  { step: 2, icon: '🚚', title: 'Driver Returns Note', desc: 'When the driver gets back, the paper delivery note is handed to accounting' },
  { step: 3, icon: '🔍', title: 'Check Missing Notes', desc: 'Go through the order list — any order with no returned delivery note is "missing" and needs immediate follow-up' },
  { step: 4, icon: '✅', title: 'Confirm Write-off', desc: 'Once the delivery note is in hand, scan or check it and click "Bulk Write-off" to mark it as returned' },
  { step: 5, icon: '💰', title: 'Cash Verification', desc: 'For cash orders, verify the amount the driver brings back against the system amount before completing the write-off' },
]

// BATCH_OPTIONS removed — now uses dynamic driverSlots

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

type CardKey = 'all' | 'returned' | 'missing' | 'cashPending'
type SortKey = 'code' | 'restaurantName' | 'deliveryBatch' | 'totalAmount' | 'paymentMethod' | 'status' | 'orderReturn'
type SortDir = 'asc' | 'desc'

export default function AccountingPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const FLOW_STEPS = isEn ? FLOW_STEPS_EN : FLOW_STEPS_ZH
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [filterBatch, setFilterBatch] = useState('')
  const [filterPayment, setFilterPayment] = useState('')
  const [filterReturn, setFilterReturn] = useState<'all' | 'returned' | 'missing'>('all')
  const [bulkLoading, setBulkLoading] = useState(false)
  const [scanInput, setScanInput] = useState('')
  const [scanMsg, setScanMsg] = useState<{ type: 'ok' | 'err' | 'warn'; text: string } | null>(null)
  const [showGuide, setShowGuide] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>('deliveryBatch')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [flashId, setFlashId] = useState<string | null>(null)
  const [showAction, setShowAction] = useState(false)
  const [activeCard, setActiveCard] = useState<CardKey | null>(null)
  const [showDriverPanel, setShowDriverPanel] = useState(true)
  const [expandedDriver, setExpandedDriver] = useState<string | null>(null)
  const [driverSlots, setDriverSlots] = useState<DriverSlotInfo[]>([])
  useEffect(() => { apiGet<DriverSlotInfo[]>('/api/driver-slots').then(setDriverSlots).catch(() => {}) }, [])
  const actionRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({})
  const tableRef = useRef<HTMLDivElement>(null)

  function applyCardFilter(key: CardKey) {
    if (activeCard === key) {
      setActiveCard(null)
      setFilterReturn('all')
      setFilterPayment('')
      return
    }
    setActiveCard(key)
    if (key === 'all') {
      setFilterReturn('all')
      setFilterPayment('')
    } else if (key === 'returned') {
      setFilterReturn('returned')
      setFilterPayment('')
    } else if (key === 'missing') {
      setFilterReturn('missing')
      setFilterPayment('')
    } else if (key === 'cashPending') {
      setFilterReturn('missing')
      setFilterPayment('CASH')
    }
    setTimeout(() => {
      tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<Order[]>('/api/orders?status=CONFIRMED,WAVE_ASSIGNED,COMPLETED,IN_DELIVERY&include_lines=false')
      setOrders(data ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (actionRef.current && !actionRef.current.contains(e.target as Node)) {
        setShowAction(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  function handleScan(e: React.FormEvent) {
    e.preventDefault()
    const code = scanInput.trim()
    if (!code) return
    const found = orders.find(o => o.code === code || o.id === code)
    if (!found) {
      setScanMsg({ type: 'err', text: isEn ? `Order not found: ${code}` : `找不到订单：${code}` })
    } else if (found.orderReturn) {
      setScanMsg({ type: 'warn', text: isEn ? `${code} already written off` : `${code} 已核销` })
      flashRow(found.id)
    } else {
      setSelected(prev => {
        const next = new Set(prev)
        next.add(found.id)
        return next
      })
      flashRow(found.id)
      setScanMsg({ type: 'ok', text: isEn ? `✅ ${code} selected, ${selected.size + 1} total selected` : `✅ ${code} 已选中，共选 ${selected.size + 1} 张` })
    }
    setScanInput('')
    setTimeout(() => setScanMsg(null), 4000)
  }

  function flashRow(id: string) {
    setFlashId(id)
    setTimeout(() => setFlashId(null), 2000)
    setTimeout(() => {
      rowRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
  }

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAll(ids: string[]) {
    const allSelected = ids.every(id => selected.has(id))
    setSelected(prev => {
      const next = new Set(prev)
      if (allSelected) {
        ids.forEach(id => next.delete(id))
      } else {
        ids.forEach(id => next.add(id))
      }
      return next
    })
  }

  async function bulkMarkReturned(value: boolean) {
    if (selected.size === 0) return
    setBulkLoading(true)
    setShowAction(false)
    try {
      await apiPost('/api/orders/bulk', { action: 'mark_returned', ids: [...selected], value })
      setOrders(prev => prev.map(o =>
        selected.has(o.id) ? { ...o, orderReturn: value } : o
      ))
      setSelected(new Set())
    } catch {
      alert(isEn ? 'Bulk operation failed, please retry' : '批量操作失败，请重试')
    } finally {
      setBulkLoading(false)
    }
  }

  const today = todayStr()
  const todayOrders = orders.filter(o => {
    const dateStr = (o.deliveryDate ?? o.createdAt ?? '').slice(0, 10)
    return dateStr === today
  })
  const visible = todayOrders.filter(o => {
    if (filterBatch && !formatDriverSlotFromOrder(o).toLowerCase().includes(filterBatch.toLowerCase())) return false
    if (filterPayment && String(o.paymentMethod).toUpperCase() !== filterPayment) return false
    if (filterReturn === 'missing' && o.orderReturn) return false
    if (filterReturn === 'returned' && !o.orderReturn) return false
    return true
  })

  const totalOrders = todayOrders.length
  const returnedCount = todayOrders.filter(o => o.orderReturn).length
  const missingCount = totalOrders - returnedCount
  const cashPending = todayOrders.filter(o => !o.orderReturn && String(o.paymentMethod).toUpperCase() === 'CASH')
    .reduce((s, o) => s + (o.totalAmount ?? 0), 0)

  const driverGroups = useMemo(() => {
    const map = new Map<string, { orders: Order[]; cashTotal: number; onlineTotal: number; returned: number }>()
    todayOrders.forEach(o => {
      const batch = formatDriverSlotFromOrder(o).trim()
      if (!batch) return
      const parts = batch.split(' ')
      const driver = parts.length >= 3 ? parts.slice(2).join(' ') : batch
      if (!map.has(driver)) {
        map.set(driver, { orders: [], cashTotal: 0, onlineTotal: 0, returned: 0 })
      }
      const g = map.get(driver)!
      g.orders.push(o)
      if (String(o.paymentMethod).toUpperCase() === 'CASH') {
        g.cashTotal += o.totalAmount ?? 0
      } else {
        g.onlineTotal += o.totalAmount ?? 0
      }
      if (o.orderReturn) g.returned++
    })
    return [...map.entries()]
      .map(([driver, data]) => ({ driver, ...data }))
      .sort((a, b) => a.driver.localeCompare(b.driver, 'zh-CN'))
  }, [todayOrders])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sorted = [...visible].sort((a, b) => {
    const o = sortDir === 'asc' ? 1 : -1
    const av = (a as unknown as Record<string, unknown>)[sortKey]
    const bv = (b as unknown as Record<string, unknown>)[sortKey]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * o
    if (typeof av === 'boolean' && typeof bv === 'boolean') return (Number(av) - Number(bv)) * o
    return String(av).localeCompare(String(bv), 'zh-CN') * o
  })

  const selectableIds = sorted.filter(o => !o.orderReturn).map(o => o.id)
  const visibleSelectedCount = visible.filter(o => selected.has(o.id)).length
  const allVisibleSelected = selectableIds.length > 0 && selectableIds.every(id => selected.has(id))

  return (
    <div className="space-y-4">

      {/* 业务流程引导 */}
      <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
        <button
          className="w-full flex items-center justify-between px-5 py-3 bg-gray-50 hover:bg-gray-100 transition-colors"
          onClick={() => setShowGuide(g => !g)}
        >
          <span className="font-semibold text-gray-700 text-sm">{isEn ? '📌 Accounting Write-off Workflow Guide' : '📌 会计核销业务流程指引'}</span>
          <span className="text-xs" style={{ color: '#875A7B' }}>{showGuide ? (isEn ? 'Collapse ▲' : '收起 ▲') : (isEn ? 'Expand ▼' : '展开 ▼')}</span>
        </button>
        {showGuide && (
          <div className="px-5 py-4 grid grid-cols-5 gap-3">
            {FLOW_STEPS.map((s, i) => (
              <div key={s.step} className="relative flex flex-col items-center text-center">
                {i < FLOW_STEPS.length - 1 && (
                  <div className="absolute top-5 left-[calc(50%+20px)] w-[calc(100%-20px)] h-0.5 bg-gray-200 -z-0" />
                )}
                <div className="w-10 h-10 rounded-full bg-gray-100 border-2 border-gray-300 flex items-center justify-center text-lg z-10">
                  {s.icon}
                </div>
                <div className="mt-2 text-xs font-semibold text-gray-700">{s.title}</div>
                <div className="mt-1 text-xs text-gray-500 leading-tight">{s.desc}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label={isEn ? "Today's Orders" : '今日总单'} value={totalOrders} active={activeCard === 'all'} onClick={() => applyCardFilter('all')} />
        <StatCard label={isEn ? 'Written Off' : '已核销'} value={returnedCount} active={activeCard === 'returned'} onClick={() => applyCardFilter('returned')} />
        <StatCard label={isEn ? 'Missing (Not Returned)' : '漏单（未回）'} value={missingCount} urgent={missingCount > 0} active={activeCard === 'missing'} onClick={() => applyCardFilter('missing')} />
        <StatCard label={isEn ? 'Cash Pending (€)' : '现金未核（€）'} value={cashPending.toFixed(2)} urgent={cashPending > 0} active={activeCard === 'cashPending'} onClick={() => applyCardFilter('cashPending')} />
      </div>
      {activeCard && (
        <div className="px-4 py-2 rounded text-xs flex items-center gap-2" style={{ background: '#f3eff5', color: '#875A7B' }}>
          <span className="font-medium">
            {isEn ? (
              <>Filtered below by &quot;{
                activeCard === 'all' ? 'All Today' :
                activeCard === 'returned' ? 'Written Off' :
                activeCard === 'missing' ? 'Missing' : 'Cash Pending'
              }&quot;</>
            ) : (
              <>已按「{
                activeCard === 'all' ? '今日全部' :
                activeCard === 'returned' ? '已核销' :
                activeCard === 'missing' ? '漏单' : '现金未核'
              }」筛选下方列表</>
            )}
          </span>
          <button onClick={() => applyCardFilter(activeCard)} className="ml-auto hover:underline">
            {isEn ? 'Clear Filter ✕' : '清除筛选 ✕'}
          </button>
        </div>
      )}

      {/* 司机收款汇总 */}
      {driverGroups.length > 0 && (
        <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-5 py-3 bg-gray-50 hover:bg-gray-100 transition-colors"
            onClick={() => setShowDriverPanel(v => !v)}
          >
            <span className="font-semibold text-gray-700 text-sm">
              {isEn ? `💰 Driver Collections Summary — ${driverGroups.length} drivers` : `💰 司机收款汇总 — ${driverGroups.length} 位司机`}
            </span>
            <span className="text-xs" style={{ color: '#875A7B' }}>{showDriverPanel ? (isEn ? 'Collapse ▲' : '收起 ▲') : (isEn ? 'Expand ▼' : '展开 ▼')}</span>
          </button>
          {showDriverPanel && (
            <div className="divide-y divide-gray-100">
              {driverGroups.map(g => {
                const isExpanded = expandedDriver === g.driver
                const total = g.cashTotal + g.onlineTotal
                const allReturned = g.returned === g.orders.length
                return (
                  <div key={g.driver}>
                    <button
                      className="w-full flex items-center gap-4 px-5 py-3 text-sm hover:bg-gray-50 transition-colors text-left"
                      onClick={() => setExpandedDriver(isExpanded ? null : g.driver)}
                    >
                      <span className="font-semibold text-gray-900 w-24 shrink-0">{g.driver}</span>
                      <span className="flex items-center gap-1 text-gray-700">
                        <span className="text-xs text-gray-400">{isEn ? 'Cash' : '现金'}</span>
                        <span className="font-mono font-medium">€{g.cashTotal.toFixed(2)}</span>
                      </span>
                      <span className="flex items-center gap-1 text-gray-700">
                        <span className="text-xs text-gray-400">{isEn ? 'Transfer' : '转账'}</span>
                        <span className="font-mono font-medium">€{g.onlineTotal.toFixed(2)}</span>
                      </span>
                      <span className="flex items-center gap-1 text-gray-700">
                        <span className="text-xs text-gray-400">{isEn ? 'Total' : '合计'}</span>
                        <span className="font-mono font-semibold">€{total.toFixed(2)}</span>
                      </span>
                      <span className="ml-auto flex items-center gap-2 text-xs text-gray-500 shrink-0">
                        <span className={`px-2 py-0.5 rounded font-medium ${allReturned ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                          {isEn ? `${g.returned}/${g.orders.length} written off` : `${g.returned}/${g.orders.length} 已核销`}
                        </span>
                        <span className="text-gray-400">{isExpanded ? '▲' : '▼'}</span>
                      </span>
                    </button>
                    {isExpanded && (
                      <div className="bg-gray-50 border-t border-gray-200 px-5 py-3">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-gray-400 border-b border-gray-200">
                              <th className="text-left pb-1.5 font-medium">{isEn ? 'Restaurant' : '餐厅'}</th>
                              <th className="text-left pb-1.5 font-medium">{isEn ? 'Order #' : '单号'}</th>
                              <th className="text-right pb-1.5 font-medium">{isEn ? 'Amount' : '金额'}</th>
                              <th className="text-center pb-1.5 font-medium">{isEn ? 'Payment' : '付款'}</th>
                              <th className="text-center pb-1.5 font-medium">{isEn ? 'Status' : '状态'}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {g.orders.map(o => (
                              <tr key={o.id} className="hover:bg-white transition-colors">
                                <td className="py-1.5 text-gray-700 max-w-[160px] truncate">{o.restaurantName}</td>
                                <td className="py-1.5 text-gray-500 font-mono">{o.code}</td>
                                <td className="py-1.5 text-right font-mono font-medium text-gray-900">€{(o.totalAmount ?? 0).toFixed(2)}</td>
                                <td className="py-1.5 text-center">
                                  {String(o.paymentMethod).toUpperCase() === 'CASH'
                                    ? <span className="px-1.5 py-0.5 bg-gray-100 text-gray-700 rounded">{isEn ? 'Cash' : '现金'}</span>
                                    : <span className="px-1.5 py-0.5 bg-gray-100 text-gray-700 rounded">{isEn ? 'Transfer' : '转账'}</span>}
                                </td>
                                <td className="py-1.5 text-center">
                                  {o.orderReturn
                                    ? <span className="text-green-600">{isEn ? '✓ Written off' : '✓ 已核销'}</span>
                                    : <span className="text-gray-400">{isEn ? 'Pending' : '待核销'}</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="border-t border-gray-200 font-semibold text-gray-700">
                              <td colSpan={2} className="pt-2 text-gray-500">{isEn ? 'Subtotal' : '小计'}</td>
                              <td className="pt-2 text-right font-mono">€{total.toFixed(2)}</td>
                              <td colSpan={2} />
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 扫码核销 */}
      <div className="bg-white rounded border border-gray-200 shadow-sm px-5 py-4">
        <div className="text-sm font-semibold text-gray-700 mb-1">{isEn ? '📷 Scanner / Enter Order # — Auto-select' : '📷 扫码枪 / 输入单号 — 自动勾选'}</div>
        <div className="text-xs text-gray-400 mb-3">{isEn ? 'Scanning auto-selects the order; after scanning a batch, click "Bulk Write-off" to submit all at once' : '扫码后订单自动勾选，批量扫完后点击「批量核销」一次提交'}</div>
        <form onSubmit={handleScan} className="flex gap-2">
          <input
            value={scanInput}
            onChange={e => setScanInput(e.target.value)}
            placeholder={isEn ? 'Scan QR code or enter order # (e.g. CJ-260427-001)' : '扫描二维码或输入订单号（如 CJ-260427-001）'}
            className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
            autoFocus
          />
          <button
            type="submit"
            className="px-4 py-2 text-white rounded text-sm font-medium"
            style={{ background: '#875A7B' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#7a5070' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#875A7B' }}
          >
            {isEn ? 'Select' : '选中'}
          </button>
        </form>
        {scanMsg && (
          <div className={`mt-2 px-3 py-2 rounded text-sm font-medium ${
            scanMsg.type === 'ok' ? 'bg-green-50 text-green-700' :
            scanMsg.type === 'warn' ? 'bg-yellow-50 text-yellow-700' :
            'bg-red-50 text-red-700'
          }`}>
            {scanMsg.text}
          </div>
        )}
      </div>

      {/* 筛选栏 + Action Bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={filterBatch}
          onChange={e => setFilterBatch(e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 bg-white"
        >
          <option value="">{isEn ? 'All Batches' : '全部批次'}</option>
          {driverSlots.map(s => <option key={s.id} value={`${s.batchNum} ${s.timeOfDay} ${s.driverName}`}>{s.batchNum} {s.timeOfDay} {s.driverName}</option>)}
        </select>
        <select
          value={filterPayment}
          onChange={e => setFilterPayment(e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 bg-white"
        >
          <option value="">{isEn ? 'All Payment Methods' : '全部付款方式'}</option>
          <option value="CASH">{isEn ? 'Cash' : '现付'}</option>
          <option value="ONLINE">{isEn ? 'Transfer' : '转账'}</option>
        </select>
        <select
          value={filterReturn}
          onChange={e => { setFilterReturn(e.target.value as 'all' | 'returned' | 'missing'); setActiveCard(null) }}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 bg-white"
        >
          <option value="all">{isEn ? 'All Return Status' : '全部回单状态'}</option>
          <option value="returned">{isEn ? 'Written Off Only' : '仅已核销'}</option>
          <option value="missing">{isEn ? 'Missing Only' : '仅漏单'}</option>
        </select>

        {selected.size > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm text-gray-600 font-medium">
              {isEn ? `${visibleSelectedCount} / ${visible.length} selected` : `已选 ${visibleSelectedCount} / ${visible.length} 张`}
            </span>
            <div className="relative" ref={actionRef}>
              <button
                onClick={() => setShowAction(v => !v)}
                disabled={bulkLoading}
                className="px-3 py-1.5 text-white rounded text-sm font-medium flex items-center gap-1 disabled:opacity-50"
                style={{ background: '#875A7B' }}
                onMouseEnter={e => { if (!bulkLoading) (e.currentTarget as HTMLElement).style.background = '#7a5070' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#875A7B' }}
              >
                {bulkLoading ? (isEn ? 'Processing…' : '处理中…') : 'Action ▾'}
              </button>
              {showAction && (
                <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded shadow-lg z-20 w-44 overflow-hidden">
                  <button
                    onClick={() => bulkMarkReturned(true)}
                    className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-50 text-gray-700"
                  >
                    {isEn ? '✅ Bulk Write-off (Returned)' : '✅ 批量核销（已回单）'}
                  </button>
                  <button
                    onClick={() => bulkMarkReturned(false)}
                    className="w-full px-4 py-2.5 text-left text-sm hover:bg-red-50 text-red-600"
                  >
                    {isEn ? '↩️ Bulk Undo Write-off' : '↩️ 批量撤销核销'}
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={() => setSelected(new Set())}
              className="px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-500 hover:text-gray-700 bg-white"
            >
              {isEn ? 'Clear Selection' : '取消选择'}
            </button>
          </div>
        )}

        {selected.size === 0 && (
          <span className="ml-auto text-xs text-gray-400">{isEn ? `${visible.length} total · Today ${today}` : `共 ${visible.length} 条 · 今日 ${today}`}</span>
        )}
      </div>

      {/* 订单列表 */}
      {loading ? (
        <div className="text-center py-16 text-gray-400">{isEn ? 'Loading…' : '加载中…'}</div>
      ) : visible.length === 0 ? (
        <div className="text-center py-16 text-gray-400">{isEn ? 'No orders today' : '今日暂无订单'}</div>
      ) : (
        <div ref={tableRef} className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden scroll-mt-6">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2.5 text-center w-8">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={() => toggleAll(selectableIds)}
                    style={{ accentColor: '#875A7B' }}
                    title={isEn ? 'Select all eligible orders' : '全选可勾选订单'}
                  />
                </th>
                <SortTh label={isEn ? 'Order #' : '订单号'} sk="code" cur={sortKey} dir={sortDir} onClick={toggleSort} align="left" isEn={isEn} />
                <SortTh label={isEn ? 'Restaurant' : '餐馆'} sk="restaurantName" cur={sortKey} dir={sortDir} onClick={toggleSort} align="left" isEn={isEn} />
                <SortTh label={isEn ? 'Batch/Driver' : '批次/司机'} sk="deliveryBatch" cur={sortKey} dir={sortDir} onClick={toggleSort} align="left" isEn={isEn} />
                <SortTh label={isEn ? 'Amount' : '金额'} sk="totalAmount" cur={sortKey} dir={sortDir} onClick={toggleSort} align="right" isEn={isEn} />
                <SortTh label={isEn ? 'Payment Method' : '付款方式'} sk="paymentMethod" cur={sortKey} dir={sortDir} onClick={toggleSort} align="center" isEn={isEn} />
                <SortTh label={isEn ? 'Status' : '状态'} sk="status" cur={sortKey} dir={sortDir} onClick={toggleSort} align="center" isEn={isEn} />
                <SortTh label={isEn ? 'Delivery Note' : '送货单'} sk="orderReturn" cur={sortKey} dir={sortDir} onClick={toggleSort} align="center" isEn={isEn} />
                <th className="px-4 py-2.5 text-center">{isEn ? 'Action' : '操作'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.map(order => {
                const o = order as Order & { deliveryBatch?: string }
                const isReturned = !!o.orderReturn
                const isCash = String(o.paymentMethod).toUpperCase() === 'CASH'
                const isMissing = !isReturned
                const isSelected = selected.has(o.id)
                const isFlashing = flashId === o.id

                let rowBg = ''
                if (isFlashing) rowBg = 'bg-purple-50 transition-colors duration-500'
                else if (isSelected) rowBg = 'bg-purple-50/50'
                else if (isMissing && isCash) rowBg = 'bg-red-50'
                else if (isMissing) rowBg = 'bg-yellow-50'

                return (
                  <tr
                    key={o.id}
                    ref={el => { rowRefs.current[o.id] = el }}
                    className={`hover:bg-gray-50 transition-colors ${rowBg}`}
                  >
                    <td className="px-3 py-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(o.id)}
                        disabled={isReturned}
                        style={{ accentColor: '#875A7B' }}
                        className="disabled:opacity-40 disabled:cursor-not-allowed"
                      />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-700">
                      {o.code ?? o.id.slice(-8)}
                    </td>
                    <td className="px-4 py-2.5 text-gray-800 max-w-[140px] truncate">
                      {o.restaurantName}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">
                      {formatDriverSlotFromOrder(o) || <span className="text-gray-300">{isEn ? 'Unassigned' : '未分配'}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold text-gray-800">
                      €{(o.totalAmount ?? 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        isCash ? 'bg-gray-100 text-gray-700' : 'bg-gray-50 text-gray-600'
                      }`}>
                        {isCash ? (isEn ? 'Cash' : '现付') : (isEn ? 'Transfer' : '转账')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs ${
                        String(o.status).toUpperCase() === 'CONFIRMED' ? 'bg-blue-50 text-blue-700' :
                        String(o.status).toUpperCase() === 'WAVE_ASSIGNED' ? 'bg-amber-50 text-amber-700' :
                        String(o.status).toUpperCase() === 'IN_DELIVERY' ? 'bg-purple-50 text-purple-700' :
                        'bg-green-50 text-green-700'
                      }`}>
                        {isEn
                          ? (String(o.status).toUpperCase() === 'CONFIRMED' ? 'Confirmed' :
                             String(o.status).toUpperCase() === 'WAVE_ASSIGNED' ? 'Driver Assigned' :
                             String(o.status).toUpperCase() === 'IN_DELIVERY' ? 'In Delivery' : 'Completed')
                          : (String(o.status).toUpperCase() === 'CONFIRMED' ? '已确认' :
                             String(o.status).toUpperCase() === 'WAVE_ASSIGNED' ? '司机分配结束' :
                             String(o.status).toUpperCase() === 'IN_DELIVERY' ? '配送中' : '已完成')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {isReturned ? (
                        <span className="text-green-600 font-semibold text-xs">{isEn ? '✅ Returned' : '✅ 已回'}</span>
                      ) : (
                        <span className="text-red-500 font-semibold text-xs animate-pulse">{isEn ? '⚠️ Not Returned' : '⚠️ 未回'}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {isReturned ? (
                        <button
                          onClick={() => {
                            setSelected(new Set([o.id]))
                            bulkMarkReturned(false)
                          }}
                          className="text-xs text-gray-400 hover:text-red-500 underline"
                        >
                          {isEn ? 'Undo' : '撤销'}
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            setSelected(new Set([o.id]))
                            setTimeout(() => bulkMarkReturned(true), 0)
                          }}
                          className="px-3 py-1 text-white text-xs rounded font-medium"
                          style={{ background: '#875A7B' }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#7a5070' }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#875A7B' }}
                        >
                          {isEn ? 'Write off' : '核销'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 漏单警告 */}
      {missingCount > 0 && (
        <div className="bg-red-50 border border-red-200 rounded px-5 py-4">
          <div className="font-semibold text-red-700 mb-1">{isEn ? `⚠️ ${missingCount} delivery note(s) not yet returned today` : `⚠️ 今日共有 ${missingCount} 张送货单未回`}</div>
          <div className="text-sm text-red-600">
            {isEn ? 'Contact the driver immediately to trace the delivery note. Cash orders carry the highest risk — prioritize those.' : '请立即联系对应司机追查签收单。现付漏单风险最高，优先处理现付订单。'}
          </div>
        </div>
      )}
    </div>
  )
}

function SortTh({ label, sk, cur, dir, onClick, align, isEn }: {
  label: string
  sk: SortKey
  cur: SortKey
  dir: SortDir
  onClick: (k: SortKey) => void
  align: 'left' | 'right' | 'center'
  isEn: boolean
}) {
  const active = cur === sk
  const arrow = active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
  return (
    <th
      className={`px-4 py-2.5 ${alignCls} cursor-pointer select-none hover:bg-gray-100 transition-colors whitespace-nowrap`}
      onClick={() => onClick(sk)}
      title={isEn ? `Sort by "${label}"` : `按「${label}」排序`}
    >
      <span style={active ? { color: '#875A7B', fontWeight: 600 } : {}}>{label}</span>
      <span style={{ color: '#875A7B' }}>{arrow}</span>
    </th>
  )
}

function StatCard({ label, value, urgent, active, onClick }: {
  label: string
  value: number | string
  urgent?: boolean
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left w-full rounded border px-4 py-3 transition-all bg-white ${
        active
          ? 'shadow-md'
          : 'border-gray-200 hover:shadow-md hover:border-gray-300'
      }`}
      style={active ? { borderColor: '#875A7B', boxShadow: '0 0 0 2px #e8d5f0' } : {}}
    >
      <div className="text-xs font-medium text-gray-500 flex items-center gap-1">
        {label}
        <span className="text-[10px] opacity-60">{active ? '●' : '›'}</span>
      </div>
      <div
        className="text-2xl font-bold mt-1"
        style={{ color: urgent ? '#dc2626' : active ? '#875A7B' : '#1f2937' }}
      >
        {value}
      </div>
    </button>
  )
}
