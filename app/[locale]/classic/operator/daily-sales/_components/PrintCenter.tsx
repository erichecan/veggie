'use client'
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import type { Order, OrderLine } from '@/lib/types'
import { fetchDispatchPrintHtml } from '@/lib/print/dispatch-print-html'
import { formatDateTime } from '@/lib/format-date'
import { ChipMultiSelect, today, fmtMoney, lineUntax } from './shared'

type BatchLine = OrderLine & { product?: { template?: { weight?: number | null } | null } | null }

function lineWeight(l: BatchLine): number {
  const w = Number(l.product?.template?.weight ?? 0)
  return w * Number(l.orderedQty)
}

interface WavePallet {
  id: string
  seq: number
  label: string | null
  items: Array<{ orderId: string }>
}

interface Wave {
  id: string
  orderIds: string[]
  driverSlotId: string | null
  driverName: string | null
  timeOfDay: string | null
  assignmentDoneAt: string | null
  dispatchedAt: string | null
  completedAt: string | null
  pickLockedAt: string | null
  pickLockedBy: string | null
  pallets: WavePallet[]
}

interface PalletGroup {
  seq: number
  orders: Order[]
}

interface BatchGroup {
  waveId: string
  driverName: string
  timeOfDay: string
  pickLockedAt: string | null
  pickLockedBy: string | null
  pallets: PalletGroup[]
  unassignedOrders: Order[]
  orders: Order[]
  totalAmount: number
  untaxTotal: number
  totalWeight: number
}

// SSOT: 波次归属直接读 wave.driverName/timeOfDay/pallets(真实字段)，
// 不再通过过期的 wave.driverSlotId 反查 DriverSlot——一个波次现在可能横跨多个托盘，
// 单值反查只能代表其中一个，会导致徽章/筛选/打印用错快照(见 2026-07-10 复盘)。
function waveLabel(g: { driverName: string; timeOfDay: string }): string {
  return [g.driverName || '未分配', g.timeOfDay ? g.timeOfDay.toUpperCase() : ''].filter(Boolean).join(' ')
}

interface ActionLogRow {
  id: string
  userName: string | null
  userEmail: string | null
  detail: string | null
  action: string
  createdAt: string
}

// ─── PrintQueue ───────────────────────────────────────────────────────────────
// 打印不再靠 window.open 开新标签页去导航 /classic/print/dispatch/[type]——两个原因都致命：
// 1) "先开空白页、锁定接口返回后再跳转"这套写法，装了 uBlock Origin / 隐私类插件的浏览器会
//    当成弹窗广告套路专门拦截，锁定的打印按钮越多拦得越频繁(2026-07-10 反馈)。
// 2) 就算不管插件，next.config.ts 的 X-Frame-Options: DENY / frame-ancestors 'none' 对全站
//    生效，任何用 <iframe src="/classic/print/...">发起 HTTP 导航加载该页面的做法都会被浏览器
//    拒绝渲染(哪怕同源)——这两个头是防点击劫持的安全基线，不能为了打印弱化。
// 改法：跳过"导航到打印页"这一步，直接在这里调用 fetchDispatchPrintHtml() 拿到生成好的整份
// HTML 字符串，灌进 <iframe srcDoc>——srcDoc 是内联文档，不发起 HTTP 请求/响应，不受上面两个
// 响应头管辖，因此从根上避开了拦截和安全头冲突。iframe 必须给真实尺寸（不能 0x0/display:none），
// 否则内容按 100% 展开时会跟着塌缩成 0，打印内容渲染不出来；用 left 负值挪到屏幕外做到视觉不可见。
const HIDDEN_PRINT_IFRAME_STYLE: React.CSSProperties = {
  position: 'fixed', top: 0, left: '-10000px', width: 900, height: 1200, border: 0,
}

interface PrintJob { id: number; html: string }

