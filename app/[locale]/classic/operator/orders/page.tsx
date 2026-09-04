'use client'
import { useState, useEffect, useMemo, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import type { Order, OrderStatus, Invoice } from '@/lib/types'
import { displayOrderCode } from '@/lib/order-code'
import { DateWithDay } from '@/components/shared/date-with-day'
import { formatDateTimeShort } from '@/lib/format-date'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { Pagination } from '@/components/ui/pagination'
import { useServerList } from '@/hooks/use-server-list'
import { formatDriverSlotFromOrder, type DriverSlotInfo } from '@/lib/driver-slot'
import { DriverSlotCombobox } from '@/components/shared/driver-slot-combobox'
import { getSession } from '@/lib/session'
import { type Facet, ORDER_FACET_FIELDS, applyFacets, localizeFacetFields, TIME_QUICK_OPTIONS, TIME_QUICK_LABEL, computeTimeRange, groupFacets } from '@/lib/list-filters'
import { downloadAuthedFile } from '@/lib/print/open-pdf'

const PAGE_SIZE = 50

const STATUS_LABEL_ZH: Record<OrderStatus, string> = {
  pending:       '待处理',
  confirmed:     '已确认',
  wave_assigned: '司机分配结束',
  in_delivery:   '配送中',
  completed:     '已完成',
  locked:        '拣货中',
  cancelled:     '已取消',
}

const STATUS_LABEL_EN: Record<OrderStatus, string> = {
  pending:       'Pending',
  confirmed:     'Confirmed',
  wave_assigned: 'Driver Assigned',
  in_delivery:   'In Delivery',
  completed:     'Completed',
  locked:        'Picking',
  cancelled:     'Cancelled',
}

const STATUS_COLOR: Record<OrderStatus, string> = {
  pending:       'bg-yellow-50 text-yellow-700',
  confirmed:     'bg-blue-50 text-blue-700',
  wave_assigned: 'bg-blue-50 text-blue-700',
  in_delivery:   'bg-purple-50 text-purple-700',
  completed:     'bg-green-50 text-green-700',
  locked:        'bg-gray-200 text-gray-700',
  cancelled:     'bg-red-50 text-red-600',
}

type ActiveFilter = 'all' | 'to_invoice' | OrderStatus

type ColFilters = {
  code: string
  deliveryDateFrom: string
  deliveryDateTo: string
  customer: string
  salesman: string
  deliveryBatch: string
  invoiceStatus: string
  status: string
  createdAtFrom: string
  createdAtTo: string
}

const EMPTY_FILTERS: ColFilters = {
  code: '', deliveryDateFrom: '', deliveryDateTo: '',
  customer: '', salesman: '', deliveryBatch: '',
  invoiceStatus: '', status: '', createdAtFrom: '', createdAtTo: '',
}

function normalizeStatus(s: string | null | undefined): OrderStatus {
  if (!s) return 'pending'
  return s.toLowerCase() as OrderStatus
}

function DateCell({ iso }: { iso: string | null | undefined }) {
  return (
    <span title={formatDateTimeShort(iso)}>
      <DateWithDay date={iso} />
    </span>
  )
}

function getField(o: Order, key: string): string {
  return String((o as unknown as Record<string, unknown>)[key] ?? '')
}

function invoiceStatusFor(o: Order, invoicedIds: Set<string>): string {
  if (invoicedIds.has(o.id)) return 'invoiced'
  if (o.status === 'completed') return 'to_invoice'
  return 'nothing'
}

export default function ClassicOrdersPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale
  const STATUS_LABEL = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH

  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('all')
  const [colFilters, setColFilters] = useState<ColFilters>(EMPTY_FILTERS)
  // code/customer/salesman/driver 列筛选框下推到服务端查询(见 baseUrl),防抖 400ms 避免逐字符触发请求
  const [debouncedColText, setDebouncedColText] = useState({ code: '', customer: '', salesman: '', driver: '' })
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedColText({ code: colFilters.code, customer: colFilters.customer, salesman: colFilters.salesman, driver: colFilters.deliveryBatch })
    }, 400)
    return () => clearTimeout(t)
  }, [colFilters.code, colFilters.customer, colFilters.salesman, colFilters.deliveryBatch])
  // 分面搜索 + 快捷筛选(My / 时间)
  const [facets, setFacets] = useState<Facet[]>([])
  const [myActive, setMyActive] = useState(false)
  const [timeKey, setTimeKey] = useState('')
  const currentUser = useMemo(() => getSession(), [])
  const [showFiltersBar, setShowFiltersBar] = useState(true)
  const [sortField, setSortField] = useState('createdAt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [generatingWave, setGeneratingWave] = useState(false)
  const [isReadMode, setIsReadMode] = useState(true)
  const [editBatchId, setEditBatchId] = useState<string | null>(null)
  const [editBatchVal, setEditBatchVal] = useState('')
  // 编辑模式下司机批次的本地暂存(orderId → slotId,'' 为取消分配),点「保存」统一提交
  const [pendingBatch, setPendingBatch] = useState<Record<string, string>>({})
  const [savingBatch, setSavingBatch] = useState(false)
  const [driverSlots, setDriverSlots] = useState<DriverSlotInfo[]>([])

  useEffect(() => {
    apiGet<DriverSlotInfo[]>('/api/driver-slots').then(d => setDriverSlots(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])
  const [groupBy, setGroupBy] = useState('')

  // Build status param from active filter — changes trigger server refetch via useServerList
  const statusParam = useMemo(() => {
    if (activeFilter === 'to_invoice') return 'COMPLETED'
    if (activeFilter === 'all') return 'CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY,COMPLETED'
    return activeFilter.toUpperCase()
  }, [activeFilter])

  // 交货日期/列筛选/排序均下推到服务端:任一变化即触发 useServerList 重查(回第 1 页),
  // 避免"只筛/只排当前页"——匹配记录不在当前页时被误判为空,或翻页后排序断档(客户反馈)
  const baseUrl = useMemo(() => {
    const params = new URLSearchParams({ status: statusParam, include_lines: 'false' })
    // 交货日期过滤走服务端分页分支认的参数:dateField=deliveryDate + fromDate/toDate
    if (colFilters.deliveryDateFrom || colFilters.deliveryDateTo) {
      params.set('dateField', 'deliveryDate')
      if (colFilters.deliveryDateFrom) params.set('fromDate', colFilters.deliveryDateFrom)
      if (colFilters.deliveryDateTo) params.set('toDate', colFilters.deliveryDateTo)
    }
    // 单号/客户/销售员/司机列筛选框(与分面 chip 独立,AND 语义) → colCode/colCustomer/colSalesman/colDriver
    if (debouncedColText.code) params.set('colCode', debouncedColText.code)
    if (debouncedColText.customer) params.set('colCustomer', debouncedColText.customer)
    if (debouncedColText.salesman) params.set('colSalesman', debouncedColText.salesman)
    if (debouncedColText.driver) params.set('colDriver', debouncedColText.driver)
    // 表头排序 — deliveryBatch/司机列虽是 wave 派生展示字段,服务端也已改成整表内存排序后再切页
    // (见 /api/orders 的 sortField===deliveryBatch 分支),这里不再排除,统一下推
    params.set('sortField', sortField)
    params.set('sortDir', sortDir)
    // 分面聚焦搜索 → f_* / search
    applyFacets(params, facets)
    // My Sales Order → 按当前登录用户(业务员)过滤
    if (myActive && currentUser?.userId) params.set('salesUserId', currentUser.userId)
    // 时间快捷(Today/This Week…) → deliveryFrom/deliveryTo(按交货日期，与第二列/交货日期列筛口径一致)
    const range = timeKey ? computeTimeRange(timeKey) : null
    if (range) { params.set('deliveryFrom', range.from); params.set('deliveryTo', range.to) }
    return `/api/orders?${params.toString()}`
  }, [statusParam, colFilters.deliveryDateFrom, colFilters.deliveryDateTo, debouncedColText, sortField, sortDir, facets, myActive, currentUser, timeKey])

  // 会计导出:跟列表当前筛选结果(baseUrl)完全同一套参数,只是换个路由+加 kind
  const [exporting, setExporting] = useState<'summary' | 'detail' | null>(null)
  async function exportCsv(kind: 'summary' | 'detail') {
    if (exporting) return
    setExporting(kind)
    try {
      const url = baseUrl.replace('/api/orders?', `/api/orders/export-csv?kind=${kind}&`)
      await downloadAuthedFile(url, isEn ? `orders-${kind}.csv` : `订单${kind === 'summary' ? '汇总' : '明细'}.csv`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Export failed' : '导出失败'))
    } finally {
      setExporting(null)
    }
  }

  const {
    data: rawOrders,
    total,
    page,
    pageSize,
    totalPages,
    loading,
    setPage,
    setPageSize,
    setSearch: setServerSearch,
    search,
    refresh,
  } = useServerList<Record<string, unknown>>({ url: baseUrl, pageSize: PAGE_SIZE })

  const orders = useMemo(() =>
    rawOrders.map(o => ({
      ...(o as unknown as Order),
      status: normalizeStatus(o.status as string | null | undefined),
    })),
    [rawOrders],
  )

  // 只查当前这一页订单的开票状态。以前是 `/api/invoices?slim=1` 全表扫 148,285 张
  // （3.2 MB / 2.5 秒），只为给列表打「已开票」标记 —— 而列表本来就只显示 PAGE_SIZE 条。
  const pageOrderIds = useMemo(() => orders.map(o => o.id).join(','), [orders])

  useEffect(() => {
    if (!pageOrderIds) { setInvoices([]); return }
    let cancelled = false
    apiGet<Invoice[]>(`/api/invoices?slim=1&orderIds=${encodeURIComponent(pageOrderIds)}`)
      .catch(() => [] as Invoice[])
      .then(rows => { if (!cancelled) setInvoices(rows) })
    return () => { cancelled = true }
  }, [pageOrderIds])

  const invoicedOrderIds = useMemo(() => new Set(invoices.flatMap(inv => inv.saleOrderIds)), [invoices])

  function setCf(key: keyof ColFilters, value: string) {
    setColFilters(prev => ({ ...prev, [key]: value }))
  }

  function addFacet(key: string, value: string) {
    const field = ORDER_FACET_FIELDS.find(f => f.key === key)
    if (!field) return
    // 同一维度可累积多个关键词(后端 buildFacetWhere 组成 OR)；不同维度之间 AND
    setFacets(prev => [...prev, { key, label: field.label, value }])
  }
  function removeFacet(idx: number) {
    setFacets(prev => prev.filter((_, i) => i !== idx))
  }
  function removeFacetGroup(key: string) {
    setFacets(prev => prev.filter(f => f.key !== key))
  }
  function facetChipLabel(f: Facet) {
    return f.key === 'all' ? f.value : `${f.label}: ${f.value}`
  }

  // Client-side column filters applied to current page data
  const filtered = useMemo(() => {
    let result = [...orders]

    if (activeFilter === 'to_invoice') {
      result = result.filter(o => !invoicedOrderIds.has(o.id))
    }

    const cf = colFilters
    // 交货日期/单号/客户/销售员/司机已由服务端过滤(见 baseUrl),此处不再客户端二次筛选,
    // 避免"只筛当前页导致可见行数与分页总数对不上"(客户反馈:同一关键词每次搜到的页数/条数都不一样)
    if (cf.invoiceStatus) result = result.filter(o => invoiceStatusFor(o, invoicedOrderIds) === cf.invoiceStatus)
    if (cf.status) result = result.filter(o => o.status === cf.status)
    if (cf.createdAtFrom) result = result.filter(o => (o.createdAt ?? '').slice(0, 10) >= cf.createdAtFrom)
    if (cf.createdAtTo)   result = result.filter(o => (o.createdAt ?? '').slice(0, 10) <= cf.createdAtTo)

    return result
  }, [orders, activeFilter, invoicedOrderIds, colFilters])

  // 排序(含 deliveryBatch/司机列)已下推服务端(见 baseUrl),数据到手时已是全局排好序的当页
  // 切片,不再客户端二次排序。
  const sorted = filtered

  // 选择司机批次只做本地暂存,不触发保存/刷新,避免打断连续编辑
  function stageBatch(orderId: string, slotId: string, originalSlotId: string) {
    setPendingBatch(prev => {
      if (slotId === originalSlotId) {
        const next = { ...prev }
        delete next[orderId]
        return next
      }
      return { ...prev, [orderId]: slotId }
    })
    setEditBatchId(null)
  }

  const pendingCount = Object.keys(pendingBatch).length

  async function saveAllBatches() {
    const entries = Object.entries(pendingBatch)
    if (entries.length === 0 || savingBatch) return
    setSavingBatch(true)
    const failed: string[] = []
    const failMessages = new Set<string>()
    await Promise.all(entries.map(async ([orderId, slotId]) => {
      try {
        await apiPut(`/api/orders/${orderId}/batch`, { driverSlotId: slotId || null })
      } catch (e) {
        failed.push(orderId)
        failMessages.add(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
      }
    }))
    setSavingBatch(false)
    if (failed.length === 0) {
      toast.success(isEn ? `Saved driver batch for ${entries.length} orders` : `已保存 ${entries.length} 个订单的司机批次`)
      setPendingBatch({})
    } else {
      // 失败原因一致（如批次已锁定）时直接显示具体原因，而非笼统的"N 个失败"
      const detail = failMessages.size === 1 ? [...failMessages][0] : (isEn ? `${failed.length} orders failed to save` : `${failed.length} 个订单保存失败`)
      toast.error(isEn ? `${detail}, kept for retry` : `${detail},已保留待重试`)
      setPendingBatch(prev => {
        const next: Record<string, string> = {}
        for (const id of failed) if (id in prev) next[id] = prev[id]
        return next
      })
    }
    refresh()
  }

  function exitEditMode() {
    if (pendingCount > 0 && !confirm(isEn
      ? `${pendingCount} unsaved driver batch changes will be discarded. Exit edit mode?`
      : `有 ${pendingCount} 项未保存的司机批次修改,放弃并退出编辑?`)) return
    setIsReadMode(true)
    setEditBatchId(null)
    setPendingBatch({})
  }

  async function generateBatchWave() {
    if (generatingWave) return
    // check status only against current page orders
    const confirmedIds = Array.from(selected).filter(id => orders.find(x => x.id === id)?.status === 'confirmed')
    if (confirmedIds.length === 0) { toast.error(isEn ? 'Please select confirmed sales orders first' : '请先选择已确认的销售单'); return }
    setGeneratingWave(true)
    try {
      // waves POST 已在事务内原子回写订单状态(CONFIRMED→WAVE_ASSIGNED)，无需再逐个 PUT。
      await apiPost('/api/waves', { orderIds: confirmedIds, status: 'PENDING' })
      toast.success(isEn ? `Pick wave generated with ${confirmedIds.length} orders` : `拣货波次已生成，包含 ${confirmedIds.length} 张订单`)
      setSelected(new Set())
      // 分配统一在「配送调度中心」进行（波次管理列表页已废弃）。
      router.push(`${prefix}/classic/operator/dispatch-console`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Generation failed' : '生成失败'))
    } finally {
      setGeneratingWave(false)
    }
  }

  const allSelected = sorted.length > 0 && sorted.every(o => selected.has(o.id))
  function toggleAll() {
    if (allSelected) setSelected(prev => { const n = new Set(prev); sorted.forEach(o => n.delete(o.id)); return n })
    else setSelected(prev => { const n = new Set(prev); sorted.forEach(o => n.add(o.id)); return n })
  }

  const selectedConfirmedCount = Array.from(selected).filter(id => orders.find(x => x.id === id)?.status === 'confirmed').length

  const inputCls = 'w-full border border-gray-300 rounded bg-white text-xs px-1.5 py-0.5 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-200'
  const selectCls = 'w-full border border-gray-300 rounded bg-white text-xs px-1.5 py-0.5 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-200'

  function filterRow() {
    const dateLabelCell = (fromKey: keyof ColFilters, toKey: keyof ColFilters) => (
      <td className="px-2 py-1 align-top">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-400 w-9">From:</span>
          <input type="date" value={colFilters[fromKey]} onChange={e => setCf(fromKey, e.target.value)} className={inputCls} />
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          <span className="text-[10px] text-gray-400 w-9">To:</span>
          <input type="date" value={colFilters[toKey]} onChange={e => setCf(toKey, e.target.value)} className={inputCls} />
        </div>
      </td>
    )
    return (
      <tr className="bg-white text-gray-500 border-b border-gray-200">
        <td className="pl-3 pr-1 py-1 text-gray-300">✎</td>
        <td className="px-2 py-1"><input value={colFilters.code}         onChange={e => setCf('code', e.target.value)}         className={inputCls} /></td>
        {dateLabelCell('deliveryDateFrom', 'deliveryDateTo')}
        <td className="px-2 py-1"><input value={colFilters.customer}     onChange={e => setCf('customer', e.target.value)}     className={inputCls} /></td>
        <td className="px-2 py-1"><input value={colFilters.deliveryBatch} onChange={e => setCf('deliveryBatch', e.target.value)} className={inputCls} /></td>
        <td className="px-2 py-1" />
        <td className="px-2 py-1">
          <select value={colFilters.status} onChange={e => setCf('status', e.target.value)} className={selectCls}>
            <option value=""></option>
            <option value="confirmed">{STATUS_LABEL.confirmed}</option>
            <option value="wave_assigned">{STATUS_LABEL.wave_assigned}</option>
            <option value="in_delivery">{STATUS_LABEL.in_delivery}</option>
            <option value="locked">{STATUS_LABEL.locked}</option>
            <option value="completed">{STATUS_LABEL.completed}</option>
            <option value="cancelled">{STATUS_LABEL.cancelled}</option>
          </select>
        </td>
        <td className="px-2 py-1" />
        <td className="px-2 py-1"><input value={colFilters.salesman}     onChange={e => setCf('salesman', e.target.value)}     className={inputCls} /></td>
        <td className="px-2 py-1" />
      </tr>
    )
  }

  function renderRow(o: Order) {
    const isSelected = selected.has(o.id)

    return (
      <tr
        className={`border-b border-gray-100 cursor-pointer transition-colors ${isSelected ? 'bg-amber-50' : 'hover:bg-gray-50'}`}
        onClick={() => router.push(`${prefix}/classic/operator/orders/${o.id}`)}
      >
        <td className="pl-3 pr-1 py-2" onClick={e => e.stopPropagation()}>
          <input type="checkbox" checked={isSelected}
            onChange={() => setSelected(prev => { const n = new Set(prev); isSelected ? n.delete(o.id) : n.add(o.id); return n })}
            className="w-3.5 h-3.5 accent-purple-600 cursor-pointer" />
        </td>
        <td className="px-2 py-2 whitespace-nowrap">
          <span className="text-sm" style={{ color: '#875A7B' }}>{displayOrderCode(o)}</span>
        </td>
        <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap">{o.deliveryDate ? <DateCell iso={o.deliveryDate} /> : <span className="text-gray-300">—</span>}</td>
        <td className="px-2 py-2 text-sm text-gray-800 max-w-[180px] truncate">{o.restaurantName}</td>
        <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap" onClick={e => e.stopPropagation()}>
          {(() => {
            const originalSlotId = (o as unknown as { assignedDriverSlotId?: string }).assignedDriverSlotId ?? ''
            const pendingVal = pendingBatch[o.id]
            const hasPending = pendingVal !== undefined
            const slotLabel = (id: string) => {
              const s = driverSlots.find(x => x.id === id)
              return s ? `${s.batchNum} ${s.timeOfDay} ${s.driverName}` : ''
            }
            const display = hasPending ? slotLabel(pendingVal) : formatDriverSlotFromOrder(o)
            if (!isReadMode && editBatchId === o.id) {
              return (
                <DriverSlotCombobox
                  slots={driverSlots}
                  value={editBatchVal}
                  onSelect={slotId => { setEditBatchVal(slotId); stageBatch(o.id, slotId, originalSlotId); setEditBatchId(null) }}
                  onClose={() => setEditBatchId(null)}
                />
              )
            }
            return (
              <span
                className={isReadMode ? '' : 'cursor-pointer hover:text-purple-700 hover:underline'}
                style={{ color: hasPending ? '#d97706' : display ? '#875A7B' : undefined }}
                title={hasPending ? (isEn ? 'Unsaved — click "Save" above to submit' : '未保存,点顶部「保存」提交') : undefined}
                onClick={isReadMode ? undefined : () => { setEditBatchId(o.id); setEditBatchVal(hasPending ? pendingVal : originalSlotId) }}
              >
                {display || '—'}
                {hasPending && <span className="ml-1 text-amber-500">●</span>}
              </span>
            )
          })()}
        </td>
        <td className="px-2 py-2 text-right text-sm text-gray-800 whitespace-nowrap tabular-nums">
          € {o.totalAmount.toFixed(2)}
        </td>
        <td className="px-2 py-2 min-w-[72px]">
          <div className="flex items-center gap-1.5">
            <span className={`inline-block whitespace-nowrap px-2 py-0.5 rounded text-xs ${STATUS_COLOR[o.status] ?? 'bg-gray-100 text-gray-600'}`}>
              {STATUS_LABEL[o.status] ?? String(o.status)}
            </span>
            {!!(o as unknown as Record<string, unknown>).orderReturn && (
              <span className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-xs bg-orange-100 text-orange-600 font-medium">{isEn ? 'Has Return' : '有退货'}</span>
            )}
          </div>
        </td>
        {/* Internal Notes */}
        <td className="px-2 py-2 text-sm text-gray-700 max-w-[140px] truncate" title={getField(o, 'internalNote')}>{getField(o, 'internalNote')}</td>
        {/* Salesperson — Order.salesman 快照(下单时冻结),不随客户当前业务员变 */}
        <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap">{getField(o, 'salesman') || '—'}</td>
        <td className="px-2 py-2" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-1">
            {!isReadMode && o.status === 'confirmed' && pendingBatch[o.id] !== undefined && (
              <button
                onClick={async e => {
                  e.stopPropagation()
                  if (!confirm(isEn
                    ? `Revert order ${displayOrderCode(o)} to quotation?`
                    : `确认将订单 ${displayOrderCode(o)} 撤回到报价单？`)) return
                  try {
                    await apiPut(`/api/orders/${o.id}`, { status: 'PENDING', confirmationDate: null })
                    setPendingBatch(prev => {
                      const next = { ...prev }
                      delete next[o.id]
                      return next
                    })
                    toast.success(isEn ? 'Reverted to quotation' : '已撤回到报价单')
                    refresh()
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : (isEn ? 'Revert failed' : '撤回失败'))
                  }
                }}
                className="px-2 py-1 text-xs rounded border border-orange-300 text-orange-600 bg-orange-50 hover:bg-orange-100 whitespace-nowrap">
                {isEn ? 'Revert' : '撤回'}
              </button>
            )}
          </div>
        </td>
      </tr>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: '#f5f5f5' }}>
      <OdooControlPanel
        breadcrumb={isEn ? ['Sales', 'Orders'] : ['销售', '订单']}
        permanentActions={[
          { label: isEn ? 'New' : '新建', onClick: () => router.push(`${prefix}/classic/operator/place-order`), primary: true },
          ...(isReadMode
            ? [
                { label: 'Mode', onClick: () => setIsReadMode(false) },
                { label: 'Read', onClick: () => {}, primary: true },
              ]
            : [
                { label: 'Edit', onClick: () => {}, primary: true },
                ...(pendingCount > 0
                  ? [{ label: savingBatch ? (isEn ? 'Saving…' : '保存中…') : (isEn ? `Save (${pendingCount})` : `保存 (${pendingCount})`), onClick: saveAllBatches, primary: true }]
                  : []),
                { label: 'Mode', onClick: exitEditMode },
              ]),
          ...(selectedConfirmedCount > 0 ? [{
            label: generatingWave ? (isEn ? 'Generating…' : '生成中…') : (isEn ? `Generate Pick Wave (${selectedConfirmedCount})` : `生成拣货波次 (${selectedConfirmedCount})`),
            onClick: generateBatchWave,
          }] : []),
          { label: exporting === 'summary' ? (isEn ? 'Exporting…' : '导出中…') : (isEn ? 'Export Summary' : '导出汇总'), onClick: () => exportCsv('summary') },
          { label: exporting === 'detail' ? (isEn ? 'Exporting…' : '导出中…') : (isEn ? 'Export Detail' : '导出明细'), onClick: () => exportCsv('detail') },
        ]}
        searchValue={search}
        onSearch={v => { setServerSearch(v) }}
        onSearchSubmit={() => {}}
        facetFields={localizeFacetFields(ORDER_FACET_FIELDS, isEn)}
        onFacetAdd={addFacet}
        filterOptions={[
          { label: myActive ? '✓ My Sales Order' : 'My Sales Order', value: '__my__' },
          ...TIME_QUICK_OPTIONS.map(o => ({ label: timeKey === o.value ? `✓ ${o.label}` : o.label, value: `__time__${o.value}` })),
          { label: isEn ? 'To Invoice' : '待开票', value: 'to_invoice' },
          { label: STATUS_LABEL.confirmed, value: 'confirmed' },
          { label: STATUS_LABEL.wave_assigned, value: 'wave_assigned' },
          { label: STATUS_LABEL.in_delivery, value: 'in_delivery' },
          { label: STATUS_LABEL.completed, value: 'completed' },
          { label: 'Column filters…', value: '__column_filters__' },
        ]}
        onFilterSelect={v => {
          if (v === '__column_filters__') { setShowFiltersBar(x => !x); return }
          if (v === '__my__') { setMyActive(x => !x); return }
          if (v.startsWith('__time__')) { const k = v.slice(8); setTimeKey(prev => prev === k ? '' : k); return }
          setActiveFilter(v as ActiveFilter)
        }}
        activeFilters={[
          ...groupFacets(facets).map(g => ({ label: g.chipLabel, onRemove: () => removeFacetGroup(g.key) })),
          ...(myActive ? [{ label: 'My Sales Order', onRemove: () => setMyActive(false) }] : []),
          ...(timeKey ? [{ label: TIME_QUICK_LABEL[timeKey] ?? timeKey, onRemove: () => setTimeKey('') }] : []),
          ...(activeFilter !== 'all' ? [{
            label: activeFilter === 'to_invoice' ? (isEn ? 'To Invoice' : '待开票') : (STATUS_LABEL[activeFilter as OrderStatus] ?? activeFilter),
            onRemove: () => setActiveFilter('all'),
          }] : []),
        ]}
        groupByOptions={[
          { label: isEn ? 'Customer' : '客户', value: 'restaurantName' },
          { label: isEn ? 'Status' : '状态', value: 'status' },
          { label: isEn ? 'Date' : '日期', value: 'createdAt' },
        ]}
        groupByValue={groupBy}
        onGroupByChange={v => setGroupBy(prev => prev === v ? '' : v)}
        favouriteState={{ search, activeFilter, groupBy, facets, myActive, timeKey, colFilters }}
        onFavouriteApply={s => {
          setServerSearch(String(s.search ?? ''))
          setActiveFilter((s.activeFilter as ActiveFilter) ?? 'all')
          setGroupBy(String(s.groupBy ?? ''))
          setFacets(Array.isArray(s.facets) ? (s.facets as Facet[]) : [])
          setMyActive(Boolean(s.myActive))
          setTimeKey(String(s.timeKey ?? ''))
          // 列级筛选(含 Delivery Date From/To)也纳入收藏,否则点收藏日期区间不恢复(客户反馈)
          setColFilters({ ...EMPTY_FILTERS, ...(s.colFilters as Partial<ColFilters> ?? {}) })
        }}
        storageKey="classic_orders_favs"
        total={total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      <div className="overflow-auto relative">
        {loading && sorted.length > 0 && (
          <div className="absolute top-0 left-0 right-0 h-0.5 overflow-hidden z-20">
            <div className="h-full w-1/3 animate-pulse" style={{ background: '#875A7B' }} />
          </div>
        )}
        <table className="w-full text-sm border-collapse bg-white">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-gray-200 text-left text-xs font-semibold text-gray-600" style={{ background: '#f9f9f9' }}>
              <th className="pl-3 pr-1 py-3 w-8">
                <input type="checkbox" checked={allSelected} onChange={toggleAll}
                  className="w-3.5 h-3.5 accent-purple-600 cursor-pointer" />
              </th>
              {(
                [
                  { field: 'code',          label: 'Quotation\nNumber', right: false },
                  { field: 'deliveryDate',  label: 'Delivery\nDate',    right: false },
                  { field: 'restaurantName',label: 'Customer',          right: false },
                  { field: 'deliveryBatch', label: isEn ? 'Driver' : '司机', right: false },
                  { field: 'totalAmount',   label: 'Untaxed\nTotal',    right: true  },
                  { field: 'status',        label: 'Status',            right: false },
                  { field: null,            label: isEn ? 'Internal\nNotes' : '内部\n备注', right: false },
                  { field: 'salesman',      label: 'Salesperson',       right: false },
                  { field: null,            label: '',                   right: false },
                ] as { field: string | null; label: string; right: boolean }[]
              ).map(({ field, label, right }, i) => {
                const lines = label.split('\n')
                return (
                  <th
                    key={i}
                    className={`px-2 py-3 ${field ? 'cursor-pointer select-none hover:bg-gray-50' : ''} ${right ? 'text-right' : ''}`}
                    onClick={field ? () => {
                      if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
                      else { setSortField(field); setSortDir('asc') }
                    } : undefined}
                  >
                    <div className="leading-tight flex items-end gap-1">
                      <span>{lines.length > 1 ? <>{lines[0]}<br />{lines[1]}</> : lines[0]}</span>
                      {field && sortField === field && (
                        <span className="text-[10px] text-[#875A7B]">{sortDir === 'asc' ? '▲' : '▼'}</span>
                      )}
                    </div>
                  </th>
                )
              })}
            </tr>
            {showFiltersBar && filterRow()}
          </thead>
          <tbody>
            {loading && sorted.length === 0 && (
              <tr><td colSpan={10} className="text-center py-12 text-gray-400 text-sm">{isEn ? 'Loading…' : '加载中…'}</td></tr>
            )}
            {!loading && sorted.length === 0 && (
              <tr><td colSpan={10} className="text-center py-12 text-gray-400 text-sm">{isEn ? 'No orders' : '暂无订单数据'}</td></tr>
            )}
            {sorted.map(o => <Fragment key={o.id}>{renderRow(o)}</Fragment>)}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between px-2 py-3">
        <span className="text-xs text-gray-400">{isEn ? `${total} total, page ${page}/${Math.max(totalPages, 1)}` : `共 ${total} 条，第 ${page}/${Math.max(totalPages, 1)} 页`}</span>
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} className="mt-0" />
      </div>
    </div>
  )
}
