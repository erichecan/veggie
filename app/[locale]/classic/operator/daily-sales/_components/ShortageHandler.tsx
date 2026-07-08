'use client'
import { useState, useEffect, useMemo } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet, apiPatch } from '@/lib/api'
import type { Order } from '@/lib/types'
import { today } from './shared'
import ProductSearchInput from '@/components/classic/ProductSearchInput'

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

interface ActionLog {
  id: string
  userName: string | null
  userEmail: string | null
  action: string
  resourceId: string | null
  detail: string | null
  createdAt: string
}

export default function ShortageHandler() {
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [date, setDate] = useState(today)
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all')
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>([])
  const [allProducts, setAllProducts] = useState<ProductOption[]>([])
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

  useEffect(() => {
    if (!date) return
    setLoading(true)
    setNewQtys({})
    setSavedLineIds(new Set())
    setSaveMsg(null)
    setSelectedDrivers([])
    apiGet<Order[]>(
      `/api/orders?include_lines=true&status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY&dateField=deliveryDate&fromDate=${date}&toDate=${date}`
    )
      .then(d => setOrders(Array.isArray(d) ? d : []))
      .catch(() => setOrders([]))
      .finally(() => setLoading(false))
  }, [date])

  useEffect(() => {
    apiGet<ProductOption[]>('/api/products?limit=500')
      .then(d => setAllProducts(Array.isArray(d) ? d : []))
      .catch(() => setAllProducts([]))
  }, [])

  const allLines: FlatLine[] = useMemo(() => {
    // 同一订单可能有多条含相同商品的行（如重复录入），按 orderId+productId 合并，避免同一订单号在表格中重复出现
    const map = new Map<string, FlatLine>()
    for (const o of orders) {
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
          driverName: o.driverSlot?.driverName ?? null,
          timeOfDay: o.driverSlot?.timeOfDay?.toLowerCase() ?? null,
          orderedQty: Number(l.orderedQty),
        })
      }
    }
    return Array.from(map.values())
  }, [orders])

  // 操作记录里只有订单 id（ActionLog.resourceId），客户名/订单号靠当天订单映射补上，
  // 并把 resourceId 直接当作订单 id 链到订单详情（新标签打开）。
  const orderInfoMap = useMemo(() => {
    const m = new Map<string, { customer: string; code: string }>()
    for (const o of orders) m.set(o.id, { customer: o.restaurantName, code: o.code ?? o.id.slice(-6).toUpperCase() })
    return m
  }, [orders])

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

  const modifiedLines = useMemo(
    () => filteredLines.filter(l => (newQtys[l.lineId]?.trim() ?? '') !== ''),
    [filteredLines, newQtys]
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
    let successCount = 0
    let failCount = 0
    for (const l of modifiedLines) {
      const newQty = Number(newQtys[l.lineId]!.trim())
      if (!Number.isFinite(newQty) || newQty < 0) { failCount++; continue }
      try {
        await apiPatch(`/api/orders/${l.orderId}/lines/${l.lineId}`, { newQty })
        newSaved.add(l.lineId)
        successCount++
      } catch {
        failCount++
      }
    }
    setSavedLineIds(newSaved)
    setSaving(false)
    setSaveMsg({
      ok: failCount === 0,
      text: failCount === 0
        ? `${successCount} 条已保存`
        : `${successCount} 条成功，${failCount} 条失败`,
    })
  }

  function handlePrint() {
    // 一次点击里连开多个 window.open 会被浏览器弹窗拦截器拦掉，只剩第一个，
    // 所以改成单个 window.open 打开批量打印页，一份文档内按订单分页打印全部
    const orderIds = [...new Set(
      filteredLines.filter(l => savedLineIds.has(l.lineId)).map(l => l.orderId)
    )]
    if (orderIds.length === 0) return
    window.open(`${prefix}/classic/print/batch?ids=${orderIds.join(',')}&doc=delivery`, '_blank')
  }

  async function loadHistory() {
    setHistoryLoading(true)
    try {
      const res = await apiGet<{ logs: ActionLog[] } | ActionLog[]>('/api/action-logs?resource=order&take=100')
      const logs: ActionLog[] = Array.isArray(res) ? res : (res as { logs: ActionLog[] }).logs ?? []
      // 只显示缺货处理产生的记录（行数量修改/删行），其余订单操作日志不属于本页
      const filtered = logs.filter(log =>
        log.createdAt.startsWith(date) &&
        (log.detail?.startsWith('修改订单行数量') || log.detail?.startsWith('删除订单行'))
      )
      setHistory(filtered)
      // 按记录里的订单 id 补齐订单号+客户名（这些订单可能不在当天缺货列表里）
      const ids = Array.from(new Set(filtered.map(l => l.resourceId).filter((v): v is string => !!v)))
      if (ids.length > 0) {
        try {
          const ords = await apiGet<Array<{ id: string; code?: string | null; restaurantName?: string | null }>>(
            `/api/orders?ids=${ids.join(',')}`
          )
          const m = new Map<string, { customer: string; code: string }>()
          for (const o of Array.isArray(ords) ? ords : []) {
            m.set(o.id, { customer: o.restaurantName ?? '', code: o.code ?? o.id.slice(-6).toUpperCase() })
          }
          setLogOrderInfo(m)
        } catch {
          setLogOrderInfo(new Map())
        }
      } else {
        setLogOrderInfo(new Map())
      }
    } catch {
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }

  function toggleHistory() {
    if (!historyOpen) loadHistory()
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
            <label className="text-xs text-gray-500">配送日期</label>
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
                {t === 'all' ? '全部' : t.toUpperCase()}
              </button>
            ))}
          </div>
          <span className="text-xs text-gray-400">
            {loading
              ? '加载中...'
              : selectedProducts.length === 0
                ? `当天共 ${allLines.length} 行，先选择商品`
                : `${filteredLines.length} / ${allLines.length} 行`}
          </span>
        </div>

        {availableDrivers.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500 shrink-0">司机</span>
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
                清除
              </button>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 shrink-0">商品</span>
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
            products={allProducts.filter(p => !selectedProducts.some(sp => sp.id === p.id))}
            placeholder="输入商品名 / Internal Reference 搜索"
            inputClassName="border border-gray-300 rounded px-2 py-0.5 text-xs w-56 focus:outline-none focus:border-[#875A7B]"
            showOnEmptyQuery={false}
            selectOnTab
          />
          {selectedProducts.length > 0 && (
            <button onClick={() => setSelectedProducts([])} className="text-xs text-gray-400 hover:text-gray-600">
              清除
            </button>
          )}
        </div>
      </div>

      {/* Lines table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {filteredLines.length === 0 ? (
          <div className="px-4 py-10 text-center text-gray-400 text-sm">
            {loading
              ? '加载中...'
              : selectedProducts.length === 0
                ? '请先在上方搜索并选择缺货商品（支持商品名 / Internal Reference），选中后显示当天订购该商品的订单行'
                : '当天没有订购所选商品的订单行'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-3 py-2 text-left text-xs text-gray-400 font-medium">单号</th>
                  <th className="px-3 py-2 text-left text-xs text-gray-400 font-medium">客户名</th>
                  <th className="px-3 py-2 text-left text-xs text-gray-400 font-medium">产品名</th>
                  <th className="px-3 py-2 text-left text-xs text-gray-400 font-medium">司机</th>
                  <th className="px-3 py-2 text-left text-xs text-gray-400 font-medium">时段</th>
                  <th className="px-3 py-2 text-right text-xs text-gray-400 font-medium">原始数量</th>
                  <th className="px-3 py-2 text-center text-xs text-gray-400 font-medium">单位</th>
                  <th className="px-3 py-2 text-center text-xs text-gray-400 font-medium">新数量</th>
                  <th className="px-3 py-2 text-center text-xs text-gray-400 font-medium">状态</th>
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
                          placeholder="不改"
                          className="w-20 border border-gray-300 rounded px-2 py-0.5 text-xs text-right focus:outline-none focus:border-[#875A7B]"
                        />
                      </td>
                      <td className="px-3 py-2 text-center text-xs">
                        {status === 'saved' && <span className="text-green-600 font-medium">已保存 ✓</span>}
                        {status === 'pending' && <span className="text-amber-500">待保存</span>}
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
              ? '保存中...'
              : modifiedLines.length > 0
                ? `保存修改（${modifiedLines.length} 条）`
                : '保存修改'}
          </button>
          <button
            onClick={handlePrint}
            disabled={printableOrderCount === 0}
            className="px-4 py-1.5 text-sm font-medium rounded border border-[#875A7B] text-[#875A7B] hover:bg-[#f3edf7] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            批量打印更新版 Delivery Note
            {printableOrderCount > 0 && `（${printableOrderCount} 单）`}
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
          <span className="font-medium">操作记录（今日）</span>
          <span className="text-gray-400 text-xs">{historyOpen ? '▲ 收起' : '▼ 展开'}</span>
        </button>
        {historyOpen && (
          <div className="border-t border-gray-100">
            {historyLoading ? (
              <div className="px-4 py-6 text-center text-xs text-gray-400">加载中...</div>
            ) : history.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-gray-400">今日暂无操作记录</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-50 bg-gray-50">
                    <th className="px-3 py-2 text-left text-gray-400 font-medium">时间</th>
                    <th className="px-3 py-2 text-left text-gray-400 font-medium">订单 / 客户</th>
                    <th className="px-3 py-2 text-left text-gray-400 font-medium">操作人</th>
                    <th className="px-3 py-2 text-left text-gray-400 font-medium">操作说明</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(log => (
                    <tr key={log.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString('zh-CN', {
                          year: 'numeric', month: '2-digit', day: '2-digit',
                          hour: '2-digit', minute: '2-digit', second: '2-digit',
                          hour12: false,
                        })}
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
                              title={`打开订单详情：${info?.customer ?? code}`}
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
                      <td className="px-3 py-2 text-gray-700">{log.detail ?? log.action}</td>
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
