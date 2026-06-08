'use client'
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import type { PickingWave, WaveStatus, Order } from '@/lib/types'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { displayOrderCode } from '@/lib/order-code'

/* ─── Slot colour palette (matching mockup) ──────────────────────────────── */
const SLOT_COLORS: Record<number, { bg: string; text: string; border: string; badge: string }> = {
  1: { bg: '#ede9fe', text: '#6d28d9', border: '#875A7B', badge: 'linear-gradient(135deg,#7c3aed,#6d28d9)' },
  2: { bg: '#fef3c7', text: '#92400e', border: '#f59e0b', badge: 'linear-gradient(135deg,#f59e0b,#d97706)' },
  3: { bg: '#d1fae5', text: '#065f46', border: '#10b981', badge: 'linear-gradient(135deg,#10b981,#059669)' },
  4: { bg: '#dbeafe', text: '#1e40af', border: '#3b82f6', badge: 'linear-gradient(135deg,#3b82f6,#2563eb)' },
  5: { bg: '#fce7f3', text: '#9d174d', border: '#ec4899', badge: 'linear-gradient(135deg,#ec4899,#db2777)' },
}
function slotColor(n: number) {
  const key = ((n - 1) % 5) + 1
  return SLOT_COLORS[key]
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function normalizeWave(w: Record<string, unknown>): PickingWave {
  return {
    ...(w as unknown as PickingWave),
    status: (w.status as string).toLowerCase() as WaveStatus,
    zones: (w.zones as PickingWave['zones']) ?? [],
    orderIds: (w.orderIds as string[]) ?? [],
  }
}

function normalizeOrder(o: Record<string, unknown>): Order {
  return {
    ...(o as unknown as Order),
    status: (o.status as string).toLowerCase() as Order['status'],
  }
}

const TRANSPARENT_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/* ═══════════════════════════════════════════════════════════════════════════ */
export default function WaveManagementPage() {
  const [date, setDate] = useState(todayStr)
  const [waves, setWaves] = useState<PickingWave[]>([])
  const [allOrders, setAllOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [customerAddrMap, setCustomerAddrMap] = useState<Map<string, string>>(new Map())

  const [dragOverSlotId, setDragOverSlotId] = useState<string | null>(null)
  const [leftPanelDragOver, setLeftPanelDragOver] = useState(false)
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())
  const [overflowIds, setOverflowIds] = useState<Set<string>>(new Set())

  const dragOrderIdRef = useRef<string | null>(null)
  const dragSourceWaveIdRef = useRef<string | null>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const autoGenAttemptedRef = useRef<string | null>(null)
  const productRefsMap = useRef<Map<string, HTMLDivElement>>(new Map())

  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  /* ── Custom drag ghost movement ────────────────────────────────────────── */
  const moveGhost = useCallback((e: Event) => {
    const me = e as MouseEvent
    if (ghostRef.current) {
      ghostRef.current.style.left = me.clientX + 12 + 'px'
      ghostRef.current.style.top = me.clientY + 12 + 'px'
    }
  }, [])

  useEffect(() => {
    return () => { document.removeEventListener('dragover', moveGhost) }
  }, [moveGhost])

  /* ── Data loading ──────────────────────────────────────────────────────── */
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rawWaves, rawOrders, rawCustomers] = await Promise.all([
        apiGet<Record<string, unknown>[]>(`/api/waves?date=${date}`),
        apiGet<Record<string, unknown>[]>('/api/orders?status=CONFIRMED&include_lines=false&limit=500'),
        apiGet<{ id: string; name: string; address: string }[]>('/api/customers?slim=1').catch(() => []),
      ])
      const loadedWaves = rawWaves.map(normalizeWave)
      setWaves(loadedWaves)
      setAllOrders(rawOrders.map(normalizeOrder))
      const addrMap = new Map<string, string>()
      for (const c of rawCustomers) {
        if (c.name && c.address) addrMap.set(c.name, c.address)
      }
      setCustomerAddrMap(addrMap)

      if (loadedWaves.length === 0 && autoGenAttemptedRef.current !== date) {
        autoGenAttemptedRef.current = date
        try {
          const raw = await apiPost<Record<string, unknown>[]>('/api/waves/generate-daily', { date })
          setWaves(raw.map(normalizeWave))
        } catch {
          // silent — user can still work without waves
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载数据失败')
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => { load() }, [load])

  /* ── Derived state ─────────────────────────────────────────────────────── */
  const assignedOrderIds = useMemo(
    () => new Set(waves.flatMap(w => w.orderIds)),
    [waves],
  )

  const unassignedOrders = useMemo(
    () => allOrders.filter(o => !assignedOrderIds.has(o.id)),
    [allOrders, assignedOrderIds],
  )

  const filteredUnassigned = useMemo(() => {
    if (!search.trim()) return unassignedOrders
    const q = search.trim().toLowerCase()
    return unassignedOrders.filter(o =>
      o.restaurantName.toLowerCase().includes(q) ||
      displayOrderCode(o).toLowerCase().includes(q) ||
      (customerAddrMap.get(o.restaurantName) ?? '').toLowerCase().includes(q),
    )
  }, [unassignedOrders, search, customerAddrMap])

  const summaryStats = useMemo(() => {
    const total = allOrders.length
    const assigned = assignedOrderIds.size
    const unassigned = unassignedOrders.length
    const totalAmount = allOrders.reduce((s, o) => s + (o.totalAmount ?? 0), 0)
    return { total, assigned, unassigned, totalAmount }
  }, [allOrders, assignedOrderIds, unassignedOrders])

  /* ── Overflow detection for product tags ───────────────────────────────── */
  useEffect(() => {
    requestAnimationFrame(() => {
      const next = new Set<string>()
      productRefsMap.current.forEach((el, orderId) => {
        if (el.scrollHeight > el.clientHeight + 2) next.add(orderId)
      })
      setOverflowIds(prev => {
        if (prev.size === next.size && [...prev].every(id => next.has(id))) return prev
        return next
      })
    })
  }, [filteredUnassigned, expandedCards])

  /* ── Get full order data for a wave's orderIds ─────────────────────────── */
  function getWaveOrders(wave: PickingWave): Order[] {
    return wave.orderIds
      .map(id => allOrders.find(o => o.id === id))
      .filter((o): o is Order => !!o)
  }

  function waveItemCount(wave: PickingWave): number {
    return getWaveOrders(wave).reduce((s, o) => s + o.items.reduce((a, i) => a + i.quantity, 0), 0)
  }

  function waveAmount(wave: PickingWave): number {
    return getWaveOrders(wave).reduce((s, o) => s + (o.totalAmount ?? 0), 0)
  }

  /* ── Drag start/end ───────────────────────────────────────────────────── */
  function startDrag(e: React.DragEvent, orderId: string, sourceWaveId: string | null) {
    dragOrderIdRef.current = orderId
    dragSourceWaveIdRef.current = sourceWaveId
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', orderId)

    const order = allOrders.find(o => o.id === orderId)
    if (ghostRef.current && order) {
      ghostRef.current.textContent = `📦 ${order.restaurantName}`
      ghostRef.current.style.display = 'block'
      ghostRef.current.style.left = e.clientX + 12 + 'px'
      ghostRef.current.style.top = e.clientY + 12 + 'px'
    }

    const img = new Image()
    img.src = TRANSPARENT_GIF
    e.dataTransfer.setDragImage(img, 0, 0)

    document.addEventListener('dragover', moveGhost)

    const target = e.currentTarget as HTMLElement
    requestAnimationFrame(() => { target.style.opacity = '0.4' })
  }

  function endDrag(e: React.DragEvent) {
    (e.currentTarget as HTMLElement).style.opacity = '1'
    if (ghostRef.current) ghostRef.current.style.display = 'none'
    document.removeEventListener('dragover', moveGhost)
    setDragOverSlotId(null)
    setLeftPanelDragOver(false)
    dragOrderIdRef.current = null
    dragSourceWaveIdRef.current = null
  }

  /* ── Optimistic assign / unassign / move ──────────────────────────────── */
  async function assignToSlot(waveId: string, orderId: string) {
    setWaves(prev => prev.map(w =>
      w.id === waveId ? { ...w, orderIds: [...w.orderIds, orderId] } : w,
    ))
    try {
      await apiPut(`/api/waves/${waveId}/assign`, { orderIds: [orderId] })
      toast.success('已分配订单')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '分配失败')
      await load()
    }
  }

  async function unassignFromSlot(waveId: string, orderId: string) {
    setWaves(prev => prev.map(w =>
      w.id === waveId ? { ...w, orderIds: w.orderIds.filter(id => id !== orderId) } : w,
    ))
    try {
      await apiPut(`/api/waves/${waveId}/unassign`, { orderIds: [orderId] })
      toast.success('已移回待分配')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '移除失败')
      await load()
    }
  }

  async function moveBetweenSlots(fromWaveId: string, toWaveId: string, orderId: string) {
    setWaves(prev => prev.map(w => {
      if (w.id === fromWaveId) return { ...w, orderIds: w.orderIds.filter(id => id !== orderId) }
      if (w.id === toWaveId) return { ...w, orderIds: [...w.orderIds, orderId] }
      return w
    }))
    try {
      await apiPut(`/api/waves/${fromWaveId}/unassign`, { orderIds: [orderId] })
      await apiPut(`/api/waves/${toWaveId}/assign`, { orderIds: [orderId] })
      toast.success('已移动订单')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '移动失败')
      await load()
    }
  }

  /* ── Slot DnD handlers ────────────────────────────────────────────────── */
  function handleSlotDragOver(e: React.DragEvent, slotId: string) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverSlotId(slotId)
  }

  function handleSlotDragLeave(e: React.DragEvent, slotId: string) {
    const slotEl = e.currentTarget as HTMLElement
    if (!slotEl.contains(e.relatedTarget as Node)) {
      setDragOverSlotId(prev => prev === slotId ? null : prev)
    }
  }

  function handleSlotDrop(e: React.DragEvent, slotId: string) {
    e.preventDefault()
    setDragOverSlotId(null)
    const orderId = dragOrderIdRef.current
    if (!orderId) return
    const sourceWaveId = dragSourceWaveIdRef.current

    if (sourceWaveId === slotId) return

    if (sourceWaveId) {
      moveBetweenSlots(sourceWaveId, slotId, orderId)
    } else {
      assignToSlot(slotId, orderId)
    }
  }

  /* ── Left panel DnD handlers ──────────────────────────────────────────── */
  function handleLeftDragOver(e: React.DragEvent) {
    if (dragSourceWaveIdRef.current) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setLeftPanelDragOver(true)
    }
  }

  function handleLeftDragLeave(e: React.DragEvent) {
    const el = e.currentTarget as HTMLElement
    if (!el.contains(e.relatedTarget as Node)) {
      setLeftPanelDragOver(false)
    }
  }

  function handleLeftDrop(e: React.DragEvent) {
    e.preventDefault()
    setLeftPanelDragOver(false)
    const orderId = dragOrderIdRef.current
    const sourceWaveId = dragSourceWaveIdRef.current
    if (orderId && sourceWaveId) {
      unassignFromSlot(sourceWaveId, orderId)
    }
  }

  /* ── Toggle expand ────────────────────────────────────────────────────── */
  function toggleExpand(e: React.MouseEvent, orderId: string) {
    e.stopPropagation()
    e.preventDefault()
    setExpandedCards(prev => {
      const next = new Set(prev)
      if (next.has(orderId)) next.delete(orderId); else next.add(orderId)
      return next
    })
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  return (
    <div className="h-full flex flex-col bg-gray-50">
      <OdooControlPanel
        breadcrumb={['仓库', '波次分配']}
        permanentActions={[{ label: '刷新', onClick: load }]}
        searchValue=""
        onSearch={() => {}}
      />

      {/* ── Top bar: date + status ───────────────────────────────────────── */}
      <div className="px-4 pt-3 pb-2 flex items-center gap-3 flex-wrap">
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="h-8 px-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-purple-400"
        />
        {waves.length > 0 && (
          <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-full px-3 py-1 font-medium">
            ✓ {waves.length} 个波次已就绪
          </span>
        )}
        {loading && <span className="text-xs text-gray-400">加载中...</span>}
      </div>

      {/* ── Summary bar ───────────────────────────────────────────────────── */}
      <div className="px-4 pb-2">
        <div className="flex items-center gap-6 text-xs text-gray-600 bg-white rounded border px-4 py-2">
          <span>总订单: <strong className="text-gray-900">{summaryStats.total}</strong></span>
          <span>已分配: <strong className="text-green-700">{summaryStats.assigned}</strong></span>
          <span>未分配: <strong className="text-amber-700">{summaryStats.unassigned}</strong></span>
          <span>总金额: <strong className="text-gray-900">€{summaryStats.totalAmount.toFixed(2)}</strong></span>
        </div>
      </div>

      {/* ── Main layout: left (unassigned) + right (slots) ────────────────── */}
      <div className="flex-1 flex overflow-hidden px-4 pb-4 gap-4" style={{ minHeight: 0 }}>

        {/* ─── Left Panel: Unassigned Orders ─────────────────────────────── */}
        <div
          className="flex flex-col rounded-lg border shadow-sm transition-colors"
          style={{
            width: 380, minWidth: 320,
            background: leftPanelDragOver ? '#faf5ff' : '#fff',
            borderColor: leftPanelDragOver ? '#875A7B' : undefined,
          }}
          onDragOver={handleLeftDragOver}
          onDragLeave={handleLeftDragLeave}
          onDrop={handleLeftDrop}
        >
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-800">待分配订单</h3>
              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-amber-100 text-amber-800 text-xs font-bold">
                {unassignedOrders.length}
              </span>
            </div>
          </div>

          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索餐馆名称或订单号..."
            className="mx-4 mt-2.5 mb-1 h-8 px-2.5 border border-gray-200 rounded-md text-[13px] outline-none focus:border-[#875A7B] focus:ring-1 focus:ring-[rgba(135,90,123,0.1)]"
          />

          <div className="flex-1 overflow-y-auto px-0 py-1">
            {filteredUnassigned.length === 0 ? (
              <div className="flex items-center justify-center h-full text-sm text-gray-400">
                {unassignedOrders.length === 0 ? '所有订单已分配 ✨' : '无匹配订单'}
              </div>
            ) : (
              filteredUnassigned.map(o => {
                const itemCount = o.items.reduce((s, i) => s + i.quantity, 0)
                const addr = customerAddrMap.get(o.restaurantName)
                const isExpanded = expandedCards.has(o.id)
                const hasOverflow = overflowIds.has(o.id)
                return (
                  <div
                    key={o.id}
                    draggable
                    onDragStart={e => startDrag(e, o.id, null)}
                    onDragEnd={endDrag}
                    className="mx-3 mb-1 px-3 py-2.5 bg-white border border-gray-200 rounded-lg cursor-grab hover:border-purple-300 hover:bg-purple-50/30 active:cursor-grabbing transition-all"
                  >
                    {/* Top row: code + meta */}
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        draggable={false}
                        onClick={e => {
                          e.stopPropagation()
                          const seg = o.status === 'pending' ? 'quotations' : 'orders'
                          window.open(`${prefix}/classic/operator/${seg}/${o.id}`, '_blank')
                        }}
                        className="font-mono text-[11px] font-semibold hover:underline cursor-pointer bg-transparent border-none p-0"
                        style={{ color: '#875A7B' }}
                        title="查看订单详情（新标签页）"
                      >
                        {displayOrderCode(o)}
                      </button>
                      <span className="ml-auto text-[10px] text-gray-500 whitespace-nowrap">
                        {o.items.length}种/{itemCount}件{' '}
                        <span className="font-semibold text-gray-700">€{(o.totalAmount ?? 0).toFixed(2)}</span>
                      </span>
                    </div>
                    {/* Name + address */}
                    <div className="mt-0.5 text-xs text-gray-800 truncate leading-snug">
                      <span className="font-medium">{o.restaurantName}</span>
                      {addr && <span className="text-gray-400 text-[11px] ml-1">{addr}</span>}
                    </div>
                    {/* Products */}
                    {o.items.length > 0 && (
                      <div
                        ref={el => {
                          if (el) productRefsMap.current.set(o.id, el)
                          else productRefsMap.current.delete(o.id)
                        }}
                        className="flex flex-wrap gap-1 mt-1.5 overflow-hidden transition-all duration-200"
                        style={{ maxHeight: isExpanded ? 500 : 110 }}
                      >
                        {o.items.map((item, idx) => (
                          <span key={idx} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                            {item.productName} x{item.quantity}
                          </span>
                        ))}
                      </div>
                    )}
                    {/* Expand button */}
                    {(hasOverflow || isExpanded) && (
                      <button
                        onClick={e => toggleExpand(e, o.id)}
                        className="text-[10px] font-medium mt-1 border-none bg-transparent p-0 cursor-pointer hover:underline"
                        style={{ color: '#875A7B' }}
                      >
                        {isExpanded ? '收起 ▴' : '展开全部 ▾'}
                      </button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* ─── Right Panel: Driver Slots (2-column grid) ────────────────── */}
        <div className="flex-1 overflow-y-auto" style={{ minWidth: 0 }}>
          {waves.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-gray-400 space-y-3">
                <div className="text-4xl">📦</div>
                <p className="text-sm">今日尚无波次</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-4 items-start content-start">
              {waves.map(wave => {
                const sc = slotColor(wave.waveNumber ?? 1)
                const wOrders = getWaveOrders(wave)
                const isBulk = wave.waveType === 'bulk'
                const borderColor = isBulk ? '#f59e0b' : '#875A7B'
                const isOver = dragOverSlotId === wave.id
                const totalItems = wOrders.reduce((s, o) => s + o.items.length, 0)
                const totalAmount = wOrders.reduce((s, o) => s + (o.totalAmount ?? 0), 0)

                return (
                  <div
                    key={wave.id}
                    className="flex flex-col rounded-xl border overflow-hidden transition-all"
                    style={{
                      width: 'calc(50% - 8px)', minHeight: 200,
                      background: '#fff',
                      borderLeft: `4px solid ${borderColor}`,
                      borderColor: isOver ? '#875A7B' : undefined,
                      boxShadow: isOver ? '0 0 0 3px rgba(135,90,123,0.15)' : undefined,
                    }}
                    onDragOver={e => handleSlotDragOver(e, wave.id)}
                    onDragLeave={e => handleSlotDragLeave(e, wave.id)}
                    onDrop={e => handleSlotDrop(e, wave.id)}
                  >
                    {/* Slot header */}
                    <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
                      <div
                        className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-lg flex-shrink-0"
                        style={{ background: sc.badge }}
                      >
                        {wave.waveNumber ?? '?'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-gray-800">
                          {wave.driverName ?? `Wave ${wave.waveNumber}`}
                        </div>
                        <div className="text-[11px] text-gray-400 mt-0.5">
                          Wave {wave.waveNumber} · {isBulk ? '下午 · 大货' : '上午 · 散货'}
                        </div>
                      </div>
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full font-semibold flex-shrink-0"
                        style={{ background: sc.bg, color: sc.text }}
                      >
                        {isBulk ? '大货' : '散货'}
                      </span>
                      <div className="flex items-center gap-3 text-[11px] text-gray-500 flex-shrink-0">
                        <span><strong className="text-gray-700">{wOrders.length}</strong> 单</span>
                        <span><strong className="text-gray-700">{totalItems}</strong> 品</span>
                      </div>
                    </div>

                    {/* Slot body */}
                    <div className="flex-1 p-2 min-h-[80px] relative">
                      {wOrders.length === 0 && (
                        <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-300 pointer-events-none">
                          拖拽订单到这里
                        </div>
                      )}
                      {wOrders.map(o => {
                        const addr = customerAddrMap.get(o.restaurantName)
                        const cnt = o.items.reduce((s, i) => s + i.quantity, 0)
                        return (
                          <div
                            key={o.id}
                            draggable
                            onDragStart={e => startDrag(e, o.id, wave.id)}
                            onDragEnd={endDrag}
                            className="flex items-center gap-2 px-2.5 py-2 mb-1 bg-gray-50 border border-gray-200 rounded-md cursor-grab hover:bg-purple-50/40 hover:border-purple-300 active:cursor-grabbing transition-all text-xs"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-[10px] font-semibold" style={{ color: '#875A7B' }}>
                                  {displayOrderCode(o)}
                                </span>
                                <span className="text-xs font-medium text-gray-700 truncate">{o.restaurantName}</span>
                              </div>
                              {addr && (
                                <div className="text-[10px] text-gray-400 mt-0.5 truncate">{addr}</div>
                              )}
                              <div className="text-[10px] text-gray-400 mt-0.5">
                                {o.items.length} 种 / {cnt} 件 · €{(o.totalAmount ?? 0).toFixed(2)}
                              </div>
                            </div>
                            <button
                              onClick={() => unassignFromSlot(wave.id, o.id)}
                              className="w-5 h-5 flex items-center justify-center rounded text-gray-300 hover:text-red-500 hover:bg-red-50 flex-shrink-0 text-sm leading-none"
                              title="移回待分配"
                            >
                              ✕
                            </button>
                          </div>
                        )
                      })}
                    </div>

                    {/* Slot footer */}
                    <div className="px-4 py-2 border-t border-gray-100 flex items-center justify-between">
                      <span className="text-[11px] text-gray-500">
                        <strong className="text-gray-700">{wOrders.length}</strong> 单 · €{totalAmount.toFixed(2)}
                      </span>
                      <button
                        onClick={() => router.push(`${prefix}/classic/operator/waves/${wave.id}`)}
                        className="text-[11px] px-2.5 py-1 rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:text-gray-800 transition-colors"
                      >
                        🖨 打印拣货单
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Drag Ghost ────────────────────────────────────────────────────── */}
      <div
        ref={ghostRef}
        className="pointer-events-none whitespace-nowrap"
        style={{
          position: 'fixed', zIndex: 9999,
          padding: '8px 14px', background: '#875A7B', color: '#fff', borderRadius: 8,
          fontSize: 12, fontWeight: 600, boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          display: 'none',
        }}
      />
    </div>
  )
}
