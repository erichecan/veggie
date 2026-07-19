'use client'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet, apiPatch } from '@/lib/api'
import { formatDateTime } from '@/lib/format-date'
import type { Order } from '@/lib/types'
import type { DriverSlotInfo } from '@/lib/driver-slot'
import { today } from './shared'
import ProductSearchInput from '@/components/classic/ProductSearchInput'

// SSOT：订单归属司机/时段以 PickingWave.orderIds 为准（拖拽调度不回填 Order.driverSlotId），
// 与配送调度中心、打印中心口径一致；只看 Order.driverSlot 会漏掉只拖拽分配的司机。
interface Wave {
  orderIds: string[]
  driverSlotId: string | null
  driverName: string | null
}

interface ProductOption {
  id: string
  name: string
  internalRef?: string | null
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
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [newQtys, setNewQtys] = useState<Record<string, string>>({})
  const [savedLineIds, setSavedLineIds] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<ActionLog[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  // 操作记录引用的订单信息（订单号+客户名），按日志 resourceId 直接拉取，
  // 不依赖当天缺货订单列表，保证记录里一定能显示是哪个订单、并可点击进详情。
  const [logOrderInfo, setLogOrderInfo] = useState<Map<string, { customer: string; code: string }>>(new Map())

  const loadOrders = useCallback(() => {
    if (!date) return
    setLoading(true)
    setNewQtys({})
    setSavedLineIds(new Set())
    setSaveMsg(null)
    setSelectedDrivers([])
    Promise.all([
      apiGet<Order[]>(
        `/api/orders?include_lines=true&status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY&dateField=deliveryDate&fromDate=${date}&toDate=${date}`
      )
        .then(d => setOrders(Array.isArray(d) ? d : []))
        .catch(() => setOrders([])),
      apiGet<Wave[]>(`/api/waves?date=${date}`)
        .then(d => setWaves(Array.isArray(d) ? d : []))
        .catch(() => setWaves([])),
    ]).finally(() => setLoading(false))
  }, [date])

  useEffect(() => { loadOrders() }, [loadOrders])

  // 页头「刷新」：跳过首次挂载，之后 refreshKey 变化重拉当天缺货订单
  useEffect(() => {
    if (refreshKey === 0) return
    loadOrders()
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    apiGet<DriverSlotInfo[]>('/api/driver-slots')
      .then(d => setSlots(Array.isArray(d) ? d : []))
      .catch(() => setSlots([]))
  }, [])

  // orderId → 司机/时段（按 wave 归属，SSOT）；覆盖只拖拽分配、未回填 Order.driverSlotId 的订单
  const orderDriverMap = useMemo(() => {
    const slotMap = new Map(slots.map(s => [s.id, s]))
    const m = new Map<string, { driver: string | null; time: string | null }>()
    for (const w of waves) {
      const slot = w.driverSlotId ? slotMap.get(w.driverSlotId) : undefined
      const driver = slot?.driverName ?? w.driverName ?? null
      const time = slot?.timeOfDay ? slot.timeOfDay.toLowerCase() : null
      for (const id of w.orderIds) {
        if (!m.has(id)) m.set(id, { driver, time })
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
      if (!map.has(l.productId)) map.set(l.productId, { id: l.productId, name: l.productName })
    }
    return Array.from(map.values())
  }, [allLines])

  const availableDrivers = useMemo(() => {
    const set = new Set<string>()
    for (const l of allLines) {
      if (l.driverName) set.add(l.driverName)
    }
    return Array.from(set).sort()
  }, [allLines])

  // 缺货商品由仓库报上来，必须先搜索选中商品才展示对应订单行
  // allLines 已按 orderId+productId 合并去重，这里只需按条件过滤
  const filteredLines = useMemo(() => {
    if (selectedProducts.length === 0) return []
    return allLines.filter(l => {
      if (timeFilter !== 'all' && l.timeOfDay !== timeFilter) return false
      if (selectedDrivers.length > 0 && (!l.driverName || !selectedDrivers.includes(l.driverName))) return false
      if (!selectedProducts.some(p => p.id === l.productId)) return false
      return true
    })
  }, [allLines, timeFilter, selectedDrivers, selectedProducts])

  // 已保存成功的行要排除在外，否则 newQtys 里的旧值会在下次点「保存修改」时被重新提交一遍
  // （若该行当时是清零删行，重复提交会因行已不存在而报错，污染这次保存的失败计数）
  const modifiedLines = useMemo(
    () => filteredLines.filter(l => !savedLineIds.has(l.lineId) && (newQtys[l.lineId]?.trim() ?? '') !== ''),
    [filteredLines, newQtys, savedLineIds]
  )

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

  async function handleSave() {
    if (modifiedLines.length === 0) return
    setSaving(true)
    setSaveMsg(null)
    const newSaved = new Set(savedLineIds)
    const newQtysAfter = { ...newQtys }
    let successCount = 0
    let failCount = 0
    let firstErrorMsg: string | null = null
    for (const l of modifiedLines) {
      const newQty = Number(newQtys[l.lineId]!.trim())
      if (!Number.isFinite(newQty) || newQty < 0) { failCount++; continue }
      try {
        await apiPatch(`/api/orders/${l.orderId}/lines/${l.lineId}`, { newQty })
        newSaved.add(l.lineId)
        delete newQtysAfter[l.lineId]
        successCount++
      } catch (e) {
        failCount++
        if (!firstErrorMsg) firstErrorMsg = e instanceof Error ? e.message : null
      }
    }
    setSavedLineIds(newSaved)
    setNewQtys(newQtysAfter)
    setSaving(false)
    setSaveMsg({
      ok: failCount === 0,
      text: failCount === 0
        ? (isEn ? `${successCount} saved` : `${successCount} 条已保存`)
        : (isEn
          ? `${successCount} succeeded, ${failCount} failed${firstErrorMsg ? `: ${firstErrorMsg}` : ''}`
          : `${successCount} 条成功，${failCount} 条失败${firstErrorMsg ? `：${firstErrorMsg}` : ''}`),
    })
  }

  function handlePrint() {
    // 一次点击里连开多个 window.open 会被浏览器弹窗拦截器拦掉，只剩第一个，
    // 所以改成单个 window.open 打开批量打印页，一份文档内按订单分页打印全部
    const orderIds = [...new Set(
      filteredLines.filter(l => savedLineIds.has(l.lineId)).map(l => l.orderId)
    )]
    if (orderIds.length === 0) return
    // noopener：切断与本页的 opener 关系，避免打印页里的 window.print() 连带把本页卡住
    const win = window.open(`${prefix}/classic/print/batch?ids=${orderIds.join(',')}&doc=delivery`, '_blank', 'noopener,noreferrer')
    if (!win) {
      setSaveMsg({ ok: false, text: isEn ? 'Browser blocked the popup window, please allow popups and retry' : '浏览器拦截了弹出窗口，请允许弹窗后重试' })
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
      {/* Filter bar */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">{isEn ? 'Delivery Date' : '配送日期'}</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
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
            selectOnTab
          />
          {selectedProducts.length > 0 && (
            <button onClick={() => setSelectedProducts([])} className="text-xs text-gray-400 hover:text-gray-600">
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
              : selectedProducts.length === 0
                ? (isEn
                  ? 'Search and select out-of-stock products above (supports product name / Internal Reference); once selected, order lines for that product today will be shown'
                  : '请先在上方搜索并选择缺货商品（支持商品名 / Internal Reference），选中后显示当天订购该商品的订单行')
                : (isEn ? 'No order lines for the selected products today' : '当天没有订购所选商品的订单行')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
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
                      <td className="px-3 py-2 font-mono text-xs text-gray-500">{l.orderCode}</td>
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

        <div className="px-4 py-3 border-t border-gray-100 flex items-center gap-3 flex-wrap bg-gray-50/50">
          <button
            onClick={handleSave}
            disabled={saving || modifiedLines.length === 0}
            className="px-4 py-1.5 text-sm font-medium rounded bg-[#875A7B] text-white hover:bg-[#6d4764] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving
              ? (isEn ? 'Saving...' : '保存中...')
              : modifiedLines.length > 0
                ? (isEn ? `Save Changes (${modifiedLines.length})` : `保存修改（${modifiedLines.length} 条）`)
                : (isEn ? 'Save Changes' : '保存修改')}
          </button>
          <button
            onClick={handlePrint}
            disabled={printableOrderCount === 0}
            className="px-4 py-1.5 text-sm font-medium rounded border border-[#875A7B] text-[#875A7B] hover:bg-[#f3edf7] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isEn ? 'Batch Print Updated Delivery Note' : '批量打印更新版 Delivery Note'}
            {printableOrderCount > 0 && (isEn ? ` (${printableOrderCount} orders)` : `（${printableOrderCount} 单）`)}
          </button>
          {saveMsg && (
            <span className={`text-xs ${saveMsg.ok ? 'text-green-600' : 'text-red-600'}`}>
              {saveMsg.text}
            </span>
          )}
        </div>
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
    </div>
  )
}