function PrintQueue({ jobs }: { jobs: PrintJob[] }) {
  return (
    <>
      {jobs.map(job => (
        <iframe key={job.id} srcDoc={job.html} style={HIDDEN_PRINT_IFRAME_STYLE} title={`print-${job.id}`} />
      ))}
    </>
  )
}

// ─── BatchCard ────────────────────────────────────────────────────────────────

function BatchCard({
  group,
  date,
  isPrinted,
  canUnlock,
  onPrint,
  onLockChange,
  onQueuePrint,
}: {
  group: BatchGroup
  date: string
  isPrinted: boolean
  canUnlock: boolean
  onPrint: () => void
  onLockChange: () => void
  onQueuePrint: (html: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const { waveId, driverName, timeOfDay, pickLockedAt, pickLockedBy, pallets, unassignedOrders, orders, totalAmount, untaxTotal } = group
  const label = waveLabel(group)
  const uniqueCustomers = new Set(orders.map(o => o.restaurantId)).size

  // 点任何打印按钮(送货单/汇总单/销售单)都必须自动锁定批次，不能只有拣货单锁——
  // 否则打印后调度台仍能改派，纸质单据和系统状态就对不上了(2026-07-10 复盘)。
  // 锁定成功后现取现渲染 HTML，交给 onQueuePrint 挂进隐藏 iframe(见 PrintQueue)，不再导航。
  async function print(type: 'delivery' | 'summary' | 'sales') {
    setBusy(true)
    try {
      await apiPost(`/api/waves/${waveId}/pick-lock`, { reason: 'print', printType: type })
      const html = await fetchDispatchPrintHtml({ type, date, waveIds: [waveId] })
      onQueuePrint(html)
      onPrint()
      // 记录打印动作到操作记录（失败不影响打印）
      try {
        await apiPost('/api/waves/print-log', { date, type, scope: 'batch', batchLabel: label, waveId })
      } catch { /* 日志失败静默 */ }
      onLockChange()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打印失败')
    } finally {
      setBusy(false)
    }
  }

  // Feature C：打印拣货单即触发批次锁定（重打=重新上锁）；锁定失败则不打印，避免"打印了但没锁"
  // 拣货单分实物(storable)/耗材(consumable)两份，供两个拣货员分开作业
  async function printPicking(variant: 'storable' | 'consumable') {
    setBusy(true)
    try {
      await apiPost(`/api/waves/${waveId}/pick-lock`, { reason: 'print', variant })
      const html = await fetchDispatchPrintHtml({ type: 'picking', date, waveIds: [waveId], variant })
      onQueuePrint(html)
      onPrint()
      onLockChange()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打印失败')
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
            {pallets.length > 0 ? (
              pallets.map(p => (
                <span key={p.seq} className="bg-[#875A7B] text-white text-xs font-bold rounded px-2 py-0.5">
                  批次 {p.seq}
                </span>
              ))
            ) : (
              <span className="bg-gray-200 text-gray-500 text-xs rounded px-2 py-0.5">未分托盘</span>
            )}
            {timeOfDay && (
              <span className="bg-blue-100 text-blue-700 text-xs font-medium rounded px-2 py-0.5 uppercase">
                {timeOfDay}
              </span>
            )}
            {driverName ? (
              <span className="font-medium text-gray-900 text-sm">{driverName}</span>
            ) : (
              <span className="text-gray-400 text-sm italic">未分配</span>
            )}
            <span className="text-xs text-gray-400">
              {orders.length} 单 · {uniqueCustomers} 客户 · {pallets.length} 托盘
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
          <span className="text-sm font-semibold text-gray-900 mr-2">€{fmtMoney(totalAmount)}</span>
          <span className="text-xs text-gray-400 mr-3">未税 €{fmtMoney(untaxTotal)}</span>
          {!pickLockedAt && (
            <button
              onClick={lock}
              disabled={busy}
              className="px-2.5 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-40"
              title="锁定该波次，防止调度台再改动（打印拣货单也会自动上锁）"
            >
              🔓 锁定
            </button>
          )}
          {pickLockedAt && canUnlock && (
            <button
              onClick={unlock}
              disabled={busy}
              className="px-2.5 py-1 text-xs rounded border border-amber-400 text-amber-700 hover:bg-amber-50 transition-colors disabled:opacity-40"
              title="解锁该波次（仅 BOSS / WAREHOUSE 可操作）"
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
            onClick={() => print('sales')}
            disabled={busy}
            title="打印该波次销售单(含价格，含全部托盘) Sales Order · 打印会自动锁定该批次"
            className="px-2.5 py-1 text-xs rounded border border-purple-400 text-purple-700 hover:bg-purple-50 transition-colors disabled:opacity-40"
          >
            🧾 销售单
          </button>
          <button
            onClick={() => print('delivery')}
            disabled={busy}
            title="打印该波次送货单(含全部托盘) Delivery Note · 打印会自动锁定该批次"
            className="px-2.5 py-1 text-xs rounded border border-blue-400 text-blue-600 hover:bg-blue-50 transition-colors disabled:opacity-40"
          >
            🚚 送货单
          </button>
          <button
            onClick={() => print('summary')}
            disabled={busy}
            title="打印该波次送货汇总单(含全部托盘) Delivery Summary · 打印会自动锁定该批次"
            className="px-2.5 py-1 text-xs rounded border border-green-500 text-green-700 hover:bg-green-50 transition-colors disabled:opacity-40"
          >
            📋 汇总单
          </button>
        </div>
      </div>

      {/* Order list：按托盘缩进分组，与调度台 BatchTab 的托盘 lane 结构对齐，
          让操作员看清"这一趟车里到底有几个托盘、分别装了哪些订单"(不再是打平的单张列表) */}
      {expanded && (
        <div className="border-t border-gray-100">
          {pallets.map(p => (
            <div key={p.seq}>
              <div className="px-5 py-1.5 bg-gray-50 text-xs font-semibold text-gray-500">
                批次 {p.seq} · {p.orders.length} 单
              </div>
              {p.orders.map(o => (
                <div key={o.id} className="flex items-center gap-3 pl-8 pr-5 py-2 hover:bg-gray-50 border-b border-gray-50">
                  <span className="text-xs font-mono text-gray-500 w-36">{o.code ?? o.id.slice(-6)}</span>
                  <span className="flex-1 text-sm text-gray-800">{o.restaurantName}</span>
                  <span className="text-sm font-medium text-gray-900 w-24 text-right">
                    €{fmtMoney(Number(o.totalAmount))}
                  </span>
                </div>
              ))}
            </div>
          ))}
          {unassignedOrders.length > 0 && (
            <div>
              <div className="px-5 py-1.5 bg-amber-50 text-xs font-semibold text-amber-600">
                未分配托盘 · {unassignedOrders.length} 单
              </div>
              {unassignedOrders.map(o => (
                <div key={o.id} className="flex items-center gap-3 pl-8 pr-5 py-2 hover:bg-gray-50 border-b border-gray-50">
                  <span className="text-xs font-mono text-gray-500 w-36">{o.code ?? o.id.slice(-6)}</span>
                  <span className="flex-1 text-sm text-gray-800">{o.restaurantName}</span>
                  <span className="text-sm font-medium text-gray-900 w-24 text-right">
                    €{fmtMoney(Number(o.totalAmount))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── BatchSections ────────────────────────────────────────────────────────────

function BatchSections({
  batchGroups,
  date,
  printedKeys,
  canUnlock,
  onPrint,
  onLockChange,
  onQueuePrint,
}: {
  batchGroups: BatchGroup[]
  date: string
  printedKeys: Set<string>
  canUnlock: boolean
  onPrint: (waveId: string) => void
  onLockChange: () => void
  onQueuePrint: (html: string) => void
}) {
  const amGroups = batchGroups.filter(g => g.timeOfDay === 'am')
  const pmGroups = batchGroups.filter(g => g.timeOfDay === 'pm')
  const otherGroups = batchGroups.filter(g => g.timeOfDay !== 'am' && g.timeOfDay !== 'pm')

  function renderGroup(g: BatchGroup) {
    return (
      <BatchCard
        key={g.waveId}
        group={g}
        date={date}
        isPrinted={printedKeys.has(g.waveId)}
        canUnlock={canUnlock}
        onPrint={() => onPrint(g.waveId)}
        onLockChange={onLockChange}
        onQueuePrint={onQueuePrint}
      />
    )
  }

  return (
    <div className="space-y-4">
      {amGroups.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-blue-600 uppercase tracking-wider">AM 上午</span>
            <span className="text-xs text-gray-400">{amGroups.length} 波次</span>
            <div className="flex-1 h-px bg-blue-100" />
          </div>
          {amGroups.map(renderGroup)}
        </div>
      )}
      {pmGroups.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-orange-500 uppercase tracking-wider">PM 下午</span>
            <span className="text-xs text-gray-400">{pmGroups.length} 波次</span>
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
              <span className="text-xs text-gray-400">{otherGroups.length} 波次</span>
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
  // 解锁权限的唯一开关：当前先全部放开（能进打印中心的人都可解锁）。
  // 日后要收口到某个具体用户，把这里换成 useAbility() 判断即可（如 ability.userId === 'xxx'）。
  const canUnlock = true

  const [date, setDate] = useState(today)
  const [waves, setWaves] = useState<Wave[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [sortMode, setSortMode] = useState<'batch' | 'driver' | 'time'>('batch')
  const [driverFilter, setDriverFilter] = useState<string[]>([])
  const [timeFilter, setTimeFilter] = useState<string[]>([])
  const [batchFilter, setBatchFilter] = useState<string[]>([])
  const [printedKeys, setPrintedKeys] = useState<Set<string>>(new Set())
  const [logs, setLogs] = useState<ActionLogRow[]>([])
  // 打印队列：每次打印挂一个隐藏 iframe(见 PrintQueue)，不主动卸载——iframe 是 0 尺寸挪到
  // 屏幕外的轻量元素，攒一整天的打印任务对内存无实质影响，比"猜多久该卸载"更简单可靠
  // (太早卸载可能打断还没弹出/还没关闭的系统打印对话框)。
  const [printJobs, setPrintJobs] = useState<PrintJob[]>([])
  const printJobSeq = useRef(0)
  const queuePrint = useCallback((html: string) => {
    printJobSeq.current += 1
    setPrintJobs(prev => [...prev, { id: printJobSeq.current, html }])
  }, [])

  useEffect(() => {
    setPrintedKeys(loadPrintedKeys(date))
  }, [date])

  const markPrinted = useCallback((waveId: string) => {
    setPrintedKeys(prev => {
      const next = new Set(prev)
      next.add(waveId)
      savePrintedKeys(date, next)
      return next
    })
  }, [date])

  const clearPrinted = useCallback(() => {
    setPrintedKeys(new Set())
    savePrintedKeys(date, new Set())
  }, [date])

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

  const ordersById = useMemo(() => new Map(orders.map(o => [o.id, o])), [orders])

  // 每张卡片 = 一个 wave，与调度台一一对应；分组直接读 wave 自身字段
  // (driverName/timeOfDay/pallets)，不再反查过期的 driverSlotId 快照。
  const waveGroups = useMemo(() => {
    return waves
      .map(w => {
        const ords = w.orderIds.map(id => ordersById.get(id)).filter((o): o is Order => !!o)
        const inPallet = new Set<string>()
        const pallets: PalletGroup[] = (w.pallets ?? [])
          .slice()
          .sort((a, b) => a.seq - b.seq)
          .map(p => {
            const orderIds = [...new Set(p.items.map(it => it.orderId))]
            orderIds.forEach(id => inPallet.add(id))
            return {
              seq: p.seq,
              orders: orderIds.map(id => ordersById.get(id)).filter((o): o is Order => !!o),
            }
          })
          .filter(p => p.orders.length > 0)
        const unassignedOrders = ords.filter(o => !inPallet.has(o.id))
        return {
          waveId: w.id,
          driverName: w.driverName ?? '',
          timeOfDay: (w.timeOfDay ?? '').toLowerCase(),
          pickLockedAt: w.pickLockedAt,
          pickLockedBy: w.pickLockedBy,
          pallets,
          unassignedOrders,
          orders: ords,
        }
      })
      .filter(g => g.orders.length > 0)
  }, [waves, ordersById])

  const filterOptions = useMemo(() => {
    const drivers = new Set<string>()
    const times = new Set<string>()
    const batches = new Set<number>()
    for (const g of waveGroups) {
      if (g.driverName) drivers.add(g.driverName)
      if (g.timeOfDay) times.add(g.timeOfDay)
      for (const p of g.pallets) batches.add(p.seq)
    }
    return {
      drivers: [...drivers].sort(),
      times: [...times].sort(),
      batches: [...batches].sort((a, b) => a - b).map(String),
    }
  }, [waveGroups])

  const filteredWaveGroups = useMemo(() => {
    return waveGroups.filter(g => {
      if (driverFilter.length > 0 && !driverFilter.includes(g.driverName)) return false
      if (timeFilter.length > 0 && !timeFilter.includes(g.timeOfDay)) return false
      if (batchFilter.length > 0 && !g.pallets.some(p => batchFilter.includes(String(p.seq)))) return false
      return true
    })
  }, [waveGroups, driverFilter, timeFilter, batchFilter])

  const batchGroups: BatchGroup[] = useMemo(() => {
    const groups = filteredWaveGroups.map(g => ({
      ...g,
      totalAmount: g.orders.reduce((s, o) => s + Number(o.totalAmount), 0),
      untaxTotal: g.orders.reduce((s, o) => s + (o.lines ?? []).reduce((ls, l) => ls + lineUntax(l), 0), 0),
      totalWeight: g.orders.reduce((s, o) => s + (o.lines ?? []).reduce((ls, l) => ls + lineWeight(l as BatchLine), 0), 0),
    }))

    return groups.sort((a, b) => {
      const aNum = a.pallets[0]?.seq ?? 0
      const bNum = b.pallets[0]?.seq ?? 0
      if (sortMode === 'batch') return aNum - bNum || a.timeOfDay.localeCompare(b.timeOfDay) || a.driverName.localeCompare(b.driverName)
      if (sortMode === 'time') return a.timeOfDay.localeCompare(b.timeOfDay) || aNum - bNum || a.driverName.localeCompare(b.driverName)
      return a.driverName.localeCompare(b.driverName) || aNum - bNum
    })
  }, [filteredWaveGroups, sortMode])

  // 顶部「全部打印」跟随筛选：无筛选=整日全部；有筛选=只打屏幕上可见的这批波次（传 waveIds）
  const isFiltered = driverFilter.length > 0 || timeFilter.length > 0 || batchFilter.length > 0
  const filteredWaveIds = isFiltered ? batchGroups.map(g => g.waveId) : undefined

  // 顶部「全部打印」也要给每个可见波次自动上锁，跟拣货单一致——否则批量打印销售单后
  // 调度台仍能改派，纸质单据和系统状态就对不上了。锁定结果出来后现取现渲染 HTML，交给
  // queuePrint 挂进隐藏 iframe，不再导航到打印页(见 PrintQueue 顶部注释)。
  async function bulkPrint() {
    const type = 'sales'
    const results = await Promise.allSettled(
      batchGroups.map(g => apiPost(`/api/waves/${g.waveId}/pick-lock`, { reason: 'print', printType: type }))
    )
    const failed = results.filter(r => r.status === 'rejected').length
    try {
      const html = await fetchDispatchPrintHtml({ type, date, waveIds: filteredWaveIds })
      queuePrint(html)
    } catch {
      toast.error('打印失败')
    }
    try {
      await apiPost('/api/waves/print-log', { date, type, scope: isFiltered ? 'filtered' : 'bulk', count: batchGroups.length })
    } catch { /* 日志失败静默 */ }
    if (failed > 0) toast.error(`${failed} 个波次锁定失败`)
    refresh()
  }

  // Feature C：「打印拣货单」= 对当前可见波次批量上锁，锁定失败的波次不阻断其余波次打印
  // 分实物/耗材两份，供两个拣货员分开作业；打印范围与锁定范围一致（跟随筛选）
  async function bulkPrintPicking(variant: 'storable' | 'consumable') {
    const results = await Promise.allSettled(
      batchGroups.map(g => apiPost(`/api/waves/${g.waveId}/pick-lock`, { reason: 'print', variant }))
    )
    const failed = results.filter(r => r.status === 'rejected').length
    try {
      const html = await fetchDispatchPrintHtml({ type: 'picking', date, waveIds: filteredWaveIds, variant })
      queuePrint(html)
    } catch {
      toast.error('打印失败')
    }
    for (const g of batchGroups) markPrinted(g.waveId)
    if (failed > 0) toast.error(`${failed} 个波次锁定失败`)
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
                <span>共 {orders.length} 单 · {batchGroups.length} 波次 · €{fmtMoney(grandTotal)}</span>
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
                已筛选 · 打印 {batchGroups.length} 波次
              </span>
            )}
            <span className="inline-flex rounded overflow-hidden">
              <button
                onClick={() => bulkPrintPicking('storable')}
                disabled={batchGroups.length === 0}
                title={isFiltered ? '当前筛选波次 · 整箱整袋拣货单' : '全部波次 · 整箱整袋拣货单'}
                className="px-3 py-1.5 text-xs bg-orange-500 text-white hover:bg-orange-600 transition-colors disabled:opacity-40 disabled:hover:bg-orange-500"
              >
                {isFiltered ? '筛选拣货单' : '全部拣货单'} 📦 整箱整袋
              </button>
              <button
                onClick={() => bulkPrintPicking('consumable')}
                disabled={batchGroups.length === 0}
                title={isFiltered ? '当前筛选波次 · 零散货拣货单' : '全部波次 · 零散货拣货单'}
                className="px-3 py-1.5 text-xs bg-orange-500 text-white border-l border-orange-300 hover:bg-orange-600 transition-colors disabled:opacity-40 disabled:hover:bg-orange-500"
              >
                🧴 零散货
              </button>
            </span>
            <button
              onClick={bulkPrint}
              disabled={batchGroups.length === 0}
              title={(isFiltered ? '仅打印当前筛选波次的销售单(含价格)' : '打印全部波次的销售单(含价格)') + ' · 打印会自动锁定这些批次'}
              className="px-3 py-1.5 text-xs rounded bg-purple-500 text-white hover:bg-purple-600 transition-colors disabled:opacity-40 disabled:hover:bg-purple-500"
            >
              {isFiltered ? '打印筛选销售单' : '全部打印销售单'}
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
          {date} 没有已分配完成的波次
        </div>
      ) : (
        <BatchSections
          batchGroups={batchGroups}
          date={date}
          printedKeys={printedKeys}
          canUnlock={canUnlock}
          onPrint={markPrinted}
          onLockChange={refresh}
          onQueuePrint={queuePrint}
        />
      )}

      {/* 操作记录（当前配送日期）：锁定 / 解锁 / 打印 */}
      <OperationLog logs={logs} />

      {/* 隐藏打印队列：不占布局位置(position:fixed 挪出屏幕)，放在哪里都一样 */}
      <PrintQueue jobs={printJobs} />
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
                    {formatDateTime(log.createdAt)}
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
