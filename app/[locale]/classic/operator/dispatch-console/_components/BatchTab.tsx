'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import { waveStage } from '@/lib/wave-stage'
import { DRIVER_APP_ENABLED } from '@/lib/features'
import { restaurantColor } from './colors'

const PURPLE = '#875A7B'

interface DriverSlot { id: string; timeOfDay: string; batchNum: number; driverName: string }
interface OrderItem { productId: string; productName: string; quantity: number; uomName?: string }
interface OrderLine { orderedQty: number | string; product?: { template?: { weight?: number | null } | null } | null }
interface Order {
  id: string; code: string | null; restaurantId: string; restaurantName: string
  items: OrderItem[]; totalAmount: number | string; status: string
  lines?: OrderLine[]
}
interface Wave {
  id: string; name: string | null; orderIds: string[]; status: string
  waveType: string | null; waveNumber: number | null; driverSlotId: string | null; driverName: string | null
  dispatchedAt: string | null; completedAt: string | null; assignmentDoneAt: string | null
  pickLockedAt: string | null; pickLockedBy: string | null
}

const WAVE_STATUS: Record<string, { text: string; cls: string; pct: number }> = {
  PENDING: { text: '待理货', cls: 'bg-gray-100 text-gray-500', pct: 10 },
  PICKING: { text: '理货中', cls: 'bg-blue-100 text-blue-700', pct: 50 },
  PICKED: { text: '已拣货', cls: 'bg-blue-100 text-blue-700', pct: 70 },
  SORTING: { text: '分货中', cls: 'bg-amber-100 text-amber-700', pct: 85 },
  SORTED: { text: '已就绪', cls: 'bg-green-100 text-green-700', pct: 100 },
}

const num = (v: number | string) => (typeof v === 'number' ? v : Number(v) || 0)
const SRC = 'application/x-source-wave'

