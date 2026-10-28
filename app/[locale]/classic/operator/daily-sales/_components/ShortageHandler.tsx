'use client'
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet, apiPost } from '@/lib/api'
import { SHORTAGE_REASON_CODES, SHORTAGE_REASON_LABELS, type ShortageReasonCode } from '@/lib/shortage-reason'
import { formatDateTime } from '@/lib/format-date'
import type { Order, Customer } from '@/lib/types'
import type { DriverSlotInfo } from '@/lib/driver-slot'
import { today } from './shared'
import ProductSearchInput from '@/components/classic/ProductSearchInput'
import { DatePicker } from '@/components/ui/date-picker'
import { buildOrderHtml, CSS } from '../../../print/[id]/page'
import type { PrintLang } from '@/lib/print/print-i18n'

// buildOrderHtml 的订单参数类型比 Order 本身更严格（这几个字段不接受 null），
// batch/page.tsx 已有同名类型按同一约定声明，这里跟它保持一致
type PrintOrder = Order & { code?: string; deliveryDate?: string; internalNote?: string; externalNote?: string; salesman?: string; deliveryBatch?: string }

// 打印不走 window.open 导航到 /classic/print/batch——弹窗拦截器会把它当广告拦掉（见下方
// printOrders 的注释），改成跟 PrintCenter.tsx 的 PrintQueue 一样：直接拿 buildOrderHtml/CSS
// 现生成 HTML，灌进隐藏 iframe 的 srcDoc，不发起任何新窗口/新标签页。
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

// SSOT：订单归属司机/时段以 PickingWave.orderIds 为准（拖拽调度不回填 Order.driverSlotId），
// 与配送调度中心、打印中心口径一致；只看 Order.driverSlot 会漏掉只拖拽分配的司机。
interface Wave {
  orderIds: string[]
  driverSlotId: string | null
  driverName: string | null
  /** 拣货锁：减量/删行放行，加量拦截（见 app/api/daily-sales/shortage/bulk-adjust） */
  pickLockedAt: string | null
}

interface ProductOption {
  id: string
  name: string
  internalRef?: string | null
  category?: string | null
  qtyOnHand?: number | null
}

interface FlatLine {
  lineId: string
  orderId: string
  orderCode: string
  customerName: string
  productId: string
  productName: string
  uomName: string | null
  driverName: string | null
  timeOfDay: string | null
  orderedQty: number
  /** 所在批次是否已被拣货锁锁住 */
  locked: boolean
}

type TimeFilter = 'all' | 'am' | 'pm'

// 操作日志 detail 是写入时(app/api/orders/[id]/lines/[lineId]/route.ts)拼好的中文句子，
// 只读展示时按已知模板做最佳努力翻译；不认识的格式原样透出
function translateLogDetail(detail: string, isEn: boolean): string {
  if (!isEn) return detail
  let m = detail.match(/^删除订单行: (.+)（原数量 (.+)，新数量 0）$/)
  if (m) return `Deleted order line: ${m[1]} (was ${m[2]}, now 0)`
  m = detail.match(/^删除订单行: (.+)（数量 (.+)）$/)
  if (m) return `Deleted order line: ${m[1]} (qty ${m[2]})`
  m = detail.match(/^修改订单行数量: (.+)（(.+) → (.+)）$/)
  if (m) return `Changed order line qty: ${m[1]} (${m[2]} → ${m[3]})`
  return detail
}

interface ActionLog {
  id: string
  userName: string | null
  userEmail: string | null
  action: string
  resourceId: string | null
  detail: string | null
  createdAt: string
}

