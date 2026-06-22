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
import DayWiseReportDialog from '@/components/classic/DayWiseReportDialog'
import { formatDriverSlotFromOrder, type DriverSlotInfo } from '@/lib/driver-slot'

const PAGE_SIZE = 500

const STATUS_LABEL: Record<OrderStatus, string> = {
  pending:       '待处理',
  confirmed:     '已确认',
  wave_assigned: '已生成拣货单',
  in_delivery:   '配送中',
  completed:     '已完成',
  locked:        '已锁定',
  cancelled:     '已取消',
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
  quotationDateFrom: string
  quotationDateTo: string
  customer: string
  createdBy: string
  salesman: string
  deliveryBatch: string
  invoiceStatus: string
  status: string
  createdAtFrom: string
  createdAtTo: string
}

const EMPTY_FILTERS: ColFilters = {
  code: '', quotationDateFrom: '', quotationDateTo: '',
  customer: '', createdBy: '', salesman: '', deliveryBatch: '',
  invoiceStatus: '', status: '', createdAtFrom: '', createdAtTo: '',
}

const INV_LABEL: Record<string, string> = {
  invoiced:   'Fully Invoiced',
  to_invoice: 'To Invoice',
  nothing:    'Nothing to Invoice',
}

interface CustomerInfo { salesman?: string }

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

  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [customerMap, setCustomerMap] = useState<Map<string, CustomerInfo>>(new Map())
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('all')
  const [colFilters, setColFilters] = useState<ColFilters>(EMPTY_FILTERS)
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
  const [showDayWise, setShowDayWise] = useState(false)

  // Build status param from active filter — changes trigger server refetch via useServerList
  const statusParam = useMemo(() => {
    if (activeFilter === 'to_invoice') return 'COMPLETED'
    if (activeFilter === 'all') return 'CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY,COMPLETED'
    return activeFilter.toUpperCase()
  }, [activeFilter])

  const baseUrl = `/api/orders?status=${statusParam}&include_lines=false`

  const {
    data: rawOrders,
    total,
    page,
    totalPages,
    loading,
    setPage,
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

  useEffect(() => {
    apiGet<Invoice[]>('/api/invoices?slim=1').catch(() => [] as Invoice[]).then(setInvoices)
  }, [])

  useEffect(() => {
    apiGet<{ items?: Array<{ id: string; salesman?: string }> } | Array<{ id: string; salesman?: string }>>('/api/customers?slim=1')
      .then(data => {
        const arr: Array<{ id: string; salesman?: string }> = Array.isArray(data)
          ? data
          : ((data as { items?: Array<{ id: string; salesman?: string }> }).items ?? [])
        const map = new Map<string, CustomerInfo>()
        arr.forEach(c => map.set(c.id, { salesman: c.salesman }))
        setCustomerMap(map)
      })
      .catch(() => {})
  }, [])

  const invoicedOrderIds = useMemo(() => new Set(invoices.flatMap(inv => inv.saleOrderIds)), [invoices])

  function setCf(key: keyof ColFilters, value: string) {
    setColFilters(prev => ({ ...prev, [key]: value }))
  }

  // Client-side column filters applied to current page data
  const filtered = useMemo(() => {
    let result = [...orders]

    if (activeFilter === 'to_invoice') {
      result = result.filter(o => !invoicedOrderIds.has(o.id))
    }

    const cf = colFilters
    if (cf.code) result = result.filter(o => (o.code ?? o.id).toLowerCase().includes(cf.code.toLowerCase()))
    if (cf.quotationDateFrom) result = result.filter(o => (o.quotationDate ?? o.createdAt ?? '').slice(0, 10) >= cf.quotationDateFrom)
    if (cf.quotationDateTo)   result = result.filter(o => (o.quotationDate ?? o.createdAt ?? '').slice(0, 10) <= cf.quotationDateTo)
    if (cf.customer)    result = result.filter(o => o.restaurantName.toLowerCase().includes(cf.customer.toLowerCase()))
    if (cf.createdBy)   result = result.filter(o => getField(o, 'createdByName').toLowerCase().includes(cf.createdBy.toLowerCase()))
    if (cf.salesman)    result = result.filter(o => (customerMap.get(o.restaurantId)?.salesman ?? '').toLowerCase().includes(cf.salesman.toLowerCase()))
    if (cf.deliveryBatch) result = result.filter(o => formatDriverSlotFromOrder(o).toLowerCase().includes(cf.deliveryBatch.toLowerCase()))
    if (cf.invoiceStatus) result = result.filter(o => invoiceStatusFor(o, invoicedOrderIds) === cf.invoiceStatus)
    if (cf.status) result = result.filter(o => o.status === cf.status)
    if (cf.createdAtFrom) result = result.filter(o => (o.createdAt ?? '').slice(0, 10) >= cf.createdAtFrom)
    if (cf.createdAtTo)   result = result.filter(o => (o.createdAt ?? '').slice(0, 10) <= cf.createdAtTo)

    return result
  }, [orders, activeFilter, invoicedOrderIds, colFilters, customerMap])

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let av: string | number = ''
      let bv: string | number = ''
      if (sortField === 'code') { av = a.code ?? a.id; bv = b.code ?? b.id }
      else if (sortField === 'createdAt') { av = a.createdAt ?? ''; bv = b.createdAt ?? '' }
      else if (sortField === 'restaurantName') { av = a.restaurantName; bv = b.restaurantName }
      else if (sortField === 'createdBy') { av = getField(a, 'createdByName'); bv = getField(b, 'createdByName') }
      else if (sortField === 'salesman') { av = customerMap.get(a.restaurantId)?.salesman ?? ''; bv = customerMap.get(b.restaurantId)?.salesman ?? '' }
      else if (sortField === 'deliveryBatch') { av = formatDriverSlotFromOrder(a); bv = formatDriverSlotFromOrder(b) }
      else if (sortField === 'totalAmount') { av = a.totalAmount ?? 0; bv = b.totalAmount ?? 0 }
      else if (sortField === 'invoiceStatus') { av = invoiceStatusFor(a, invoicedOrderIds); bv = invoiceStatusFor(b, invoicedOrderIds) }
      else if (sortField === 'status') { av = a.status; bv = b.status }
      else if (sortField === 'internalNote') { av = getField(a, 'internalNote'); bv = getField(b, 'internalNote') }
      else { av = String((a as unknown as Record<string, unknown>)[sortField] ?? ''); bv = String((b as unknown as Record<string, unknown>)[sortField] ?? '') }
      if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av
      return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
  }, [filtered, sortField, sortDir, customerMap, invoicedOrderIds])

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
    await Promise.all(entries.map(async ([orderId, slotId]) => {
      const slot = driverSlots.find(s => s.id === slotId)
      const deliveryBatch = slot ? `${slot.batchNum} ${slot.timeOfDay} ${slot.driverName}` : ''
      try {
        await apiPut(`/api/orders/${orderId}`, { driverSlotId: slotId || null, deliveryBatch })
      } catch {
        failed.push(orderId)
      }
    }))
    setSavingBatch(false)
    if (failed.length === 0) {
      toast.success(`已保存 ${entries.length} 个订单的司机批次`)
      setPendingBatch({})
    } else {
      toast.error(`${failed.length} 个订单保存失败,已保留待重试`)
      setPendingBatch(prev => {
        const next: Record<string, string> = {}
        for (const id of failed) if (id in prev) next[id] = prev[id]
        return next
      })
    }
    refresh()
  }

  function exitEditMode() {
    if (pendingCount > 0 && !confirm(`有 ${pendingCount} 项未保存的司机批次修改,放弃并退出编辑?`)) return
    setIsReadMode(true)
    setEditBatchId(null)
    setPendingBatch({})
  }

  // 打印送货单/销售单并记录打印状态（时间/打印人/类型/次数）
  async function printOrder(orderId: string, type: 'DELIVERY' | 'SALES') {
    const doc = type === 'DELIVERY' ? 'delivery' : 'sales'
    // 同步打开窗口（保留用户手势，避免被弹窗拦截）
    window.open(`${prefix}/classic/print/${orderId}?doc=${doc}`, '_blank')
    try {
      await apiPost(`/api/orders/${orderId}/mark-printed`, { type })
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '记录打印状态失败')
    }
  }

  async function generateBatchWave() {
    if (generatingWave) return
    // check status only against current page orders
    const confirmedIds = Array.from(selected).filter(id => orders.find(x => x.id === id)?.status === 'confirmed')
    if (confirmedIds.length === 0) { toast.error('请先选择已确认的销售单'); return }
    setGeneratingWave(true)
    try {
      const wave = await apiPost('/api/waves', { orderIds: confirmedIds, status: 'PENDING' })
      await Promise.all(confirmedIds.map(id => apiPut(`/api/orders/${id}`, { status: 'WAVE_ASSIGNED' })))
      toast.success(`拣货波次已生成，包含 ${confirmedIds.length} 张订单`)
      setSelected(new Set())
      const waveId = (wave as { id?: string }).id
      if (waveId) router.push(`${prefix}/classic/operator/waves/${waveId}`)
      else { router.push(`${prefix}/classic/operator/waves`); refresh() }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '生成失败')
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

  const inputCls = 'w-full border-0 border-b border-gray-200 bg-transparent text-xs px-1 py-0.5 focus:outline-none focus:border-purple-400'
  const selectCls = 'w-full border-0 border-b border-gray-200 bg-transparent text-xs px-1 py-0.5 focus:outline-none focus:border-purple-400'

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
        {dateLabelCell('quotationDateFrom', 'quotationDateTo')}
        <td className="px-2 py-1"><input value={colFilters.customer}     onChange={e => setCf('customer', e.target.value)}     className={inputCls} /></td>
        <td className="px-2 py-1"><input value={colFilters.createdBy}    onChange={e => setCf('createdBy', e.target.value)}    className={inputCls} /></td>
        <td className="px-2 py-1"><input value={colFilters.salesman}     onChange={e => setCf('salesman', e.target.value)}     className={inputCls} /></td>
        <td className="px-2 py-1"><input value={colFilters.deliveryBatch} onChange={e => setCf('deliveryBatch', e.target.value)} className={inputCls} /></td>
        <td className="px-2 py-1" />
        <td className="px-2 py-1">
          <select value={colFilters.invoiceStatus} onChange={e => setCf('invoiceStatus', e.target.value)} className={selectCls}>
            <option value=""></option>
            <option value="invoiced">Fully Invoiced</option>
            <option value="to_invoice">To Invoice</option>
            <option value="nothing">Nothing to Invoice</option>
          </select>
        </td>
        <td className="px-2 py-1">
          <select value={colFilters.status} onChange={e => setCf('status', e.target.value)} className={selectCls}>
            <option value=""></option>
            <option value="confirmed">已确认</option>
            <option value="wave_assigned">已生成拣货单</option>
            <option value="in_delivery">配送中</option>
            <option value="completed">已完成</option>
            <option value="cancelled">已取消</option>
          </select>
        </td>
        <td className="px-2 py-1" />
        <td className="px-2 py-1" />
        {dateLabelCell('createdAtFrom', 'createdAtTo')}
        <td className="px-2 py-1" />
      </tr>
    )
  }

  function renderRow(o: Order) {
    const cust = customerMap.get(o.restaurantId)
    const createdByName = getField(o, 'createdByName')
    const internalNote = getField(o, 'internalNote')
    const invStatus = invoiceStatusFor(o, invoicedOrderIds)
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
        <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap"><DateCell iso={o.createdAt} /></td>
        <td className="px-2 py-2 text-sm text-gray-800 max-w-[180px] truncate">{o.restaurantName}</td>
        <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap">{createdByName || '—'}</td>
        <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap">{cust?.salesman || '—'}</td>
        <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap" onClick={e => e.stopPropagation()}>
          {(() => {
            const originalSlotId = (o as unknown as { driverSlotId?: string }).driverSlotId ?? ''
            const pendingVal = pendingBatch[o.id]
            const hasPending = pendingVal !== undefined
            const slotLabel = (id: string) => {
              const s = driverSlots.find(x => x.id === id)
              return s ? `${s.batchNum} ${s.timeOfDay} ${s.driverName}` : ''
            }
            const display = hasPending ? slotLabel(pendingVal) : formatDriverSlotFromOrder(o)
            if (!isReadMode && editBatchId === o.id) {
              return (
                <select
                  autoFocus
                  value={editBatchVal}
                  onChange={e => { setEditBatchVal(e.target.value); stageBatch(o.id, e.target.value, originalSlotId) }}
                  onBlur={() => setEditBatchId(null)}
                  className="border border-purple-400 rounded px-1 py-0.5 text-xs bg-white focus:outline-none"
                >
                  <option value="">— unassigned —</option>
                  {driverSlots.map(s => <option key={s.id} value={s.id}>{s.batchNum} {s.timeOfDay} {s.driverName}</option>)}
                </select>
              )
            }
            return (
              <span
                className={isReadMode ? '' : 'cursor-pointer hover:text-purple-700 hover:underline'}
                style={{ color: hasPending ? '#d97706' : display ? '#875A7B' : undefined }}
                title={hasPending ? '未保存,点顶部「保存」提交' : undefined}
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
        <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap">{INV_LABEL[invStatus]}</td>
        <td className="px-2 py-2">
          <div className="flex items-center gap-1.5">
            <span className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_COLOR[o.status] ?? 'bg-gray-100 text-gray-600'}`}>
              {STATUS_LABEL[o.status] ?? String(o.status)}
            </span>
            {!!(o as unknown as Record<string, unknown>).orderReturn && (
              <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-orange-100 text-orange-600 font-medium">有退货</span>
            )}
          </div>
        </td>
        <td className="px-2 py-2">
          {(() => {
            if (!o.printedAt) return <span className="inline-block px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-500">未打印</span>
            const cnt = o.printCount ?? 0
            const typeLabel = o.printType === 'DELIVERY' ? '送货单' : o.printType === 'SALES' ? '销售单' : ''
            return (
              <div className="text-xs leading-tight">
                <span className="inline-block px-2 py-0.5 rounded bg-green-50 text-green-700">已打印 ✓{cnt > 1 ? ` ×${cnt}` : ''}</span>
                <div className="text-gray-500 mt-0.5 whitespace-nowrap">
                  {formatDateTimeShort(o.printedAt)}{o.printedByName ? ` · ${o.printedByName}` : ''}{typeLabel ? ` · ${typeLabel}` : ''}
                </div>
              </div>
            )
          })()}
        </td>
        <td className="px-2 py-2 text-sm text-gray-500 max-w-[140px] truncate" title={internalNote}>{internalNote || ''}</td>
        <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap"><DateCell iso={o.createdAt} /></td>
        <td className="px-2 py-2" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-1">
            <select
              defaultValue=""
              onChange={e => { const t = e.target.value; e.currentTarget.value = ''; if (t) printOrder(o.id, t as 'DELIVERY' | 'SALES') }}
              className="px-1.5 py-1 text-xs rounded border border-gray-300 text-gray-600 bg-white cursor-pointer hover:border-purple-400"
              title="打印并记录打印状态"
            >
              <option value="" disabled>🖨 打印…</option>
              <option value="DELIVERY">送货单</option>
              <option value="SALES">销售单</option>
            </select>
            {!isReadMode && o.status === 'confirmed' && (
              <button
                onClick={async e => {
                  e.stopPropagation()
                  if (!confirm(`确认将订单 ${displayOrderCode(o)} 撤回到报价单？`)) return
                  try {
                    await apiPut(`/api/orders/${o.id}`, { status: 'PENDING', confirmationDate: null })
                    toast.success('已撤回到报价单')
                    refresh()
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : '撤回失败')
                  }
                }}
                className="px-2 py-1 text-xs rounded border border-orange-300 text-orange-600 bg-orange-50 hover:bg-orange-100 whitespace-nowrap">
                撤回
              </button>
            )}
          </div>
        </td>
      </tr>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: '#f5f5f5' }}>
      {showDayWise && <DayWiseReportDialog onClose={() => setShowDayWise(false)} />}
      <OdooControlPanel
        breadcrumb={['销售', '订单']}
        permanentActions={[
          { label: '新建', onClick: () => router.push(`${prefix}/classic/operator/place-order`), primary: true },
          ...(isReadMode
            ? [
                { label: 'Mode', onClick: () => setIsReadMode(false) },
                { label: 'Read', onClick: () => {}, primary: true },
              ]
            : [
                { label: 'Edit', onClick: () => {}, primary: true },
                ...(pendingCount > 0
                  ? [{ label: savingBatch ? '保存中…' : `保存 (${pendingCount})`, onClick: saveAllBatches, primary: true }]
                  : []),
                { label: 'Mode', onClick: exitEditMode },
              ]),
          ...(selectedConfirmedCount > 0 ? [{
            label: generatingWave ? '生成中…' : `生成拣货波次 (${selectedConfirmedCount})`,
            onClick: generateBatchWave,
          }] : []),
          { label: '日销售报表', onClick: () => setShowDayWise(true) },
          { label: '导出', onClick: () => toast.info('导出功能即将推出') },
        ]}
        searchValue={search}
        onSearch={v => { setServerSearch(v) }}
        onSearchSubmit={() => {}}
        filterOptions={[
          { label: '待开票', value: 'to_invoice' },
          { label: '已确认', value: 'confirmed' },
          { label: '已生成拣货单', value: 'wave_assigned' },
          { label: '配送中', value: 'in_delivery' },
          { label: '已完成', value: 'completed' },
          { label: 'Column filters…', value: '__column_filters__' },
        ]}
        onFilterSelect={v => {
          if (v === '__column_filters__') { setShowFiltersBar(x => !x); return }
          setActiveFilter(v as ActiveFilter)
        }}
        activeFilters={[
          ...(activeFilter !== 'all' ? [{
            label: activeFilter === 'to_invoice' ? '待开票' : (STATUS_LABEL[activeFilter as OrderStatus] ?? activeFilter),
            onRemove: () => setActiveFilter('all'),
          }] : []),
        ]}
        groupByOptions={[
          { label: '客户', value: 'restaurantName' },
          { label: '状态', value: 'status' },
          { label: '日期', value: 'createdAt' },
        ]}
        groupByValue={groupBy}
        onGroupByChange={v => setGroupBy(prev => prev === v ? '' : v)}
        favouriteState={{ search, activeFilter, groupBy }}
        onFavouriteApply={s => {
          setServerSearch(String(s.search ?? ''))
          setActiveFilter((s.activeFilter as ActiveFilter) ?? 'all')
          setGroupBy(String(s.groupBy ?? ''))
        }}
        storageKey="classic_orders_favs"
        total={total}
      />

      <div className="overflow-auto">
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
                  { field: 'createdAt',     label: 'Quotation\nDate',   right: false },
                  { field: 'restaurantName',label: 'Customer',          right: false },
                  { field: 'createdBy',     label: 'Created\nby',       right: false },
                  { field: 'salesman',      label: 'Salesperson',       right: false },
                  { field: 'deliveryBatch', label: 'Delivery\nBatch',   right: false },
                  { field: 'totalAmount',   label: 'Total',             right: true  },
                  { field: 'invoiceStatus', label: 'Invoice\nStatus',   right: false },
                  { field: 'status',        label: 'Status',            right: false },
                  { field: 'printedAt',     label: 'Print\nStatus',     right: false },
                  { field: 'internalNote',  label: 'Internal\nNotes',   right: false },
                  { field: 'createdAt',     label: 'Creation\nDate',    right: false },
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
            {loading && (
              <tr><td colSpan={15} className="text-center py-12 text-gray-400 text-sm">加载中…</td></tr>
            )}
            {!loading && sorted.length === 0 && (
              <tr><td colSpan={15} className="text-center py-12 text-gray-400 text-sm">暂无订单数据</td></tr>
            )}
            {!loading && sorted.map(o => <Fragment key={o.id}>{renderRow(o)}</Fragment>)}
          </tbody>
        </table>
      </div>
    </div>
  )
}