function shiftDate(base: string, days: number) {
  const d = new Date(base + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export default function BatchTab({ date, onPickDate }: { date: string; onPickDate?: (d: string) => void }) {
  const [slots, setSlots] = useState<DriverSlot[]>([])
  const [waves, setWaves] = useState<Wave[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  // 其他日期(≠当前所选)仍有已排订单的分布,用于顶部提示条,避免「排完切到调度台一片空」
  const [otherDates, setOtherDates] = useState<{ date: string; orders: number }[]>([])
  const [dragOverWave, setDragOverWave] = useState<string | null>(null)
  const [dragOverLeft, setDragOverLeft] = useState(false)
  // 拖拽进行中：拖起订单卡即置真，落下/结束置假。用于给锁定/已出发的车盖「不可拖入」遮罩，
  // 让「拖不进去」有明确原因，而不是浏览器静默拒绝（dropEffect='none' 时 drop 事件不触发）。
  const [dragging, setDragging] = useState(false)
  // ② 调度交互：先选司机,右侧只显示选中的;AM/PM 可折叠;"确定"=收工清场
  const [selectedDrivers, setSelectedDrivers] = useState<Set<string>>(new Set())
  const [amCollapsed, setAmCollapsed] = useState(false)
  const [pmCollapsed, setPmCollapsed] = useState(false)
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(new Set())
  // 顶部统计卡点击联动:右侧车次区/左侧待分配竖条的滚动锚点 + 左侧短暂高亮
  const rightPanelRef = useRef<HTMLDivElement>(null)
  const leftPanelRef = useRef<HTMLDivElement>(null)
  const [flashLeft, setFlashLeft] = useState(false)

  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  function openOrder(id: string) {
    window.open(`${prefix}/classic/operator/orders/${id}`, '_blank', 'noopener,noreferrer')
  }

  const load = useCallback(async () => {
    if (!date) return
    setLoading(true)
    try {
      const [slotData, candidateOrders] = await Promise.all([
        apiGet<DriverSlot[]>('/api/driver-slots'),
        apiGet<Order[]>(`/api/orders?status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY&include_lines=true&limit=500&dateField=deliveryDate&fromDate=${date}&toDate=${date}`),
      ])
      let waveData = await apiGet<Wave[]>(`/api/waves?date=${date}`)
      if (waveData.length === 0 && slotData.length > 0) {
        try {
          await apiPost('/api/waves/generate-daily', { date })
          waveData = await apiGet<Wave[]>(`/api/waves?date=${date}`)
        } catch { /* 生成失败不阻断展示 */ }
      }
      // 调度台以 wave.waveDate 为口径:车里的订单按 wave.orderIds 直接补拉,
      // 不受 deliveryDate 限制(deliveryDate 只在「确认出发」时才回填,分配阶段为空)。
      // 否则销售单已排司机的订单(deliveryDate 为空)在此看不到,角标也对不上卡片计数。
      const candidateIds = new Set(candidateOrders.map(o => o.id))
      const missingIds = [...new Set(waveData.flatMap(w => w.orderIds))].filter(id => !candidateIds.has(id))
      const waveOrders = missingIds.length
        ? await apiGet<Order[]>(`/api/orders?ids=${missingIds.join(',')}&include_lines=true&limit=500`)
        : []
      setSlots(slotData)
      setOrders([...candidateOrders, ...waveOrders])
      setWaves(waveData)
    } catch {
      toast.error('加载批次数据失败')
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => { load() }, [load])

  // 拉 ±45 天内各 waveDate 的已排单量,排除当前日期,得到「其他日期还有单」提示。复用 driver-summary,不改后端。
  useEffect(() => {
    if (!date) return
    let cancelled = false
    ;(async () => {
      try {
        const from = shiftDate(date, -45), to = shiftDate(date, 45)
        const sum = await apiGet<{ rows: { waveDate: string | null; orderCount: number }[] }>(
          `/api/dispatch/driver-summary?from=${from}&to=${to}`,
        )
        const byDate = new Map<string, number>()
        for (const r of sum.rows) if (r.waveDate) byDate.set(r.waveDate, (byDate.get(r.waveDate) ?? 0) + r.orderCount)
        byDate.delete(date)
        const others = [...byDate].filter(([, n]) => n > 0).map(([d, n]) => ({ date: d, orders: n })).sort((a, b) => a.date.localeCompare(b.date))
        if (!cancelled) setOtherDates(others)
      } catch { /* 提示条失败不影响主看板 */ }
    })()
    return () => { cancelled = true }
  }, [date])

  const ordersById = new Map(orders.map(o => [o.id, o])) // 含 IN_DELIVERY，供已出发批次渲染
  const confirmedOrders = orders.filter(o => o.status === 'CONFIRMED') // 仅可派送（未出发）
  const assigned = new Set(waves.flatMap(w => w.orderIds))
  const unassigned = confirmedOrders.filter(o => !assigned.has(o.id))
  const amSlots = slots.filter(s => s.timeOfDay === 'am')
  const pmSlots = slots.filter(s => s.timeOfDay === 'pm')
  const waveForSlot = (slotId: string) => waves.find(w => w.driverSlotId === slotId)

  // 司机名去重(一个司机可有 am+pm 多个 slot) + 今日已分配单数(其所有 slot 的 wave 合计)
  const driverNames = [...new Set(slots.map(s => s.driverName))].sort((a, b) => a.localeCompare(b))
  const orderCountByDriver = new Map<string, number>()
  for (const s of slots) {
    const w = waveForSlot(s.id)
    if (w) orderCountByDriver.set(s.driverName, (orderCountByDriver.get(s.driverName) ?? 0) + w.orderIds.length)
  }
  const selAmSlots = amSlots.filter(s => selectedDrivers.has(s.driverName))
  const selPmSlots = pmSlots.filter(s => selectedDrivers.has(s.driverName))
  const allSelected = driverNames.length > 0 && selectedDrivers.size === driverNames.length

  function toggleDriver(name: string) {
    setSelectedDrivers(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n })
  }
  function toggleAll() {
    setSelectedDrivers(allSelected ? new Set() : new Set(driverNames))
  }

  // ── 顶部统计卡点击联动 ──
  function focusRightPanel() {
    requestAnimationFrame(() => rightPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  // 司机批次:选中全部司机,右侧展开当天全部车次
  function showAllDriverWaves() {
    if (driverNames.length === 0) return
    setSelectedDrivers(new Set(driverNames))
    focusRightPanel()
  }
  // 已入批:选中有订单的司机(角标>0),右侧展开这些车次(订单在卡片内)
  function showInBatchDrivers() {
    const names = driverNames.filter(n => (orderCountByDriver.get(n) ?? 0) > 0)
    if (names.length === 0) { toast.info('当前没有已入批的订单'); return }
    setSelectedDrivers(new Set(names))
    focusRightPanel()
  }
  // 已排完:选中「分配完成」车次对应的司机,右侧只留这些车次
  function showAssignmentDoneDrivers() {
    const names = new Set<string>()
    for (const s of slots) {
      const w = waveForSlot(s.id)
      if (w && waveStage(w) === 'assignment_done') names.add(s.driverName)
    }
    if (names.size === 0) { toast.info('还没有「分配完成」的车次'); return }
    setSelectedDrivers(names)
    focusRightPanel()
  }
  // 待分配:滚到左侧竖条并短暂高亮(待分配订单卡片就列在那里)
  function focusUnassigned() {
    requestAnimationFrame(() => leftPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    setFlashLeft(true)
    window.setTimeout(() => setFlashLeft(false), 1600)
  }

  // 已入批(单):当天所有批次内订单去重数 = 下方各司机角标之和(assigned 与 orderCountByDriver 同源)
  const inBatchCount = assigned.size
  const assignmentDoneCount = waves.filter(w => waveStage(w) === 'assignment_done').length

  /* ── 乐观分配 / 移除 / 移动（参考 waves 页，不整页 reload）── */
  async function assignToWave(waveId: string, orderId: string) {
    setWaves(prev => prev.map(w => (w.id === waveId ? { ...w, orderIds: [...w.orderIds, orderId], assignmentDoneAt: null } : w)))
    try {
      await apiPut(`/api/waves/${waveId}/assign`, { orderIds: [orderId] })
      toast.success('已分配')
    } catch (e) { toast.error(e instanceof Error ? e.message : '分配失败'); load() }
  }
  async function unassignFromWave(waveId: string, orderId: string) {
    setWaves(prev => prev.map(w => (w.id === waveId ? { ...w, orderIds: w.orderIds.filter(id => id !== orderId), assignmentDoneAt: null } : w)))
    try {
      await apiPut(`/api/waves/${waveId}/unassign`, { orderIds: [orderId] })
      toast.success('已移回待分配')
    } catch (e) { toast.error(e instanceof Error ? e.message : '移除失败'); load() }
  }
  async function moveWave(fromId: string, toId: string, orderId: string) {
    setWaves(prev => prev.map(w => {
      if (w.id === fromId) return { ...w, orderIds: w.orderIds.filter(id => id !== orderId), assignmentDoneAt: null }
      if (w.id === toId) return { ...w, orderIds: [...w.orderIds, orderId], assignmentDoneAt: null }
      return w
    }))
    try {
      await apiPut(`/api/waves/${fromId}/unassign`, { orderIds: [orderId] })
      await apiPut(`/api/waves/${toId}/assign`, { orderIds: [orderId] })
      toast.success('已移动')
    } catch (e) { toast.error(e instanceof Error ? e.message : '移动失败'); load() }
  }

  // 确认出发：回填交货日期(=排程日期)，订单转 IN_DELIVERY，波次标记已出发
  async function dispatchWave(waveId: string) {
    const wave = waves.find(w => w.id === waveId)
    if (!wave || wave.orderIds.length === 0) return
    try {
      await apiPut(`/api/waves/${waveId}/dispatch`, { date })
      toast.success('已确认出发')
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : '确认出发失败') }
  }

  async function completeWave(waveId: string) {
    const wave = waves.find(w => w.id === waveId)
    if (!confirm(`确认「${wave?.driverName ?? ''}」已完成配送？卡片将从调度台移除。`)) return
    try {
      await apiPut(`/api/waves/${waveId}/complete`, {})
      toast.success('已标记完成')
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : '标记完成失败') }
  }

  // 分配完成：纯进度标记，可反悔。不改订单状态/交货日期，不触发下游
  async function markAssignmentDone(waveId: string, done: boolean) {
    setWaves(prev => prev.map(w => (w.id === waveId ? { ...w, assignmentDoneAt: done ? new Date().toISOString() : null } : w)))
    try {
      await apiPut(`/api/waves/${waveId}/assignment-done`, { done })
      toast.success(done ? '已标记分配完成' : '已撤销')
    } catch (e) { toast.error(e instanceof Error ? e.message : '操作失败'); load() }
  }

  function startDrag(e: React.DragEvent, orderId: string, sourceWaveId: string | null) {
    e.dataTransfer.setData('text/plain', orderId)
    e.dataTransfer.setData(SRC, sourceWaveId ?? '')
    e.dataTransfer.effectAllowed = 'move'
    setDragging(true)
  }
  function dropToWave(e: React.DragEvent, waveId: string) {
    e.preventDefault()
    setDragOverWave(null)
    setDragging(false)
    const orderId = e.dataTransfer.getData('text/plain')
    const src = e.dataTransfer.getData(SRC)
    if (!orderId || src === waveId) return
    if (waves.find(w => w.id === waveId)?.dispatchedAt) { toast.error('该批次已出发，不能再分配'); return }
    if (waves.find(w => w.id === waveId)?.pickLockedAt) { toast.error('该批次拣货中已锁定，请找打印员解锁'); return }
    if (src && waves.find(w => w.id === src)?.pickLockedAt) { toast.error('原批次拣货中已锁定，请找打印员解锁'); return }
    if (src) {
      moveWave(src, waveId, orderId)
    } else {
      assignToWave(waveId, orderId)
    }
  }
  function dropToLeft(e: React.DragEvent) {
    e.preventDefault()
    setDragOverLeft(false)
    setDragging(false)
    const orderId = e.dataTransfer.getData('text/plain')
    const src = e.dataTransfer.getData(SRC)
    if (!orderId || !src) return
    if (waves.find(w => w.id === src)?.pickLockedAt) { toast.error('该批次拣货中已锁定，请找打印员解锁'); return }
    unassignFromWave(src, orderId)
  }

  function laneMetrics(wave: Wave) {
    const ws = wave.orderIds.map(id => ordersById.get(id)).filter(Boolean) as Order[]
    const lines = ws.flatMap(o => o.lines ?? [])
    const itemCount = lines.reduce((s, l) => s + num(l.orderedQty), 0)
    const weight = Math.round(lines.reduce((s, l) => s + num(l.orderedQty) * num(l.product?.template?.weight ?? 0), 0) * 10) / 10
    const amount = Math.round(ws.reduce((s, o) => s + num(o.totalAmount), 0) * 100) / 100
    return { orderCount: wave.orderIds.length, itemCount, weight, amount }
  }

  function Lane({ slot, collapsed, onToggleCollapse }: { slot: DriverSlot; collapsed: boolean; onToggleCollapse: () => void }) {
    const wave = waveForSlot(slot.id)
    const timeCls = slot.timeOfDay === 'am' ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-800'
    const timeText = slot.timeOfDay === 'am' ? '上午' : '下午'

    if (!wave) return null

    if (wave.completedAt) {
      return (
        <div className="bg-gray-50 border border-dashed rounded-xl p-3 text-xs text-gray-400" style={{ borderColor: '#d1d5db' }}>
          <div className="font-semibold text-gray-600 flex items-center gap-1.5">
            <Avatar name={slot.driverName} /> {slot.driverName}
            <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${timeCls}`}>{timeText}</span>
          </div>
        </div>
      )
    }

    const m = laneMetrics(wave)
    const st = WAVE_STATUS[wave.status] ?? { text: wave.status, cls: 'bg-gray-100 text-gray-500', pct: 0 }
    const laneOrders = wave.orderIds.map(id => ordersById.get(id)).filter(Boolean) as Order[]
    const stage = waveStage(wave)
    // 关灯期(司机端未上线):在途相关 UI 全部隐藏——在途徽章、出发时间、「标记完成」按钮
    // 都挂在 dispatched 分支下,dispatched 恒 false 即一并关掉。后端 dispatch/complete 逻辑不动。
    const dispatched = DRIVER_APP_ENABLED && stage === 'in_transit'
    const assignmentDone = stage === 'assignment_done'
    const locked = !!wave.pickLockedAt
    const over = !dispatched && !locked && dragOverWave === wave.id
    const departTime = wave.dispatchedAt
      ? new Date(wave.dispatchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      : ''

    if (collapsed) {
      return (
        <div
          className={`flex items-center gap-2 ${dispatched ? 'bg-gray-50' : 'bg-white'} border rounded-xl px-3 py-2.5 cursor-pointer hover:border-purple-300`}
          style={{ borderColor: dispatched ? '#bfdbfe' : '#e5e7eb' }}
          onClick={onToggleCollapse}
        >
          <span className="flex-none"><Avatar name={slot.driverName} /></span>
          <span className="font-bold text-[13px] truncate min-w-0" title={slot.driverName}>{slot.driverName}</span>
          <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap flex-none ${timeCls}`}>{timeText}</span>
          <span className="text-xs text-gray-500 whitespace-nowrap flex-none">{m.orderCount}单</span>
          {dispatched
            ? <span className="px-1.5 py-0.5 rounded-full text-[11px] font-semibold bg-blue-100 text-blue-700 ml-auto whitespace-nowrap flex-none">🚚 在途</span>
            : assignmentDone
            ? <span className="px-1.5 py-0.5 rounded-full text-[11px] font-semibold bg-purple-100 text-purple-700 ml-auto whitespace-nowrap flex-none">✅ 分配完成</span>
            : <span className="ml-auto text-gray-400 text-[10px] whitespace-nowrap flex-none">▾ 展开</span>}
          {locked && <span className="px-1.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-700 whitespace-nowrap flex-none">🔒</span>}
        </div>
      )
    }

    // 拖拽进行中且本车不可接收(锁定/已出发)时盖一层遮罩，明确告诉调度员"为什么拖不进去"
    const blockDrop = dragging && (locked || dispatched)

    return (
      <div
        className={`${dispatched ? 'bg-gray-50' : 'bg-white'} border rounded-xl flex flex-col max-h-[600px] relative`}
        style={{ borderColor: over ? PURPLE : (dispatched ? '#bfdbfe' : '#e5e7eb'), boxShadow: over ? `0 0 0 2px ${PURPLE}33` : undefined }}
        onDragOver={e => { e.preventDefault(); if (dispatched || locked) { e.dataTransfer.dropEffect = 'none'; return } e.dataTransfer.dropEffect = 'move'; setDragOverWave(wave.id) }}
        onDragLeave={e => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragOverWave(p => p === wave.id ? null : p) }}
        onDrop={e => dropToWave(e, wave.id)}
      >
        {blockDrop && (
          <div
            className="absolute inset-0 z-10 rounded-xl flex items-center justify-center pointer-events-none"
            style={{ background: 'rgba(107,114,128,0.55)', backdropFilter: 'grayscale(1)' }}
          >
            <span className="px-3 py-1.5 rounded-lg text-xs font-bold text-white shadow" style={{ background: locked ? '#b45309' : '#1d4ed8' }}>
              {locked ? '🔒 已锁定，不能拖入（请到打印中心解锁）' : '🚚 已出发，不能再分配'}
            </span>
          </div>
        )}
        <div className="p-2.5 border-b rounded-t-xl" style={{ borderColor: '#e5e7eb' }}>
          <div className="flex items-center gap-1.5">
            <span className="flex-none"><Avatar name={slot.driverName} /></span>
            <span className="font-bold text-[13px] truncate min-w-0 flex-1" title={slot.driverName}>{slot.driverName}</span>
            <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap flex-none ${timeCls}`}>{timeText}</span>
            {locked && (
              <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap flex-none bg-amber-100 text-amber-700" title={wave.pickLockedBy ? `打印员：${wave.pickLockedBy}` : undefined}>
                🔒 拣货中
              </span>
            )}
            {dispatched
              ? <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap flex-none bg-blue-100 text-blue-700">🚚 在途</span>
              : assignmentDone
              ? <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap flex-none bg-purple-100 text-purple-700">✅ 分配完成</span>
              : <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap flex-none ${st.cls}`}>{st.text}</span>}
            <button
              onClick={e => { e.stopPropagation(); onToggleCollapse() }}
              className="px-1.5 py-0.5 rounded text-[10px] text-gray-400 hover:text-gray-600 hover:bg-gray-100 flex-none"
              title="收起"
            >▴</button>
          </div>
          <div className="text-[11px] text-gray-500 mt-1">批次{slot.batchNum} · {m.orderCount}单 · {m.itemCount}件 · {m.weight}kg · €{m.amount.toLocaleString()}</div>
          {dispatched && <div className="text-[10px] text-blue-400 mt-0.5">已于 {departTime} 出发</div>}
          <div className="h-1.5 rounded bg-gray-200 mt-2 overflow-hidden"><div className="h-full" style={{ width: `${st.pct}%`, background: PURPLE }} /></div>
        </div>

        <div className="p-2 overflow-y-auto flex flex-col gap-1.5">
          {/* 已分配订单 */}
          {laneOrders.length === 0 && (
            <div className="text-center text-[11px] text-gray-400 py-5 border border-dashed rounded-lg" style={{ borderColor: '#e5e7eb' }}>
              拖订单到此
            </div>
          )}
          {laneOrders.map(o => (
            <div
              key={o.id}
              draggable={!dispatched && !locked}
              onDragStart={e => { if (dispatched || locked) { e.preventDefault(); return } startDrag(e, o.id, wave.id) }}
              onDragEnd={() => setDragging(false)}
              onClick={() => openOrder(o.id)}
              className={`border rounded-lg px-2 py-1.5 bg-white text-xs hover:border-purple-300 ${dispatched || locked ? 'cursor-pointer' : 'cursor-grab'}`}
              style={{ borderColor: '#eee' }}
              title={dispatched ? '点击查看订单详情（已出发，不可调整）' : locked ? '点击查看订单详情（拣货中已锁定，请找打印员解锁）' : '点击查看订单详情；拖回左侧=移出，拖到别的司机=换车'}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium flex items-center gap-1.5 truncate">
                  <i className="w-2 h-2 rounded-full inline-block flex-none" style={{ background: restaurantColor(o.restaurantName) }} />
                  <span className="truncate">{o.restaurantName}</span>
                </span>
                <span className="text-gray-500 flex-none ml-1">€{num(o.totalAmount).toLocaleString()}</span>
              </div>
            </div>
          ))}

          {dispatched ? (
            <button
              onClick={() => completeWave(wave.id)}
              className="mt-1 rounded-lg py-1.5 text-xs font-semibold text-gray-600 bg-white border border-gray-300 hover:bg-gray-100 w-full"
            >✓ 标记完成</button>
          ) : assignmentDone ? (
            <div className="mt-1 flex flex-col gap-1.5">
              {DRIVER_APP_ENABLED && (
                <button
                  onClick={() => dispatchWave(wave.id)}
                  className="rounded-lg py-1.5 text-xs font-semibold text-white hover:opacity-90"
                  style={{ background: '#16a34a' }}
                >🚚 确认出发（{laneOrders.length}单）</button>
              )}
              <button
                onClick={() => markAssignmentDone(wave.id, false)}
                disabled={locked}
                title={locked ? '拣货中已锁定，请找打印员解锁' : undefined}
                className="rounded-lg py-1 text-[11px] font-medium text-gray-500 bg-white border border-gray-300 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >↩︎ 撤销分配完成</button>
            </div>
          ) : laneOrders.length > 0 ? (
            // 分配中：只给「分配完成」。确认出发藏到分配完成之后才出现，避免拖拽审核时误发不可逆的车
            <button
              onClick={() => markAssignmentDone(wave.id, true)}
              className="mt-1 rounded-lg py-1.5 text-xs font-semibold text-white hover:opacity-90 w-full"
              style={{ background: '#875A7B' }}
            >✅ 分配完成</button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-5 bg-white border rounded-lg px-5 py-3 mb-3.5 flex-wrap" style={{ borderColor: '#e5e7eb' }}>
        <div className="flex items-center gap-4">
          <span className="text-[10px] font-bold text-gray-400 tracking-wide">订单<br />（单）</span>
          <Board n={unassigned.length} l="待分配" color="#d97706" hint="点击：滚到左侧「待分配」竖条查看这些订单" onClick={focusUnassigned} />
          <Board n={inBatchCount} l="已入批" color="#16a34a" hint="点击：选中有订单的司机，右侧展开这些车次" onClick={showInBatchDrivers} />
        </div>
        <div className="w-px self-stretch bg-gray-200" />
        <div className="flex items-center gap-4">
          <span className="text-[10px] font-bold text-gray-400 tracking-wide">批次<br />（车）</span>
          <Board n={assignmentDoneCount} l="已排完" color="#875A7B" hint="点击：只选中「分配完成」的车次司机" onClick={showAssignmentDoneDrivers} />
          <Board n={waves.length} l="司机批次" hint="点击：选中全部司机，右侧展开当天全部车次" onClick={showAllDriverWaves} />
        </div>
        <div className="flex-1" />
        <button onClick={load} className="px-3 py-1.5 rounded-lg text-sm font-medium text-white" style={{ background: PURPLE }}>刷新</button>
      </div>

      {/* 其他日期提示条：别的交货日还有已排订单时列出,点一下跳过去(销售单排司机后单落在其 deliveryDate 那天) */}
      {otherDates.length > 0 && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 mb-3.5 flex-wrap text-sm">
          <span className="font-medium text-amber-800">📅 其他日期还有已排订单：</span>
          {otherDates.map(o => (
            <button
              key={o.date}
              onClick={() => onPickDate?.(o.date)}
              className="px-2.5 py-1 rounded-full text-xs font-semibold bg-white border border-amber-300 text-amber-800 hover:bg-amber-100"
              title="点击切换到该日期查看批次"
            >
              {o.date}（{o.orders}单）
            </button>
          ))}
          <span className="text-[11px] text-amber-600 ml-1">销售单排的司机，单会落在它的交货日；点日期即可跳转</span>
        </div>
      )}

      {/* ② 司机多选 chip 条：选几个司机右侧就显示几个 */}
      {!loading && driverNames.length > 0 && (
        <div className="flex items-center gap-2 bg-white border rounded-lg px-4 py-3 mb-3.5 flex-wrap" style={{ borderColor: '#e5e7eb' }}>
          <span className="text-sm font-medium text-gray-600 mr-1">司机</span>
          <DriverChip label="全部司机" active={allSelected} onClick={toggleAll} />
          {driverNames.map(name => {
            const cnt = orderCountByDriver.get(name) ?? 0
            return (
              <DriverChip key={name} label={name} count={cnt} active={selectedDrivers.has(name)} onClick={() => toggleDriver(name)} />
            )
          })}
          <div className="flex-1" />
          {selectedDrivers.size > 0 && (
            <button
              onClick={() => setSelectedDrivers(new Set())}
              className="px-3 py-1.5 rounded-lg text-sm font-semibold text-white hover:opacity-90"
              style={{ background: '#16a34a' }}
              title="收工清场：清空选中的司机,画面变整洁(已拖拽的分配已保存)"
            >✅ 完成（清空选中）</button>
          )}
        </div>
      )}

      {loading && <div className="text-center text-gray-400 py-10">加载中…</div>}

      {!loading && (
        <div className="flex gap-3.5 items-start">
          {/* 待分配竖条（可接收拖回） */}
          <div
            ref={leftPanelRef}
            className="flex-none w-[220px] bg-gray-50 border border-dashed rounded-xl sticky top-2.5 max-h-[640px] flex flex-col transition-shadow"
            style={{ borderColor: (dragOverLeft || flashLeft) ? PURPLE : '#cbd5e1', boxShadow: (dragOverLeft || flashLeft) ? `0 0 0 2px ${PURPLE}33` : undefined }}
            onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverLeft(true) }}
            onDragLeave={e => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragOverLeft(false) }}
            onDrop={dropToLeft}
          >
            <div className="p-2.5 border-b" style={{ borderColor: '#e5e7eb' }}>
              <div className="flex items-center justify-between">
                <span className="font-bold text-sm">📥 待分配</span>
                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-500">{unassigned.length} 单</span>
              </div>
              <div className="text-[11px] text-gray-400 mt-1">拖到右侧司机批次；从批次拖回此处可移出</div>
            </div>
            <div className="p-2.5 overflow-y-auto flex flex-col gap-2">
              {unassigned.length === 0 && <div className="text-center text-xs text-gray-400 py-6">已全部入批 🎉</div>}
              {unassigned.map(o => (
                <div
                  key={o.id}
                  draggable
                  onDragStart={e => startDrag(e, o.id, null)}
                  onDragEnd={() => setDragging(false)}
                  onClick={() => openOrder(o.id)}
                  className="border rounded-lg p-2 bg-white cursor-grab text-xs hover:border-amber-400"
                  style={{ borderColor: '#e5e7eb' }}
                  title="点击查看订单详情；拖到右侧司机批次可分配"
                >
                  <div className="font-semibold text-amber-700">{o.code ?? o.id.slice(0, 8)}</div>
                  <div className="text-gray-500 mt-0.5">{o.restaurantName} · {o.items?.length ?? 0}项 · €{num(o.totalAmount).toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>

          <div ref={rightPanelRef} className="flex-1 min-w-0 scroll-mt-3">
            {selectedDrivers.size === 0 ? (
              <div className="flex items-center justify-center text-gray-400 text-sm min-h-[200px] border border-dashed rounded-xl" style={{ borderColor: '#e5e7eb' }}>
                ← 请从上方选择司机
              </div>
            ) : (
              <>
                <GroupTitle time="am" count={selAmSlots.length} collapsed={amCollapsed} onToggle={() => setAmCollapsed(v => !v)} />
                {!amCollapsed && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 pb-2.5">
                    {selAmSlots.map(s => (
                      <Lane
                        key={s.id}
                        slot={s}
                        collapsed={collapsedLanes.has(s.id)}
                        onToggleCollapse={() => setCollapsedLanes(prev => { const n = new Set(prev); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n })}
                      />
                    ))}
                    {selAmSlots.length === 0 && <Empty text="选中司机无上午班" />}
                  </div>
                )}
                <GroupTitle time="pm" count={selPmSlots.length} collapsed={pmCollapsed} onToggle={() => setPmCollapsed(v => !v)} />
                {!pmCollapsed && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 pb-2.5">
                    {selPmSlots.map(s => (
                      <Lane
                        key={s.id}
                        slot={s}
                        collapsed={collapsedLanes.has(s.id)}
                        onToggleCollapse={() => setCollapsedLanes(prev => { const n = new Set(prev); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n })}
                      />
                    ))}
                    {selPmSlots.length === 0 && <Empty text="选中司机无下午班" />}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

    </div>
  )
}

function Avatar({ name }: { name: string }) {
  return <span className="w-6 h-6 rounded-full text-white inline-flex items-center justify-center text-[11px] font-bold" style={{ background: PURPLE }}>{name?.[0] ?? '?'}</span>
}
function Board({ n, l, color, hint, onClick }: { n: number; l: string; color?: string; hint?: string; onClick?: () => void }) {
  return (
    <div
      title={hint}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
      className={onClick ? 'cursor-pointer select-none rounded-lg -mx-1.5 px-1.5 py-0.5 hover:bg-gray-50 transition-colors' : hint ? 'cursor-help' : undefined}
    >
      <div className="text-[22px] font-bold leading-none" style={{ color: color ?? '#1f2937' }}>{n}</div>
      <div className="text-[11px] text-gray-500 mt-1 flex items-center gap-0.5">{l}{onClick && <span className="text-[9px] text-gray-300">›</span>}</div>
    </div>
  )
}
function GroupTitle({ time, count, collapsed, onToggle }: { time: 'am' | 'pm'; count: number; collapsed: boolean; onToggle: () => void }) {
  const am = time === 'am'
  return (
    <div className="flex items-center gap-3 mt-3.5 mb-2">
      <button onClick={onToggle} className="flex items-center gap-2 font-bold text-sm hover:opacity-80" style={{ color: am ? '#1f2937' : '#92400e' }}>
        <span className="text-gray-400 text-xs w-3 inline-block">{collapsed ? '▸' : '▾'}</span>
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${am ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-800'}`}>{am ? '上午' : '下午'}</span>
        {am ? '上午班' : '下午班'} <span className="text-xs text-gray-400 font-normal">· {count} 个批次</span>
      </button>
    </div>
  )
}
function DriverChip({ label, count, active, onClick }: { label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-sm font-medium border transition-colors flex items-center gap-1.5 ${active ? 'text-white' : 'text-gray-600 bg-white hover:bg-gray-50'}`}
      style={{ background: active ? PURPLE : undefined, borderColor: active ? PURPLE : '#e5e7eb' }}
    >
      {label}
      {count != null && count > 0 && (
        <span className={`px-1.5 rounded-full text-[11px] font-semibold ${active ? 'bg-white/25 text-white' : 'bg-amber-100 text-amber-700'}`}>{count}</span>
      )}
    </button>
  )
}
function Empty({ text }: { text: string }) {
  return <div className="flex-none w-[236px] flex items-center justify-center text-gray-400 text-sm min-h-[120px] border border-dashed rounded-xl" style={{ borderColor: '#e5e7eb' }}>{text}</div>
}