export default function ShortageHandler({ refreshKey = 0 }: { refreshKey?: number }) {
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale

  const [date, setDate] = useState(today)
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all')
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>([])
  const [slots, setSlots] = useState<DriverSlotInfo[]>([])
  const [waves, setWaves] = useState<Wave[]>([])
  const [selectedProducts, setSelectedProducts] = useState<ProductOption[]>([])
  const [productQuery, setProductQuery] = useState('')
  const [orderQuery, setOrderQuery] = useState('')
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [newQtys, setNewQtys] = useState<Record<string, string>>({})
  const [savedLineIds, setSavedLineIds] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // 台账 D6：勾选 + 批量填充 + 缺货原因 + 被拦截明细
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [bulkQty, setBulkQty] = useState('')
  const [reasonCode, setReasonCode] = useState<ShortageReasonCode>('SUPPLIER_SHORT')
  const [reasonNote, setReasonNote] = useState('')
  const [blockedRows, setBlockedRows] = useState<Array<{ orderCode: string; message: string }>>([])
  const [deferInfo, setDeferInfo] = useState<Array<{ code: string; date: string }>>([])
  const [historyOpen, setHistoryOpen] = useState(true)
  const [history, setHistory] = useState<ActionLog[]>([])
  // 商品搜索候选池只有 id/name（派生自订单行，见 searchableProducts 注释），本身不带
  // internalRef/category/qtyOnHand——之前占位文案写着"支持 Internal Reference 搜索"
  // 但字段从没填过，搜内部编码必然搜不到。这里单独拉一份全量商品目录（不筛 status，
  // 已下架商品也要能查到，呼应 searchableProducts 的"已下架但当天仍有缺货行照样能搜"）
  // 只用来补充这三个展示/搜索字段，候选池本身的构成仍然只认订单行。
  const [productCatalog, setProductCatalog] = useState<Map<string, { internalRef: string | null; category: string | null; qtyOnHand: number | null }>>(new Map())
  // 打印队列：隐藏 iframe 累积挂着不卸载，见下方 printOrders 注释
  const [printJobs, setPrintJobs] = useState<PrintJob[]>([])
  const printJobSeq = useRef(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  // 操作记录引用的订单信息（订单号+客户名），按日志 resourceId 直接拉取，
  // 不依赖当天缺货订单列表，保证记录里一定能显示是哪个订单、并可点击进详情。
  const [logOrderInfo, setLogOrderInfo] = useState<Map<string, { customer: string; code: string }>>(new Map())

  const loadOrders = useCallback(() => {
    if (!date) return
    setLoading(true)
    setLoadError(false)
    setNewQtys({})
    setSavedLineIds(new Set())
    setSaveMsg(null)
    setSelectedDrivers([])
    setChecked(new Set())
    setBlockedRows([])
    setDeferInfo([])
    Promise.all([
      apiGet<Order[]>(
        `/api/orders?include_lines=true&status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY&dateField=deliveryDate&fromDate=${date}&toDate=${date}`
      )
        .then(d => setOrders(Array.isArray(d) ? d : []))
        // 以前这里吞错误后直接清空订单，跟"当天真的没单"长得一模一样——商品搜索池
        // (searchableProducts) 派生自订单行，一旦这里悄悄空了，操作员打什么都搜不到，
        // 看起来就是"输入商品名不起作用"，却查不出是接口挂了还是真没数据。
        .catch(() => { setOrders([]); setLoadError(true) }),
      apiGet<Wave[]>(`/api/waves?date=${date}`)
        .then(d => setWaves(Array.isArray(d) ? d : []))
        .catch(() => { setWaves([]); setLoadError(true) }),
    ]).finally(() => setLoading(false))
  }, [date])

  useEffect(() => { loadOrders() }, [loadOrders])

  // 页头「刷新」：跳过首次挂载，之后 refreshKey 变化重拉当天缺货订单
  useEffect(() => {
    if (refreshKey === 0) return
    loadOrders()
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    apiGet<DriverSlotInfo[]>('/api/driver-slots?includeInactiveUser=true')
      .then(d => setSlots(Array.isArray(d) ? d : []))
      .catch(() => setSlots([]))
  }, [])

  useEffect(() => {
    apiGet<Array<{ id: string; internalRef?: string | null; category?: string | null; qtyOnHand?: number | null }>>('/api/products?slim=1')
      .then(d => {
        const m = new Map<string, { internalRef: string | null; category: string | null; qtyOnHand: number | null }>()
        for (const p of Array.isArray(d) ? d : []) {
          m.set(p.id, { internalRef: p.internalRef ?? null, category: p.category ?? null, qtyOnHand: p.qtyOnHand ?? null })
        }
        setProductCatalog(m)
      })
      .catch(() => {})
  }, [])

  // orderId → 司机/时段（按 wave 归属，SSOT）；覆盖只拖拽分配、未回填 Order.driverSlotId 的订单
  const orderDriverMap = useMemo(() => {
    const slotMap = new Map(slots.map(s => [s.id, s]))
    const m = new Map<string, { driver: string | null; time: string | null; locked: boolean }>()
    for (const w of waves) {
      const slot = w.driverSlotId ? slotMap.get(w.driverSlotId) : undefined
      const driver = slot?.driverName ?? w.driverName ?? null
      const time = slot?.timeOfDay ? slot.timeOfDay.toLowerCase() : null
      for (const id of w.orderIds) {
        const prev = m.get(id)
        // 一单理论上只属一个 wave（db:validate 有这条不变量），但只要有一个锁着就算锁着
        if (prev) prev.locked = prev.locked || w.pickLockedAt != null
        else m.set(id, { driver, time, locked: w.pickLockedAt != null })
      }
    }
    return m
  }, [waves, slots])

  const allLines: FlatLine[] = useMemo(() => {
    // 同一订单可能有多条含相同商品的行（如重复录入），按 orderId+productId 合并，避免同一订单号在表格中重复出现
    const map = new Map<string, FlatLine>()
    for (const o of orders) {
      // 司机/时段优先按 wave 归属(SSOT)，回退到 Order.driverSlot(旧数据兜底)
      const wd = orderDriverMap.get(o.id)
      const driverName = wd?.driver ?? o.driverSlot?.driverName ?? null
      const timeOfDay = wd?.time ?? (o.driverSlot?.timeOfDay?.toLowerCase() ?? null)
      for (const l of (o.lines ?? [])) {
        const key = `${o.id}:${l.productId}`
        const existing = map.get(key)
        if (existing) {
          existing.orderedQty += Number(l.orderedQty)
          continue
        }
        map.set(key, {
          lineId: l.id,
          orderId: o.id,
          orderCode: o.code ?? o.id.slice(-6).toUpperCase(),
          customerName: o.restaurantName,
          productId: l.productId,
          productName: l.productName,
          uomName: l.uomName ?? null,
          driverName,
          timeOfDay,
          orderedQty: Number(l.orderedQty),
          locked: wd?.locked ?? false,
        })
      }
    }
    return Array.from(map.values())
  }, [orders, orderDriverMap])

  // 操作记录里只有订单 id（ActionLog.resourceId），客户名/订单号靠当天订单映射补上，
  // 并把 resourceId 直接当作订单 id 链到订单详情（新标签打开）。
  const orderInfoMap = useMemo(() => {
    const m = new Map<string, { customer: string; code: string }>()
    for (const o of orders) m.set(o.id, { customer: o.restaurantName, code: o.code ?? o.id.slice(-6).toUpperCase() })
    return m
  }, [orders])

  // 商品搜索候选池从当天订单实际出现过的行派生，而不是全量商品目录：
  // 缺货处理是在筛选「已存在的订单行」，只有当天真的有行的商品才值得被搜到——
  // 既天然排除从不进客户订单的采购原料/包材，也不受商品后续 canBeSold 开关影响，
  // 已下架但当天仍有未处理缺货行的商品照样能搜到、能改量。
  const searchableProducts = useMemo(() => {
    const map = new Map<string, ProductOption>()
    for (const l of allLines) {
      if (map.has(l.productId)) continue
      const meta = productCatalog.get(l.productId)
      map.set(l.productId, {
        id: l.productId,
        name: l.productName,
        internalRef: meta?.internalRef ?? null,
        category: meta?.category ?? null,
        qtyOnHand: meta?.qtyOnHand ?? null,
      })
    }
    return Array.from(map.values())
  }, [allLines, productCatalog])

  const availableDrivers = useMemo(() => {
    const set = new Set<string>()
    for (const l of allLines) {
      if (l.driverName) set.add(l.driverName)
    }
    return Array.from(set).sort()
  }, [allLines])

  // 缺货商品由仓库报上来，必须先搜索选中商品、或输入订单号才展示对应订单行
  // allLines 已按 orderId+productId 合并去重，这里只需按条件过滤
  const filteredLines = useMemo(() => {
    const q = orderQuery.trim().toLowerCase()
    if (selectedProducts.length === 0 && !q) return []
    return allLines.filter(l => {
      if (timeFilter !== 'all' && l.timeOfDay !== timeFilter) return false
      if (selectedDrivers.length > 0 && (!l.driverName || !selectedDrivers.includes(l.driverName))) return false
      if (selectedProducts.length > 0 && !selectedProducts.some(p => p.id === l.productId)) return false
      if (q && !l.orderCode.toLowerCase().includes(q)) return false
      return true
    })
  }, [allLines, timeFilter, selectedDrivers, selectedProducts, orderQuery])

  // 已保存成功的行要排除在外，否则 newQtys 里的旧值会在下次点「保存修改」时被重新提交一遍
  // （若该行当时是清零删行，重复提交会因行已不存在而报错，污染这次保存的失败计数）
  const modifiedLines = useMemo(
    () => filteredLines.filter(l => !savedLineIds.has(l.lineId) && (newQtys[l.lineId]?.trim() ?? '') !== ''),
    [filteredLines, newQtys, savedLineIds]
  )

  // 真正要提交的行：勾了就只提交勾中的（且填了新数量的），一行没勾就沿用原来的
  // 「填了数字就算」的行为 —— 老用户不勾选也能照旧用，不逼人多学一步。
  const targetLines = useMemo(
    () => (checked.size > 0 ? modifiedLines.filter(l => checked.has(l.lineId)) : modifiedLines),
    [modifiedLines, checked]
  )

  const selectableLines = useMemo(
    () => filteredLines.filter(l => !savedLineIds.has(l.lineId)),
    [filteredLines, savedLineIds]
  )

  function toggleChecked(lineId: string) {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(lineId)) next.delete(lineId); else next.add(lineId)
      return next
    })
  }

  function toggleAll() {
    setChecked(prev => (prev.size === selectableLines.length ? new Set() : new Set(selectableLines.map(l => l.lineId))))
  }

  /** 批量填充新数量到勾选行（没勾就填当前筛选出的全部未保存行） */
  function applyBulkQty(value: string) {
    const rows = checked.size > 0 ? selectableLines.filter(l => checked.has(l.lineId)) : selectableLines
    if (rows.length === 0) return
    setNewQtys(prev => {
      const next = { ...prev }
      for (const l of rows) next[l.lineId] = value
      return next
    })
    setChecked(new Set(rows.map(l => l.lineId)))
  }

  function toggleDriver(driver: string) {
    setSelectedDrivers(prev =>
      prev.includes(driver) ? prev.filter(d => d !== driver) : [...prev, driver]
    )
  }

  function addProduct(p: ProductOption) {
    setSelectedProducts(prev => (prev.some(sp => sp.id === p.id) ? prev : [...prev, p]))
    setProductQuery('')
  }

  function removeProduct(id: string) {
    setSelectedProducts(prev => prev.filter(p => p.id !== id))
  }

  function getLineStatus(lineId: string) {
    if (savedLineIds.has(lineId)) return 'saved'
    if ((newQtys[lineId]?.trim() ?? '') !== '') return 'pending'
    return 'none'
  }

  /**
   * 保存 / 转单都走同一个批量接口（POST /api/daily-sales/shortage/bulk-adjust）：
   * 原先是前端 for 循环逐行 PATCH，失败只汇成一句「N 条失败」——被拣货锁拦下的单
   * 和真出错的单混在同一个数字里，操作员看不出该去解锁还是该报修。
   * 现在服务端逐单返回 applied / blocked，原因（PICK_LOCKED / ORDER_STATUS / …）直接列出来。
   */
  async function submit(mode: 'ADJUST' | 'DEFER') {
    if (targetLines.length === 0) return
    setSaving(true)
    setSaveMsg(null)
    setBlockedRows([])
    setDeferInfo([])
    try {
      const res = await apiPost<{
        applied: Array<{ lineId: string; deferOrderCode?: string }>
        blocked: Array<{ orderCode: string; message: string }>
        deferOrders: Array<{ code: string; date: string }>
      }>('/api/daily-sales/shortage/bulk-adjust', {
        mode,
        reasonCode,
        reasonNote,
        items: targetLines.map(l => ({
          orderId: l.orderId,
          lineId: l.lineId,
          newQty: Number(newQtys[l.lineId]!.trim()),
        })),
      })
      const okIds = new Set(res.applied.map(a => a.lineId))
      setSavedLineIds(prev => new Set([...prev, ...okIds]))
      setNewQtys(prev => {
        const next = { ...prev }
        for (const id of okIds) delete next[id]
        return next
      })
      setChecked(prev => new Set([...prev].filter(id => !okIds.has(id))))
      setBlockedRows(res.blocked)
      setDeferInfo(res.deferOrders ?? [])
      setSaveMsg({
        ok: res.blocked.length === 0,
        text: res.blocked.length === 0
          ? (isEn ? `${okIds.size} saved` : `${okIds.size} 条已保存`)
          : (isEn
            ? `${okIds.size} succeeded, ${res.blocked.length} blocked (see below)`
            : `${okIds.size} 条成功，${res.blocked.length} 条被拦截（见下方）`),
      })
    } catch (e) {
      setSaveMsg({ ok: false, text: e instanceof Error ? e.message : (isEn ? 'Failed' : '处理失败') })
    } finally {
      setSaving(false)
    }
  }

  // 之前用 window.open 导航到 /classic/print/batch，装了隐私类插件的浏览器会把"点击→开新
  // 窗口"当成弹窗广告拦掉（反馈截图里的"浏览器拦截了弹出窗口"就是这个）。改成跟 PrintCenter.tsx
  // 的 PrintQueue 同一套做法：现取数据、用已导出的 buildOrderHtml/CSS 现生成 HTML，灌进本页内
  // 一个隐藏 iframe 的 srcDoc 直接触发打印，完全不开新窗口，自然不会被拦。
  async function printOrders(docType: 'delivery' | 'sales') {
    const orderIds = [...new Set(
      filteredLines.filter(l => savedLineIds.has(l.lineId)).map(l => l.orderId)
    )]
    if (orderIds.length === 0) return
    try {
      const [fetchedOrders, customers] = await Promise.all([
        Promise.all(orderIds.map(id => apiGet<PrintOrder>(`/api/orders/${id}`).catch(() => null))),
        apiGet<Customer[]>('/api/customers').catch(() => [] as Customer[]),
      ])
      const validOrders = fetchedOrders.filter((o): o is PrintOrder => o != null)
      if (validOrders.length === 0) {
        setSaveMsg({ ok: false, text: isEn ? 'Failed to load orders for printing' : '加载打印订单失败' })
        return
      }
      const lang: PrintLang = isEn ? 'en' : 'zh'
      const bodyHtml = validOrders
        .map((order, i) => {
          const customer = customers.find(c => c.id === order.restaurantId) ?? null
          return buildOrderHtml(order, customer, { docType, pageBreakAfter: i < validOrders.length - 1 }, lang)
        })
        .join('\n')
      const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>${CSS}</style>
</head>
<body>
${bodyHtml}
<script>
  var ts = new Date();
  var pad = function(n){ return n < 10 ? '0'+n : ''+n; };
  var stamp = pad(ts.getDate()) + '/' + pad(ts.getMonth()+1) + '/' + ts.getFullYear() +
    ' ' + pad(ts.getHours()) + ':' + pad(ts.getMinutes());
  document.querySelectorAll('.print-ts').forEach(function(el){ el.textContent = stamp; });
  window.print();
<\/script>
</body>
</html>`
      printJobSeq.current += 1
      setPrintJobs(prev => [...prev, { id: printJobSeq.current, html }])
    } catch (e) {
      setSaveMsg({ ok: false, text: e instanceof Error ? e.message : (isEn ? 'Print failed' : '打印失败') })
    }
  }

  // 「操作记录」= 缺货处理产生的改量/删行记录，按记录对应订单的 deliveryDate 归到「所选配送日」
  // （而非按操作发生时间过滤——改动往往在配送日之前几天做，用发生时间会一条都对不上）。
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await apiGet<{ logs: ActionLog[] } | ActionLog[]>('/api/action-logs?resource=order&take=100')
      const logs: ActionLog[] = Array.isArray(res) ? res : (res as { logs: ActionLog[] }).logs ?? []
      const shortageLogs = logs.filter(log =>
        log.detail?.startsWith('修改订单行数量') || log.detail?.startsWith('删除订单行')
      )
      // 拉这些日志对应订单的 deliveryDate + 展示信息，只保留归属所选配送日的记录
      const ids = Array.from(new Set(shortageLogs.map(l => l.resourceId).filter((v): v is string => !!v)))
      const info = new Map<string, { customer: string; code: string; deliveryDate: string }>()
      if (ids.length > 0) {
        try {
          const ords = await apiGet<Array<{ id: string; code?: string | null; restaurantName?: string | null; deliveryDate?: string | null }>>(
            `/api/orders?ids=${ids.join(',')}`
          )
          for (const o of Array.isArray(ords) ? ords : []) {
            info.set(o.id, {
              customer: o.restaurantName ?? '',
              code: o.code ?? o.id.slice(-6).toUpperCase(),
              deliveryDate: o.deliveryDate ? String(o.deliveryDate).slice(0, 10) : '',
            })
          }
        } catch { /* 补齐失败：下方过滤将得到空集 */ }
      }
      const filtered = shortageLogs.filter(l => l.resourceId && info.get(l.resourceId)?.deliveryDate === date)
      setHistory(filtered)
      setLogOrderInfo(new Map([...info].map(([k, v]) => [k, { customer: v.customer, code: v.code }])))
    } catch {
      setHistory([])
      setLogOrderInfo(new Map())
    } finally {
      setHistoryLoading(false)
    }
  }, [date])

  // 展开时加载；展开状态下切换配送日自动重拉
  useEffect(() => {
    if (historyOpen) loadHistory()
  }, [historyOpen, loadHistory])

  function toggleHistory() {
    setHistoryOpen(prev => !prev)
  }

  const printableOrderCount = new Set(
    filteredLines.filter(l => savedLineIds.has(l.lineId)).map(l => l.orderId)
  ).size

  return (
    <div className="space-y-4">
      {loadError && (
        <div className="px-4 py-2 rounded-lg border border-red-200 bg-red-50 text-sm text-red-600 flex items-center justify-between">
          <span>
            {isEn
              ? 'Failed to load today\'s orders — product search has no data to match against. Try refreshing.'
              : '当天订单加载失败，商品搜索池是空的所以打什么都搜不到，不是搜索坏了。请点"刷新"重试。'}
          </span>
          <button onClick={loadOrders} className="text-xs underline shrink-0 ml-3">
            {isEn ? 'Retry' : '重试'}
          </button>
        </div>
      )}
      {/* Filter bar */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">{isEn ? 'Delivery Date' : '配送日期'}</label>
            <DatePicker
              value={date}
              onChange={setDate}
              className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-[#875A7B]"
            />
          </div>
          <div className="flex items-center gap-1">
            {(['all', 'am', 'pm'] as TimeFilter[]).map(t => (
              <button
                key={t}
                onClick={() => setTimeFilter(t)}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  timeFilter === t
                    ? 'bg-[#875A7B] text-white border-[#875A7B]'
                    : 'border-gray-300 text-gray-600 hover:border-[#875A7B]'
                }`}
              >
                {t === 'all' ? (isEn ? 'All' : '全部') : t.toUpperCase()}
              </button>
            ))}
          </div>
          <span className="text-xs text-gray-400">
            {loading
              ? (isEn ? 'Loading...' : '加载中...')
              : selectedProducts.length === 0
                ? (isEn ? `${allLines.length} lines today, select a product first` : `当天共 ${allLines.length} 行，先选择商品`)
                : (isEn ? `${filteredLines.length} / ${allLines.length} lines` : `${filteredLines.length} / ${allLines.length} 行`)}
          </span>
        </div>

        {availableDrivers.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500 shrink-0">{isEn ? 'Driver' : '司机'}</span>
            {availableDrivers.map(d => (
              <button
                key={d}
                onClick={() => toggleDriver(d)}
                className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                  selectedDrivers.includes(d)
                    ? 'bg-[#875A7B] text-white border-[#875A7B]'
                    : 'border-gray-300 text-gray-600 hover:border-[#875A7B]'
                }`}
              >
                {d}
              </button>
            ))}
            {selectedDrivers.length > 0 && (
              <button onClick={() => setSelectedDrivers([])} className="text-xs text-gray-400 hover:text-gray-600">
                {isEn ? 'Clear' : '清除'}
              </button>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 shrink-0">{isEn ? 'Product' : '商品'}</span>
          {selectedProducts.map(p => (
            <span key={p.id} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-[#f3edf7] text-[#875A7B] rounded border border-[#d4b8e0]">
              {p.name}
              <button onClick={() => removeProduct(p.id)} className="hover:text-red-500 leading-none">×</button>
            </span>
          ))}
          <ProductSearchInput
            value={productQuery}
            onChange={setProductQuery}
            onSelect={addProduct}
            products={searchableProducts.filter(p => !selectedProducts.some(sp => sp.id === p.id))}
            placeholder={isEn ? 'Search by product name / Internal Reference' : '输入商品名 / Internal Reference 搜索'}
            inputClassName="border border-gray-300 rounded px-2 py-0.5 text-xs w-56 focus:outline-none focus:border-[#875A7B]"
            showOnEmptyQuery={false}
            showOnHandQuantity
            selectOnTab
          />
          {selectedProducts.length > 0 && (
            <button onClick={() => setSelectedProducts([])} className="text-xs text-gray-400 hover:text-gray-600">
              {isEn ? 'Clear' : '清除'}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 shrink-0">{isEn ? 'Order No.' : '订单号'}</span>
          <input
            type="text"
            value={orderQuery}
            onChange={e => setOrderQuery(e.target.value)}
            placeholder={isEn ? 'Search by order number' : '按订单号搜索'}
            className="border border-gray-300 rounded px-2 py-0.5 text-xs w-56 focus:outline-none focus:border-[#875A7B]"
          />
          {orderQuery.trim() !== '' && (
            <button onClick={() => setOrderQuery('')} className="text-xs text-gray-400 hover:text-gray-600">
              {isEn ? 'Clear' : '清除'}
            </button>
          )}
        </div>
      </div>

      {/* Lines table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {filteredLines.length === 0 ? (
          <div className="px-4 py-10 text-center text-gray-400 text-sm">
            {loading
              ? (isEn ? 'Loading...' : '加载中...')
              : selectedProducts.length === 0 && orderQuery.trim() === ''
                ? (isEn
                  ? 'Search and select out-of-stock products above (supports product name / Internal Reference), or search by order number; matching order lines for today will be shown'
                  : '请先在上方搜索并选择缺货商品（支持商品名 / Internal Reference），或直接按订单号搜索，显示当天匹配的订单行')
                : (isEn ? 'No matching order lines today' : '当天没有符合条件的订单行')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-3 py-2 text-center text-xs text-gray-400 font-medium w-8">
                    <input
                      type="checkbox"
                      checked={selectableLines.length > 0 && checked.size === selectableLines.length}
                      onChange={toggleAll}
                      title={isEn ? 'Select all' : '全选'}
                    />
                  </th>
                  <th className="px-3 py-2 text-left text-xs text-gray-400 font-medium">{isEn ? 'Order No.' : '单号'}</th>
                  <th className="px-3 py-2 text-left text-xs text-gray-400 font-medium">{isEn ? 'Customer' : '客户名'}</th>
                  <th className="px-3 py-2 text-left text-xs text-gray-400 font-medium">{isEn ? 'Product' : '产品名'}</th>
                  <th className="px-3 py-2 text-left text-xs text-gray-400 font-medium">{isEn ? 'Driver' : '司机'}</th>
                  <th className="px-3 py-2 text-left text-xs text-gray-400 font-medium">{isEn ? 'Time' : '时段'}</th>
                  <th className="px-3 py-2 text-right text-xs text-gray-400 font-medium">{isEn ? 'Original Qty' : '原始数量'}</th>
                  <th className="px-3 py-2 text-center text-xs text-gray-400 font-medium">{isEn ? 'Unit' : '单位'}</th>
                  <th className="px-3 py-2 text-center text-xs text-gray-400 font-medium">{isEn ? 'New Qty' : '新数量'}</th>
                  <th className="px-3 py-2 text-center text-xs text-gray-400 font-medium">{isEn ? 'Status' : '状态'}</th>
                </tr>
              </thead>
              <tbody>
                {filteredLines.map((l, i) => {
                  const status = getLineStatus(l.lineId)
                  return (
                    <tr
                      key={l.lineId}
                      className={`border-b border-gray-50 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'} hover:bg-purple-50/20`}
                    >
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={checked.has(l.lineId)}
                          onChange={() => toggleChecked(l.lineId)}
                          disabled={savedLineIds.has(l.lineId)}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-500">
                        {l.orderCode}
                        {l.locked && (
                          <span
                            className="ml-1 text-amber-600"
                            title={isEn
                              ? 'Batch locked for picking: reducing / removing is allowed (shortage), increasing needs unlocking first'
                              : '该批次拣货中已锁定：缺货减量、删行放行；加量需先解锁'}
                          >🔒</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-800 max-w-[130px] truncate" title={l.customerName}>{l.customerName}</td>
                      <td className="px-3 py-2 text-xs text-gray-800 max-w-[180px] truncate" title={l.productName}>{l.productName}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">{l.driverName ?? '—'}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {l.timeOfDay === 'am' ? 'AM' : l.timeOfDay === 'pm' ? 'PM' : '—'}
                      </td>
                      <td className="px-3 py-2 text-right text-xs font-medium text-gray-700">{l.orderedQty}</td>
                      <td className="px-3 py-2 text-center text-xs text-gray-500">{l.uomName ?? ''}</td>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={newQtys[l.lineId] ?? ''}
                          onChange={e => setNewQtys(prev => ({ ...prev, [l.lineId]: e.target.value }))}
                          placeholder={isEn ? 'No change' : '不改'}
                          className="w-20 border border-gray-300 rounded px-2 py-0.5 text-xs text-right focus:outline-none focus:border-[#875A7B]"
                        />
                      </td>
                      <td className="px-3 py-2 text-center text-xs">
                        {status === 'saved' && <span className="text-green-600 font-medium">{isEn ? 'Saved ✓' : '已保存 ✓'}</span>}
                        {status === 'pending' && <span className="text-amber-500">{isEn ? 'Pending' : '待保存'}</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* 批量填充 + 缺货原因：原因是必填项，写进操作记录与订单 chatter 两条轨迹 */}
        {filteredLines.length > 0 && (
          <div className="px-4 py-2 border-t border-gray-100 flex items-center gap-2 flex-wrap bg-white">
            <span className="text-xs text-gray-500">
              {isEn ? `Selected ${checked.size}` : `已勾选 ${checked.size} 行`}
            </span>
            <button
              onClick={() => applyBulkQty('0')}
              className="px-2 py-0.5 text-xs rounded border border-gray-300 text-gray-600 hover:border-[#875A7B] hover:text-[#875A7B]"
              title={isEn ? 'Fill 0 for the selected rows (fully out of stock)' : '把勾选行的新数量填成 0（整行缺货）'}
            >
              {isEn ? 'Set 0' : '批量设为 0'}
            </button>
            <input
              type="number"
              min="0"
              step="any"
              value={bulkQty}
              onChange={e => setBulkQty(e.target.value)}
              placeholder={isEn ? 'Qty' : '数量'}
              className="w-20 border border-gray-300 rounded px-2 py-0.5 text-xs text-right focus:outline-none focus:border-[#875A7B]"
            />
            <button
              onClick={() => bulkQty.trim() !== '' && applyBulkQty(bulkQty.trim())}
              disabled={bulkQty.trim() === ''}
              className="px-2 py-0.5 text-xs rounded border border-gray-300 text-gray-600 hover:border-[#875A7B] hover:text-[#875A7B] disabled:opacity-40"
            >
              {isEn ? 'Fill selected' : '批量填充'}
            </button>
            <span className="mx-1 h-4 w-px bg-gray-200" />
            <span className="text-xs text-gray-500">{isEn ? 'Reason' : '缺货原因'}</span>
            <select
              value={reasonCode}
              onChange={e => setReasonCode(e.target.value as ShortageReasonCode)}
              className="border border-gray-300 rounded px-2 py-0.5 text-xs focus:outline-none focus:border-[#875A7B]"
            >
              {SHORTAGE_REASON_CODES.map(c => (
                <option key={c} value={c}>{isEn ? SHORTAGE_REASON_LABELS[c].en : SHORTAGE_REASON_LABELS[c].zh}</option>
              ))}
            </select>
            <input
              value={reasonNote}
              onChange={e => setReasonNote(e.target.value)}
              placeholder={isEn ? 'Note (optional)' : '备注（选填）'}
              className="border border-gray-300 rounded px-2 py-0.5 text-xs w-48 focus:outline-none focus:border-[#875A7B]"
            />
          </div>
        )}

        <div className="px-4 py-3 border-t border-gray-100 flex items-center gap-3 flex-wrap bg-gray-50/50">
          <button
            onClick={() => submit('ADJUST')}
            disabled={saving || targetLines.length === 0}
            className="px-4 py-1.5 text-sm font-medium rounded bg-[#875A7B] text-white hover:bg-[#6d4764] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving
              ? (isEn ? 'Saving...' : '保存中...')
              : targetLines.length > 0
                ? (isEn ? `Save Changes (${targetLines.length})` : `保存修改（${targetLines.length} 条）`)
                : (isEn ? 'Save Changes' : '保存修改')}
          </button>
          <button
            onClick={() => submit('DEFER')}
            disabled={saving || targetLines.length === 0}
            title={isEn
              ? 'Today ships the new qty; the shortfall moves to a next-day draft order for the same customer'
              : '今日按新数量送，差额转到该客户次日的补送单（草稿状态，到货确认后才扣库存）'}
            className="px-4 py-1.5 text-sm font-medium rounded border border-amber-500 text-amber-700 hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving
              ? (isEn ? 'Working...' : '处理中...')
              : (isEn ? `Defer shortfall to next day (${targetLines.length})` : `转单到次日（${targetLines.length} 条）`)}
          </button>
          <button
            onClick={() => printOrders('delivery')}
            disabled={printableOrderCount === 0}
            className="px-4 py-1.5 text-sm font-medium rounded border border-[#875A7B] text-[#875A7B] hover:bg-[#f3edf7] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isEn ? 'Batch Print Updated Delivery Note' : '批量打印更新版 Delivery Note'}
            {printableOrderCount > 0 && (isEn ? ` (${printableOrderCount} orders)` : `（${printableOrderCount} 单）`)}
          </button>
          <button
            onClick={() => printOrders('sales')}
            disabled={printableOrderCount === 0}
            className="px-4 py-1.5 text-sm font-medium rounded border border-[#875A7B] text-[#875A7B] hover:bg-[#f3edf7] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isEn ? 'Batch Print Updated Sales Order' : '批量打印更新版 Sales Order'}
            {printableOrderCount > 0 && (isEn ? ` (${printableOrderCount} orders)` : `（${printableOrderCount} 单）`)}
          </button>
          {saveMsg && (
            <span className={`text-xs ${saveMsg.ok ? 'text-green-600' : 'text-red-600'}`}>
              {saveMsg.text}
            </span>
          )}
        </div>

        {deferInfo.length > 0 && (
          <div className="px-4 py-2 border-t border-gray-100 bg-amber-50/50 text-xs text-amber-800">
            {isEn ? 'Next-day draft orders created: ' : '已生成次日补送单：'}
            {deferInfo.map(d => `${d.code}（${d.date}）`).join('、')}
            {isEn ? ' — draft status, confirm them once the goods arrive' : ' —— 草稿状态，到货后确认才扣库存'}
          </div>
        )}

        {blockedRows.length > 0 && (
          <div className="px-4 py-2 border-t border-gray-100 bg-red-50/50">
            <div className="text-xs font-medium text-red-700 mb-1">
              {isEn ? `${blockedRows.length} rows were not applied:` : `${blockedRows.length} 条未生效：`}
            </div>
            <ul className="text-xs text-red-700 space-y-0.5">
              {blockedRows.map((b, i) => (
                <li key={i}><span className="font-mono">{b.orderCode}</span> · {b.message}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Operation history */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <button
          onClick={toggleHistory}
          className="w-full px-4 py-3 text-left flex items-center justify-between text-sm text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <span className="font-medium">{isEn ? 'Action Log (this delivery day)' : '操作记录（本配送日）'}</span>
          <span className="text-gray-400 text-xs">{historyOpen ? (isEn ? '▲ Collapse' : '▲ 收起') : (isEn ? '▼ Expand' : '▼ 展开')}</span>
        </button>
        {historyOpen && (
          <div className="border-t border-gray-100">
            {historyLoading ? (
              <div className="px-4 py-6 text-center text-xs text-gray-400">{isEn ? 'Loading...' : '加载中...'}</div>
            ) : history.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-gray-400">{isEn ? 'No shortage change records for this delivery day' : '该配送日暂无缺货改动记录'}</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-50 bg-gray-50">
                    <th className="px-3 py-2 text-left text-gray-400 font-medium">{isEn ? 'Time' : '时间'}</th>
                    <th className="px-3 py-2 text-left text-gray-400 font-medium">{isEn ? 'Order / Customer' : '订单 / 客户'}</th>
                    <th className="px-3 py-2 text-left text-gray-400 font-medium">{isEn ? 'Operator' : '操作人'}</th>
                    <th className="px-3 py-2 text-left text-gray-400 font-medium">{isEn ? 'Description' : '操作说明'}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(log => (
                    <tr key={log.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                        {formatDateTime(log.createdAt)}
                      </td>
                      <td className="px-3 py-2 max-w-[220px]">
                        {log.resourceId ? (() => {
                          const info = logOrderInfo.get(log.resourceId) ?? orderInfoMap.get(log.resourceId)
                          const code = info?.code ?? log.resourceId.slice(-6).toUpperCase()
                          return (
                            <a
                              href={`${prefix}/classic/operator/orders/${log.resourceId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#875A7B] hover:underline"
                              title={isEn ? `Open order detail: ${info?.customer ?? code}` : `打开订单详情：${info?.customer ?? code}`}
                            >
                              <span className="font-mono">{code}</span>
                              {info?.customer && <span className="text-gray-500"> · {info.customer}</span>}
                            </a>
                          )
                        })() : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600">{log.userName ?? log.userEmail ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-700">{log.detail ? translateLogDetail(log.detail, isEn) : log.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
      <PrintQueue jobs={printJobs} />
    </div>
  )
}
