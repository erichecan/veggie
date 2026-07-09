'use client'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useLocale } from 'next-intl'
import { toast } from 'sonner'
import { routing } from '@/i18n/routing'
import { apiGet, apiPost } from '@/lib/api'
import type { Order, OrderLine } from '@/lib/types'
import { formatDriverSlot, parseDriverSlotKey, type DriverSlotInfo } from '@/lib/driver-slot'
import type { PickingVariant } from '@/lib/print/trip-picking-template'
import { ChipMultiSelect, today, fmtMoney, lineUntax } from './shared'

type BatchLine = OrderLine & { product?: { template?: { weight?: number | null } | null } | null }

function lineWeight(l: BatchLine): number {
  const w = Number(l.product?.template?.weight ?? 0)
  return w * Number(l.orderedQty)
}

interface Wave {
  id: string
  orderIds: string[]
  driverSlotId: string | null
  driverName: string | null
  assignmentDoneAt: string | null
  dispatchedAt: string | null
  completedAt: string | null
  pickLockedAt: string | null
  pickLockedBy: string | null
}

interface BatchGroup {
  batchKey: string
  waveId: string
  pickLockedAt: string | null
  pickLockedBy: string | null
  orders: Order[]
  totalAmount: number
  untaxTotal: number
  totalWeight: number
}

interface ActionLogRow {
  id: string
  userName: string | null
  userEmail: string | null
  detail: string | null
  action: string
  createdAt: string
}

// SSOT: 打印一律以批次字符串(wave 归属)为准，不用 Order.driverSlotId(下单意向,
// 拖拽调度不回填,会串到别的司机)。后端按 batchLabel 反查 wave,与卡片显示一致。
function buildPrintUrl(
  prefix: string,
  type: 'picking' | 'delivery' | 'summary',
  date: string,
  batchKey?: string,
  variant?: PickingVariant,
  waveIds?: string[],
): string {
  const params = new URLSearchParams({ date, fromDate: date })
  if (batchKey) params.set('batchLabel', batchKey)
  if (waveIds && waveIds.length > 0) params.set('waveIds', waveIds.join(','))
  if (variant && variant !== 'all') params.set('variant', variant)
  return `${prefix}/classic/print/dispatch/${type}?${params.toString()}`
}

// ─── BatchCard ────────────────────────────────────────────────────────────────

function BatchCard({
  group,
  prefix,
  date,
  isPrinted,
  canUnlock,
  onPrint,
  onLockChange,
}: {
  group: BatchGroup
  prefix: string
  date: string
  isPrinted: boolean
  canUnlock: boolean
  onPrint: () => void
  onLockChange: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const { batchKey, waveId, pickLockedAt, pickLockedBy, orders, totalAmount, untaxTotal } = group
  const parsed = parseDriverSlotKey(batchKey)
  const uniqueCustomers = new Set(orders.map(o => o.restaurantId)).size

  async function print(type: 'delivery' | 'summary') {
    window.open(buildPrintUrl(prefix, type, date, batchKey), '_blank')
    onPrint()
    // 记录打印动作到操作记录（失败不影响打印）
    try {
      await apiPost('/api/waves/print-log', { date, type, scope: 'batch', batchLabel: batchKey, waveId })
      onLockChange()
    } catch { /* 日志失败静默 */ }
  }

  // Feature C：打印拣货单即触发批次锁定（重打=重新上锁）；锁定失败则不打印，避免"打印了但没锁"
  // 拣货单分实物(storable)/耗材(consumable)两份，供两个拣货员分开作业
  async function printPicking(variant: 'storable' | 'consumable') {
    setBusy(true)
    try {
      await apiPost(`/api/waves/${waveId}/pick-lock`, { reason: 'print', variant })
      window.open(buildPrintUrl(prefix, 'picking', date, batchKey, variant), '_blank')
      onPrint()
      onLockChange()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '锁定批次失败，未打印')
    } finally {
      setBusy(false)
    }
  }

  // 显式手动上锁(不打印):人人可锁,配合下方「解锁」形成锁定/解锁切换。打印拣货单仍会自动上锁。
  async function lock() {
    setBusy(true)
    try {
      await apiPost(`/api/waves/${waveId}/pick-lock`, { reason: 'manual' })
      toast.success('已锁定')
      onLockChange()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '锁定失败')
    } finally {
      setBusy(false)
    }
  }

  async function unlock() {
    setBusy(true)
    try {
      await apiPost(`/api/waves/${waveId}/pick-unlock`, {})
      toast.success('已解锁')
      onLockChange()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '解锁失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`bg-white rounded-lg border overflow-hidden ${isPrinted ? 'border-green-300' : 'border-gray-200'}`}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={() => setExpanded(e => !e)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          <span className="text-gray-400 text-sm">{expanded ? '▾' : '▸'}</span>
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {parsed.num > 0 && (
              <span className="bg-[#875A7B] text-white text-xs font-bold rounded px-2 py-0.5">
                批次 {parsed.num}
              </span>
            )}
            {parsed.time && (
              <span className="bg-blue-100 text-blue-700 text-xs font-medium rounded px-2 py-0.5 uppercase">
                {parsed.time}
              </span>
            )}
            {parsed.driver && (
              <span className="font-medium text-gray-900 text-sm">{parsed.driver}</span>
            )}
            {!batchKey && (
              <span className="text-gray-400 text-sm italic">未分配</span>
            )}
            <span className="text-xs text-gray-400">
              {orders.length} 单 · {uniqueCustomers} 客户
            </span>
            {isPrinted && (
              <span className="text-xs text-green-600 font-medium bg-green-50 rounded px-1.5 py-0.5">
                ✓ 已打印
              </span>
            )}
            {pickLockedAt && (
              <span className="text-xs text-amber-700 font-medium bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                🔒 拣货中{pickLockedBy ? ` · ${pickLockedBy}` : ''}
              </span>
            )}
          </div>
        </button>

        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-sm font-semibold text-gray-900 mr-2">${fmtMoney(totalAmount)}</span>
          <span className="text-xs text-gray-400 mr-3">未税 ${fmtMoney(untaxTotal)}</span>
          {!pickLockedAt && (
            <button
              onClick={lock}
              disabled={busy}
              className="px-2.5 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-40"
              title="锁定该批次，防止调度台再改动（打印拣货单也会自动上锁）"
            >
              🔓 锁定
            </button>
          )}
          {pickLockedAt && canUnlock && (
            <button
              onClick={unlock}
              disabled={busy}
              className="px-2.5 py-1 text-xs rounded border border-amber-400 text-amber-700 hover:bg-amber-50 transition-colors disabled:opacity-40"
              title="解锁该批次（仅 BOSS / WAREHOUSE 可操作）"
            >
              🔒 解锁
            </button>
          )}
          <span className="inline-flex rounded border border-orange-400 overflow-hidden">
            <button
              onClick={() => printPicking('storable')}
              disabled={busy}
              title="整箱整袋拣货单"
              className="px-2.5 py-1 text-xs text-orange-600 hover:bg-orange-50 transition-colors disabled:opacity-40"
            >
              📦 整箱整袋
            </button>
            <button
              onClick={() => printPicking('consumable')}
              disabled={busy}
              title="零散货拣货单"
              className="px-2.5 py-1 text-xs text-orange-600 border-l border-orange-400 hover:bg-orange-50 transition-colors disabled:opacity-40"
            >
              🧴 零散货
            </button>
          </span>
          <button
            onClick={() => print('delivery')}
            title="打印该批次送货单 Delivery Note"
            className="px-2.5 py-1 text-xs rounded border border-blue-400 text-blue-600 hover:bg-blue-50 transition-colors"
          >
            🚚 送货单
          </button>
          <button
            onClick={() => print('summary')}
            title="打印该批次送货汇总单 Delivery Summary"
            className="px-2.5 py-1 text-xs rounded border border-green-500 text-green-700 hover:bg-green-50 transition-colors"
          >
            📋 汇总单
          </button>
        </div>
      </div>

      {/* Order list */}
      {expanded && (
        <div className="border-t border-gray-100">
          {orders.map(o => (
            <div key={o.id} className="flex items-center gap-3 px-5 py-2 hover:bg-gray-50 border-b border-gray-50">
              <span className="text-xs font-mono text-gray-500 w-36">{o.code ?? o.id.slice(-6)}</span>
              <span className="flex-1 text-sm text-gray-800">{o.restaurantName}</span>
              <span className="text-xs text-gray-500 uppercase">{o.status}</span>
              <span className="text-sm font-medium text-gray-900 w-24 text-right">
                ${fmtMoney(Number(o.totalAmount))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── BatchSections ────────────────────────────────────────────────────────────

function BatchSections({
  batchGroups,
  prefix,
  date,
  printedKeys,
  canUnlock,
  onPrint,
  onLockChange,
}: {
  batchGroups: BatchGroup[]
  prefix: string
  date: string
  printedKeys: Set<string>
  canUnlock: boolean
  onPrint: (batchKey: string) => void
  onLockChange: () => void
}) {
  const amGroups = batchGroups.filter(g => parseDriverSlotKey(g.batchKey).time === 'am')
  const pmGroups = batchGroups.filter(g => parseDriverSlotKey(g.batchKey).time === 'pm')
  const otherGroups = batchGroups.filter(g => {
    const t = parseDriverSlotKey(g.batchKey).time
    return t !== 'am' && t !== 'pm'
  })

  function renderGroup(g: BatchGroup) {
    return (
      <BatchCard
        key={g.waveId}
        group={g}
        prefix={prefix}
        date={date}
        isPrinted={printedKeys.has(g.batchKey)}
        canUnlock={canUnlock}
        onPrint={() => onPrint(g.batchKey)}
        onLockChange={onLockChange}
      />
    )
  }

  return (
    <div className="space-y-4">
      {amGroups.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-blue-600 uppercase tracking-wider">AM 上午</span>
            <span className="text-xs text-gray-400">{amGroups.length} 批次</span>
            <div className="flex-1 h-px bg-blue-100" />
          </div>
          {amGroups.map(renderGroup)}
        </div>
      )}
      {pmGroups.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-orange-500 uppercase tracking-wider">PM 下午</span>
            <span className="text-xs text-gray-400">{pmGroups.length} 批次</span>
            <div className="flex-1 h-px bg-orange-100" />
          </div>
          {pmGroups.map(renderGroup)}
        </div>
      )}
      {otherGroups.length > 0 && (
        <div className="space-y-2">
          {(amGroups.length > 0 || pmGroups.length > 0) && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">其他</span>
              <span className="text-xs text-gray-400">{otherGroups.length} 批次</span>
              <div className="flex-1 h-px bg-gray-100" />
            </div>
          )}
          {otherGroups.map(renderGroup)}
        </div>
      )}
    </div>
  )
}

// ─── PrintCenter ──────────────────────────────────────────────────────────────

const STORAGE_PREFIX = 'veggie-printed-batches-'

function loadPrintedKeys(date: string): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + date)
    const arr = raw ? (JSON.parse(raw) as string[]) : []
    return new Set(arr)
  } catch {
    return new Set()
  }
}

function savePrintedKeys(date: string, keys: Set<string>) {
  try {
    localStorage.setItem(STORAGE_PREFIX + date, JSON.stringify([...keys]))
  } catch {
    // localStorage unavailable
  }
}

export default function PrintCenter({ refreshKey = 0 }: { refreshKey?: number }) {
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  // 解锁权限的唯一开关：当前先全部放开（能进打印中心的人都可解锁）。
  // 日后要收口到某个具体用户，把这里换成 useAbility() 判断即可（如 ability.userId === 'xxx'）。
  const canUnlock = true

  const [date, setDate] = useState(today)
  const [slots, setSlots] = useState<DriverSlotInfo[]>([])
  const [waves, setWaves] = useState<Wave[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [sortMode, setSortMode] = useState<'batch' | 'driver' | 'time'>('batch')
  const [driverFilter, setDriverFilter] = useState<string[]>([])
  const [timeFilter, setTimeFilter] = useState<string[]>([])
  const [batchFilter, setBatchFilter] = useState<string[]>([])
  const [printedKeys, setPrintedKeys] = useState<Set<string>>(new Set())
  const [logs, setLogs] = useState<ActionLogRow[]>([])

  useEffect(() => {
    setPrintedKeys(loadPrintedKeys(date))
  }, [date])

  const markPrinted = useCallback((batchKey: string) => {
    setPrintedKeys(prev => {
      const next = new Set(prev)
      next.add(batchKey)
      savePrintedKeys(date, next)
      return next
    })
  }, [date])

  const clearPrinted = useCallback(() => {
    setPrintedKeys(new Set())
    savePrintedKeys(date, new Set())
  }, [date])

  useEffect(() => {
    apiGet<DriverSlotInfo[]>('/api/driver-slots')
      .then(data => setSlots(Array.isArray(data) ? data : []))
      .catch(() => setSlots([]))
  }, [])

  // Feature B：打印中心按批次阶段取数（仅 assignmentDoneAt 已回填、且未 completed 的 wave），
  // 分配完成即可见，不必等「确认出发」回填 deliveryDate。
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const waveData = await apiGet<Wave[]>(`/api/waves?date=${date}`)
      const visible = waveData.filter(w => w.assignmentDoneAt != null && !w.completedAt)
      const orderIds = Array.from(new Set(visible.flatMap(w => w.orderIds)))
      const ordersData = orderIds.length > 0
        ? await apiGet<Order[]>(`/api/orders?include_lines=true&ids=${orderIds.join(',')}`)
        : []
      setWaves(visible)
      setOrders(Array.isArray(ordersData) ? ordersData : [])
    } catch {
      setWaves([])
      setOrders([])
    } finally {
      setLoading(false)
    }
  }, [date])

  // 操作记录：锁定/解锁/打印都写在 resource=picking-wave，detail 里带配送日期，
  // 按当前选中的配送日期过滤，只显示屏幕上这批批次的操作。
  const loadLogs = useCallback(async () => {
    try {
      const res = await apiGet<{ logs: ActionLogRow[] } | ActionLogRow[]>('/api/action-logs?resource=picking-wave&take=100')
      const arr: ActionLogRow[] = Array.isArray(res) ? res : (res.logs ?? [])
      setLogs(arr.filter(l => l.detail?.includes(date)))
    } catch {
      setLogs([])
    }
  }, [date])

  const refresh = useCallback(() => { load(); loadLogs() }, [load, loadLogs])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadLogs() }, [loadLogs])

  // 页头「刷新」：跳过首次挂载，之后每次 refreshKey 变化重拉当前日期的批次+日志
  useEffect(() => {
    if (refreshKey === 0) return
    refresh()
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const slotMap = useMemo(() => new Map(slots.map(s => [s.id, s])), [slots])
  const ordersById = useMemo(() => new Map(orders.map(o => [o.id, o])), [orders])

  // 每张卡片 = 一个 wave，与调度台一一对应；batchKey 仅用于沿用既有排序/筛选/打印 URL 格式
  const waveGroups = useMemo(() => {
    return waves
      .map(w => {
        const slot = w.driverSlotId ? slotMap.get(w.driverSlotId) : undefined
        const batchKey = slot
          ? formatDriverSlot(slot)
          : (w.driverName ? formatDriverSlot({ id: '', batchNum: 0, timeOfDay: '', driverName: w.driverName }) : '')
        const ords = w.orderIds.map(id => ordersById.get(id)).filter((o): o is Order => !!o)
        return { wave: w, batchKey, orders: ords }
      })
      .filter(g => g.orders.length > 0)
  }, [waves, slotMap, ordersById])

  const filterOptions = useMemo(() => {
    const drivers = new Set<string>()
    const times = new Set<string>()
    const batches = new Set<string>()
    for (const g of waveGroups) {
      const p = parseDriverSlotKey(g.batchKey)
      if (p.driver) drivers.add(p.driver)
      if (p.time) times.add(p.time)
      if (p.num > 0) batches.add(String(p.num))
    }
    return {
      drivers: [...drivers].sort(),
      times: [...times].sort(),
      batches: [...batches].sort((a, b) => Number(a) - Number(b)),
    }
  }, [waveGroups])

  const filteredWaveGroups = useMemo(() => {
    return waveGroups.filter(g => {
      const p = parseDriverSlotKey(g.batchKey)
      if (driverFilter.length > 0 && !driverFilter.includes(p.driver)) return false
      if (timeFilter.length > 0 && !timeFilter.includes(p.time)) return false
      if (batchFilter.length > 0 && !batchFilter.includes(String(p.num))) return false
      return true
    })
  }, [waveGroups, driverFilter, timeFilter, batchFilter])

  const batchGroups: BatchGroup[] = useMemo(() => {
    const groups = filteredWaveGroups.map(({ wave, batchKey, orders: ords }) => ({
      batchKey,
      waveId: wave.id,
      pickLockedAt: wave.pickLockedAt,
      pickLockedBy: wave.pickLockedBy,
      orders: ords,
      totalAmount: ords.reduce((s, o) => s + Number(o.totalAmount), 0),
      untaxTotal: ords.reduce((s, o) => s + (o.lines ?? []).reduce((ls, l) => ls + lineUntax(l), 0), 0),
      totalWeight: ords.reduce((s, o) => s + (o.lines ?? []).reduce((ls, l) => ls + lineWeight(l as BatchLine), 0), 0),
    }))

    return groups.sort((a, b) => {
      const pa = parseDriverSlotKey(a.batchKey)
      const pb = parseDriverSlotKey(b.batchKey)
      if (sortMode === 'batch') return pa.num - pb.num || pa.time.localeCompare(pb.time) || pa.driver.localeCompare(pb.driver)
      if (sortMode === 'time') return pa.time.localeCompare(pb.time) || pa.num - pb.num || pa.driver.localeCompare(pb.driver)
      return pa.driver.localeCompare(pb.driver) || pa.num - pb.num
    })
  }, [filteredWaveGroups, sortMode])

  // 顶部「全部打印」跟随筛选：无筛选=整日全部；有筛选=只打屏幕上可见的这批批次（传 waveIds）
  const isFiltered = driverFilter.length > 0 || timeFilter.length > 0 || batchFilter.length > 0
  const filteredWaveIds = isFiltered ? batchGroups.map(g => g.waveId) : undefined

  async function bulkPrint(type: 'delivery') {
    window.open(buildPrintUrl(prefix, type, date, undefined, undefined, filteredWaveIds), '_blank')
    try {
      await apiPost('/api/waves/print-log', { date, type, scope: isFiltered ? 'filtered' : 'bulk', count: batchGroups.length })
      loadLogs()
    } catch { /* 日志失败静默 */ }
  }

  // Feature C：「打印拣货单」= 对当前可见批次批量上锁，锁定失败的批次不阻断其余批次打印
  // 分实物/耗材两份，供两个拣货员分开作业；打印范围与锁定范围一致（跟随筛选）
  async function bulkPrintPicking(variant: 'storable' | 'consumable') {
    const results = await Promise.allSettled(
      batchGroups.map(g => apiPost(`/api/waves/${g.waveId}/pick-lock`, { reason: 'print', variant }))
    )
    const failed = results.filter(r => r.status === 'rejected').length
    window.open(buildPrintUrl(prefix, 'picking', date, undefined, variant, filteredWaveIds), '_blank')
    for (const g of batchGroups) markPrinted(g.batchKey)
    if (failed > 0) toast.error(`${failed} 个批次锁定失败`)
    refresh()
  }

  const grandTotal = batchGroups.reduce((s, g) => s + g.totalAmount, 0)

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">配送日期</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-[#875A7B]"
            />
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500 ml-2">
            {loading ? (
              <span>加载中...</span>
            ) : (
              <>
                <span>共 {orders.length} 单 · {batchGroups.length} 批次 · ${fmtMoney(grandTotal)}</span>
                {printedKeys.size > 0 && (
                  <button
                    onClick={clearPrinted}
                    className="ml-2 text-xs text-gray-400 hover:text-gray-600 underline"
                  >
                    清除已打印记录（{printedKeys.size}）
                  </button>
                )}
              </>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {isFiltered && (
              <span className="text-xs text-[#875A7B] font-medium" title="顶部打印按钮已切换为「仅打印当前筛选结果」">
                已筛选 · 打印 {batchGroups.length} 批次
              </span>
            )}
            <span className="inline-flex rounded overflow-hidden">
              <button
                onClick={() => bulkPrintPicking('storable')}
                disabled={batchGroups.length === 0}
                title={isFiltered ? '当前筛选批次 · 整箱整袋拣货单' : '全部批次 · 整箱整袋拣货单'}
                className="px-3 py-1.5 text-xs bg-orange-500 text-white hover:bg-orange-600 transition-colors disabled:opacity-40 disabled:hover:bg-orange-500"
              >
                {isFiltered ? '筛选拣货单' : '全部拣货单'} 📦 整箱整袋
              </button>
              <button
                onClick={() => bulkPrintPicking('consumable')}
                disabled={batchGroups.length === 0}
                title={isFiltered ? '当前筛选批次 · 零散货拣货单' : '全部批次 · 零散货拣货单'}
                className="px-3 py-1.5 text-xs bg-orange-500 text-white border-l border-orange-300 hover:bg-orange-600 transition-colors disabled:opacity-40 disabled:hover:bg-orange-500"
              >
                🧴 零散货
              </button>
            </span>
            <button
              onClick={() => bulkPrint('delivery')}
              disabled={batchGroups.length === 0}
              title={isFiltered ? '仅打印当前筛选批次的送货单' : '打印全部批次的送货单'}
              className="px-3 py-1.5 text-xs rounded bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-40 disabled:hover:bg-blue-500"
            >
              {isFiltered ? '打印筛选送货单' : '全部打印送货单'}
            </button>
          </div>
        </div>

        {/* Sort + Filters */}
        <div className="flex items-center gap-4 flex-wrap border-t border-gray-100 pt-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-400">排序:</span>
            {(['batch', 'driver', 'time'] as const).map(m => (
              <button
                key={m}
                onClick={() => setSortMode(m)}
                className={`px-2 py-0.5 rounded text-xs border ${
                  sortMode === m ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'border-gray-300 text-gray-500 hover:border-[#875A7B]'
                }`}
              >
                {m === 'batch' ? '批次' : m === 'driver' ? '司机' : '时段'}
              </button>
            ))}
          </div>
          <ChipMultiSelect
            label="司机"
            options={filterOptions.drivers}
            selected={driverFilter}
            onChange={setDriverFilter}
          />
          <ChipMultiSelect
            label="时段"
            options={filterOptions.times}
            selected={timeFilter}
            onChange={setTimeFilter}
          />
          <ChipMultiSelect
            label="批次"
            options={filterOptions.batches}
            selected={batchFilter}
            onChange={setBatchFilter}
          />
        </div>
      </div>

      {/* Batch cards */}
      {loading ? (
        <div className="text-center text-gray-400 py-16 text-sm">加载中...</div>
      ) : batchGroups.length === 0 ? (
        <div className="text-center text-gray-400 py-16 text-sm">
          {date} 没有已分配完成的批次
        </div>
      ) : (
        <BatchSections
          batchGroups={batchGroups}
          prefix={prefix}
          date={date}
          printedKeys={printedKeys}
          canUnlock={canUnlock}
          onPrint={markPrinted}
          onLockChange={refresh}
        />
      )}

      {/* 操作记录（当前配送日期）：锁定 / 解锁 / 打印 */}
      <OperationLog logs={logs} />
    </div>
  )
}

// ─── OperationLog ─────────────────────────────────────────────────────────────

function OperationLog({ logs }: { logs: ActionLogRow[] }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
        <span className="text-sm font-medium text-gray-900">操作记录（当前配送日期）</span>
        <span className="text-xs text-gray-400">共 {logs.length} 条 · 锁定 / 解锁 / 打印</span>
      </div>
      {logs.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-gray-400">该配送日期暂无操作记录</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                <th className="px-4 py-2 font-medium w-44">时间</th>
                <th className="px-3 py-2 font-medium w-32">操作人</th>
                <th className="px-3 py-2 font-medium">操作内容</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} className="border-b border-gray-50 last:border-0">
                  <td className="px-4 py-2 text-gray-500 whitespace-nowrap">
                    {new Date(log.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
                    })}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{log.userName ?? log.userEmail ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-700">{log.detail ?? log.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
