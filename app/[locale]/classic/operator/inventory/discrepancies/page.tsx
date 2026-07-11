'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'

const PURPLE = '#875A7B'
const BORDER = '#d4b8d0'

interface DiscrepancyRecord {
  id: string
  code: string
  orderId: string
  orderLineId: string
  productId: string
  productName: string
  orderedQty: number | string
  pickedQty: number | string
  diffQty: number | string
  type: string
  status: string
  resolution?: string | null
  substituteProductId?: string | null
  substituteProductName?: string | null
  substituteQty?: number | string | null
  substituteUnitPrice?: number | string | null
  note?: string | null
  reportedByName?: string | null
  resolvedByName?: string | null
  resolvedAt?: string | null
  createdAt: string
  order?: {
    code?: string | null
    restaurantName: string
    status: string
    deliveryDate?: string | null
  }
}

interface OrderOption {
  id: string
  code?: string | null
  restaurantName: string
  status: string
  lines: {
    id: string
    productId: string
    productName: string
    orderedQty: number | string
    unitPrice: number | string
    spec?: string | null
  }[]
}

interface ProductOption {
  id: string
  name: string
  listPrice?: number | string
  qtyOnHand?: number | string
}

const DISC_TYPES_ZH: Record<string, string> = {
  SHORTAGE: '缺货',
  SUBSTITUTE: '替代',
  WEIGHT_DIFF: '重量差异',
}

const DISC_TYPES_EN: Record<string, string> = {
  SHORTAGE: 'Shortage',
  SUBSTITUTE: 'Substitute',
  WEIGHT_DIFF: 'Weight diff',
}

const RESOLUTION_LABELS_ZH: Record<string, string> = {
  ADJUST_QTY: '调整数量',
  SUBSTITUTE: '替代商品',
  CANCEL_LINE: '取消该行',
  REPLENISH: '补货',
}

const RESOLUTION_LABELS_EN: Record<string, string> = {
  ADJUST_QTY: 'Adjust quantity',
  SUBSTITUTE: 'Substitute product',
  CANCEL_LINE: 'Cancel line',
  REPLENISH: 'Replenish',
}

const STATUS_LABELS_ZH: Record<string, { label: string; color: string }> = {
  PENDING: { label: '待处理', color: '#e67e22' },
  RESOLVED: { label: '已处理', color: '#27ae60' },
  CANCELLED: { label: '已取消', color: '#95a5a6' },
}

const STATUS_LABELS_EN: Record<string, { label: string; color: string }> = {
  PENDING: { label: 'Pending', color: '#e67e22' },
  RESOLVED: { label: 'Resolved', color: '#27ae60' },
  CANCELLED: { label: 'Cancelled', color: '#95a5a6' },
}

export default function DiscrepanciesPage() {
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const DISC_TYPES = isEn ? DISC_TYPES_EN : DISC_TYPES_ZH
  const RESOLUTION_LABELS = isEn ? RESOLUTION_LABELS_EN : RESOLUTION_LABELS_ZH
  const STATUS_LABELS = isEn ? STATUS_LABELS_EN : STATUS_LABELS_ZH

  const [records, setRecords] = useState<DiscrepancyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('PENDING')

  // Report dialog state
  const [showReportDialog, setShowReportDialog] = useState(false)
  const [orderSearch, setOrderSearch] = useState('')
  const [orders, setOrders] = useState<OrderOption[]>([])
  const [selectedOrder, setSelectedOrder] = useState<OrderOption | null>(null)
  const [selectedLineId, setSelectedLineId] = useState('')
  const [pickedQty, setPickedQty] = useState('')
  const [discType, setDiscType] = useState('SHORTAGE')
  const [reportNote, setReportNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Resolve dialog state
  const [showResolveDialog, setShowResolveDialog] = useState(false)
  const [resolving, setResolving] = useState<DiscrepancyRecord | null>(null)
  const [resolution, setResolution] = useState('ADJUST_QTY')
  const [resolveNote, setResolveNote] = useState('')
  // Substitute fields
  const [subProducts, setSubProducts] = useState<ProductOption[]>([])
  const [subProductSearch, setSubProductSearch] = useState('')
  const [subProductId, setSubProductId] = useState('')
  const [subQty, setSubQty] = useState('')
  const [subPrice, setSubPrice] = useState('')
  const [subProductsLoading, setSubProductsLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ items: DiscrepancyRecord[]; total: number }>(
        `/api/order-discrepancies?status=${statusFilter}&limit=200`
      )
      setRecords(data?.items ?? [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [statusFilter, isEn])

  useEffect(() => { load() }, [load])

  // Search orders for report dialog
  async function searchOrders() {
    if (!orderSearch.trim()) return
    try {
      const data = await apiGet<{ data: OrderOption[] }>(
        `/api/orders?search=${encodeURIComponent(orderSearch)}&status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY&pageSize=10&page=1`
      )
      const list = data?.data ?? []
      // Load lines for each order
      const withLines = await Promise.all(
        list.map(async (o) => {
          try {
            const full = await apiGet<OrderOption>(`/api/orders/${o.id}`)
            return { ...o, lines: full?.lines ?? [] }
          } catch {
            return { ...o, lines: [] }
          }
        })
      )
      setOrders(withLines)
    } catch {
      toast.error(isEn ? 'Failed to search orders' : '搜索订单失败')
    }
  }

  async function handleReport(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedOrder || !selectedLineId || !pickedQty) return
    const line = selectedOrder.lines.find(l => l.id === selectedLineId)
    if (!line) return

    setSubmitting(true)
    try {
      await apiPost('/api/order-discrepancies', {
        orderId: selectedOrder.id,
        orderLineId: selectedLineId,
        productId: line.productId,
        productName: line.productName,
        orderedQty: Number(line.orderedQty),
        pickedQty: Number(pickedQty),
        type: discType,
        note: reportNote || undefined,
      })
      toast.success(isEn ? 'Discrepancy reported' : '差异已上报')
      setShowReportDialog(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to report' : '上报失败'))
    } finally {
      setSubmitting(false)
    }
  }

  function openResolveDialog(disc: DiscrepancyRecord) {
    setResolving(disc)
    setResolution('ADJUST_QTY')
    setResolveNote('')
    setSubProductId('')
    setSubQty('')
    setSubPrice('')
    setSubProductSearch('')
    setSubProducts([])
    setShowResolveDialog(true)
  }

  async function loadSubProducts() {
    setSubProductsLoading(true)
    try {
      const prods = await apiGet<ProductOption[]>('/api/products?status=ACTIVE')
      setSubProducts(Array.isArray(prods) ? prods : [])
    } catch {
      toast.error(isEn ? 'Failed to load products' : '加载商品失败')
    } finally {
      setSubProductsLoading(false)
    }
  }

  useEffect(() => {
    if (resolution === 'SUBSTITUTE' && subProducts.length === 0) {
      loadSubProducts()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolution])

  const filteredSubProducts = subProducts.filter(p =>
    !subProductSearch || p.name.toLowerCase().includes(subProductSearch.toLowerCase())
  )
  const selectedSubProduct = subProducts.find(p => p.id === subProductId)

  async function handleResolve(e: React.FormEvent) {
    e.preventDefault()
    if (!resolving) return

    if (resolution === 'SUBSTITUTE' && (!subProductId || !subQty || !subPrice)) {
      toast.error(isEn ? 'Please fill in the substitute product info' : '请填写替代商品信息')
      return
    }

    setSubmitting(true)
    try {
      await apiPut(`/api/order-discrepancies/${resolving.id}`, {
        resolution,
        note: resolveNote || undefined,
        ...(resolution === 'SUBSTITUTE' ? {
          substituteProductId: subProductId,
          substituteProductName: selectedSubProduct?.name ?? '',
          substituteQty: Number(subQty),
          substituteUnitPrice: Number(subPrice),
        } : {}),
      })
      toast.success(isEn ? 'Discrepancy resolved' : '差异已处理')
      setShowResolveDialog(false)
      setResolving(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to resolve' : '处理失败'))
    } finally {
      setSubmitting(false)
    }
  }

  const selectedLine = selectedOrder?.lines.find(l => l.id === selectedLineId)

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <button onClick={() => router.push(`${prefix}/classic/operator/inventory`)} className="hover:underline">
          {isEn ? 'Inventory' : '库存管理'}
        </button>
        <span>/</span>
        <span style={{ color: PURPLE }}>{isEn ? 'Picking Discrepancies' : '拣货差异处理'}</span>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold" style={{ color: PURPLE }}>{isEn ? 'Picking Discrepancies' : '拣货差异处理'}</h1>
        <button
          onClick={() => {
            setShowReportDialog(true)
            setOrderSearch('')
            setOrders([])
            setSelectedOrder(null)
            setSelectedLineId('')
            setPickedQty('')
            setDiscType('SHORTAGE')
            setReportNote('')
          }}
          className="px-4 py-2 rounded text-sm font-medium text-white"
          style={{ background: PURPLE }}
        >
          + {isEn ? 'Report Discrepancy' : '上报差异'}
        </button>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2">
        {['PENDING', 'RESOLVED', ''].map(s => (
          <button
            key={s || 'ALL'}
            onClick={() => setStatusFilter(s)}
            className="px-3 py-1.5 rounded text-xs font-medium border transition-colors"
            style={{
              borderColor: statusFilter === s ? PURPLE : BORDER,
              background: statusFilter === s ? PURPLE : 'white',
              color: statusFilter === s ? 'white' : '#666',
            }}
          >
            {s ? (STATUS_LABELS[s]?.label ?? s) : (isEn ? 'All' : '全部')}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: BORDER }}>
        <div
          className="grid gap-2 px-4 py-2.5 text-xs font-semibold border-b"
          style={{
            borderColor: BORDER, color: PURPLE, background: '#faf5fb',
            gridTemplateColumns: '90px 1fr 120px 70px 70px 70px 70px 80px 70px',
          }}
        >
          <span>{isEn ? 'Code' : '编号'}</span>
          <span>{isEn ? 'Order/Customer' : '订单/客户'}</span>
          <span>{isEn ? 'Product' : '商品'}</span>
          <span className="text-right">{isEn ? 'Ordered' : '下单'}</span>
          <span className="text-right">{isEn ? 'Picked' : '实拣'}</span>
          <span className="text-right">{isEn ? 'Diff' : '差异'}</span>
          <span>{isEn ? 'Type' : '类型'}</span>
          <span>{isEn ? 'Status' : '状态'}</span>
          <span>{isEn ? 'Action' : '操作'}</span>
        </div>

        {loading && <div className="py-12 text-center text-sm text-gray-400">{isEn ? 'Loading...' : '加载中...'}</div>}
        {!loading && records.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-400">{isEn ? 'No discrepancy records' : '暂无差异记录'}</div>
        )}

        {!loading && records.map((r) => {
          const st = STATUS_LABELS[r.status] ?? { label: r.status, color: '#999' }
          return (
            <div
              key={r.id}
              className="grid gap-2 px-4 py-3 border-b last:border-b-0 items-center"
              style={{
                borderColor: '#f0e4ee',
                gridTemplateColumns: '90px 1fr 120px 70px 70px 70px 70px 80px 70px',
              }}
            >
              <span className="text-xs font-mono text-gray-500">{r.code}</span>
              <div className="min-w-0">
                <div className="text-xs font-mono text-gray-400">{r.order?.code ?? r.orderId.slice(0, 8)}</div>
                <div className="text-xs text-gray-500 truncate">{r.order?.restaurantName ?? ''}</div>
              </div>
              <span className="text-sm text-gray-800 truncate">{r.productName}</span>
              <span className="text-sm font-mono text-right">{Number(r.orderedQty).toFixed(1)}</span>
              <span className="text-sm font-mono text-right">{Number(r.pickedQty).toFixed(1)}</span>
              <span className="text-sm font-mono text-right font-semibold text-red-500">
                {Number(r.diffQty).toFixed(1)}
              </span>
              <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: '#fef3cd', color: '#856404' }}>
                {DISC_TYPES[r.type] ?? r.type}
              </span>
              <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: `${st.color}20`, color: st.color }}>
                {st.label}
              </span>
              <div>
                {r.status === 'PENDING' ? (
                  <button
                    onClick={() => openResolveDialog(r)}
                    className="text-xs px-2 py-1 rounded text-white"
                    style={{ background: PURPLE }}
                  >
                    {isEn ? 'Resolve' : '处理'}
                  </button>
                ) : (
                  <span className="text-xs text-gray-400">{r.resolution ? RESOLUTION_LABELS[r.resolution] ?? r.resolution : '—'}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Report Dialog ── */}
      {showReportDialog && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center" onClick={() => setShowReportDialog(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-semibold" style={{ color: PURPLE }}>{isEn ? 'Report Picking Discrepancy' : '上报拣货差异'}</h2>

            <form onSubmit={handleReport} className="space-y-4">
              {/* Search order */}
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">{isEn ? 'Search order (code or customer name)' : '搜索订单（编号或客户名）'}</label>
                <div className="flex gap-2">
                  <input
                    value={orderSearch}
                    onChange={e => setOrderSearch(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), searchOrders())}
                    className="flex-1 border rounded px-3 py-2 text-sm"
                    style={{ borderColor: BORDER }}
                    placeholder={isEn ? 'Enter order code or customer name...' : '输入订单号或客户名...'}
                  />
                  <button type="button" onClick={searchOrders} className="px-3 py-2 rounded text-sm text-white" style={{ background: PURPLE }}>
                    {isEn ? 'Search' : '搜索'}
                  </button>
                </div>
              </div>

              {orders.length > 0 && !selectedOrder && (
                <div className="border rounded max-h-40 overflow-y-auto" style={{ borderColor: BORDER }}>
                  {orders.map(o => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => { setSelectedOrder(o); setSelectedLineId(''); setPickedQty('') }}
                      className="block w-full text-left px-3 py-2 hover:bg-purple-50 border-b last:border-b-0 text-sm"
                      style={{ borderColor: '#f0e4ee' }}
                    >
                      <span className="font-mono text-xs text-gray-500">{o.code ?? o.id.slice(0, 8)}</span>
                      <span className="ml-2">{o.restaurantName}</span>
                      <span className="ml-2 text-xs text-gray-400">{o.status}</span>
                    </button>
                  ))}
                </div>
              )}

              {selectedOrder && (
                <>
                  <div className="bg-purple-50 rounded p-3 text-sm">
                    <span className="font-mono text-xs">{selectedOrder.code ?? selectedOrder.id.slice(0, 8)}</span>
                    <span className="ml-2 font-medium">{selectedOrder.restaurantName}</span>
                    <button type="button" onClick={() => { setSelectedOrder(null); setSelectedLineId('') }} className="ml-2 text-xs text-red-400 hover:underline">{isEn ? 'Change' : '换'}</button>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">{isEn ? 'Select product line' : '选择商品行'}</label>
                    <select
                      value={selectedLineId}
                      onChange={e => {
                        setSelectedLineId(e.target.value)
                        setPickedQty('')
                      }}
                      className="w-full border rounded px-3 py-2 text-sm"
                      style={{ borderColor: BORDER }}
                    >
                      <option value="">{isEn ? '-- Select product --' : '-- 选择商品 --'}</option>
                      {selectedOrder.lines.map(l => (
                        <option key={l.id} value={l.id}>
                          {l.productName}{l.spec ? ` (${l.spec})` : ''} — {isEn ? 'Ordered' : '下单'}: {Number(l.orderedQty).toFixed(1)}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {selectedLine && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">
                        {isEn ? 'Ordered quantity' : '下单数量'}
                      </label>
                      <input
                        value={Number(selectedLine.orderedQty).toFixed(1)}
                        disabled
                        className="w-full border rounded px-3 py-2 text-sm bg-gray-50"
                        style={{ borderColor: BORDER }}
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">
                        {isEn ? 'Actual picked quantity *' : '实际拣货数量 *'}
                      </label>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={pickedQty}
                        onChange={e => setPickedQty(e.target.value)}
                        className="w-full border rounded px-3 py-2 text-sm"
                        style={{ borderColor: BORDER }}
                        required
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">{isEn ? 'Discrepancy type' : '差异类型'}</label>
                    <div className="flex gap-2">
                      {Object.entries(DISC_TYPES).map(([k, v]) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setDiscType(k)}
                          className="px-3 py-1.5 rounded text-xs border"
                          style={{
                            borderColor: discType === k ? PURPLE : BORDER,
                            background: discType === k ? PURPLE : 'white',
                            color: discType === k ? 'white' : '#666',
                          }}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">{isEn ? 'Note' : '备注'}</label>
                    <textarea
                      value={reportNote}
                      onChange={e => setReportNote(e.target.value)}
                      className="w-full border rounded px-3 py-2 text-sm"
                      style={{ borderColor: BORDER }}
                      rows={2}
                      placeholder={isEn ? 'Describe the reason for the discrepancy...' : '描述差异原因...'}
                    />
                  </div>

                  {pickedQty && (
                    <div className="bg-red-50 rounded p-3 text-sm">
                      {isEn ? 'Diff quantity' : '差异数量'}: <span className="font-bold text-red-600">{(Number(selectedLine.orderedQty) - Number(pickedQty)).toFixed(1)}</span>
                      {' '}({DISC_TYPES[discType]})
                    </div>
                  )}
                </>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowReportDialog(false)} className="px-4 py-2 rounded text-sm border" style={{ borderColor: BORDER }}>
                  {isEn ? 'Cancel' : '取消'}
                </button>
                <button
                  type="submit"
                  disabled={submitting || !selectedOrder || !selectedLineId || !pickedQty}
                  className="px-4 py-2 rounded text-sm text-white disabled:opacity-50"
                  style={{ background: PURPLE }}
                >
                  {submitting ? (isEn ? 'Submitting...' : '提交中...') : (isEn ? 'Confirm Report' : '确认上报')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Resolve Dialog ── */}
      {showResolveDialog && resolving && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center" onClick={() => setShowResolveDialog(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-semibold" style={{ color: PURPLE }}>{isEn ? 'Resolve Discrepancy' : '处理差异'} {resolving.code}</h2>

            <div className="bg-gray-50 rounded p-3 space-y-1 text-sm">
              <div><span className="text-gray-500">{isEn ? 'Order:' : '订单:'}</span> {resolving.order?.code ?? resolving.orderId.slice(0, 8)} · {resolving.order?.restaurantName}</div>
              <div><span className="text-gray-500">{isEn ? 'Product:' : '商品:'}</span> {resolving.productName}</div>
              <div>
                <span className="text-gray-500">{isEn ? 'Ordered:' : '下单:'}</span> {Number(resolving.orderedQty).toFixed(1)}
                <span className="mx-2">→</span>
                <span className="text-gray-500">{isEn ? 'Picked:' : '实拣:'}</span> {Number(resolving.pickedQty).toFixed(1)}
                <span className="mx-2 font-bold text-red-500">{isEn ? 'Diff:' : '差:'} {Number(resolving.diffQty).toFixed(1)}</span>
              </div>
              <div><span className="text-gray-500">{isEn ? 'Type:' : '类型:'}</span> {DISC_TYPES[resolving.type] ?? resolving.type}</div>
              {resolving.note && <div><span className="text-gray-500">{isEn ? 'Note:' : '备注:'}</span> {resolving.note}</div>}
            </div>

            <form onSubmit={handleResolve} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-2">{isEn ? 'Resolution method' : '处理方式'}</label>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(RESOLUTION_LABELS).map(([k, v]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setResolution(k)}
                      className="px-3 py-2 rounded text-xs border text-left"
                      style={{
                        borderColor: resolution === k ? PURPLE : BORDER,
                        background: resolution === k ? `${PURPLE}10` : 'white',
                        color: resolution === k ? PURPLE : '#666',
                      }}
                    >
                      <div className="font-medium">{v}</div>
                      <div className="text-[10px] mt-0.5 opacity-70">
                        {k === 'ADJUST_QTY' && (isEn ? 'Adjust the order by actual picked quantity' : '按实拣数量调整订单')}
                        {k === 'SUBSTITUTE' && (isEn ? 'Replace with another product' : '用其他商品替换')}
                        {k === 'CANCEL_LINE' && (isEn ? 'Delete this order line' : '删除该订单行')}
                        {k === 'REPLENISH' && (isEn ? 'Replenish from another supplier' : '从其他供应商补货')}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {resolution === 'ADJUST_QTY' && (
                <div className="bg-blue-50 rounded p-3 text-sm">
                  {isEn ? (
                    <>Adjust the order line quantity from <b>{Number(resolving.orderedQty).toFixed(1)}</b> to <b>{Number(resolving.pickedQty).toFixed(1)}</b>,
                    with the difference of {Number(resolving.diffQty).toFixed(1)} returned to stock.</>
                  ) : (
                    <>将订单行数量从 <b>{Number(resolving.orderedQty).toFixed(1)}</b> 调整为 <b>{Number(resolving.pickedQty).toFixed(1)}</b>，
                    差额 {Number(resolving.diffQty).toFixed(1)} 退回库存。</>
                  )}
                </div>
              )}

              {resolution === 'CANCEL_LINE' && (
                <div className="bg-red-50 rounded p-3 text-sm">
                  {isEn
                    ? <>This order line will be deleted, and the full quantity of {Number(resolving.orderedQty).toFixed(1)} returned to stock.</>
                    : <>将删除该订单行，全部数量 {Number(resolving.orderedQty).toFixed(1)} 退回库存。</>}
                </div>
              )}

              {resolution === 'REPLENISH' && (
                <div className="bg-green-50 rounded p-3 text-sm">
                  {isEn
                    ? 'Marked as awaiting replenishment; the order quantity is not changed. Please confirm manually once restocked.'
                    : '标记为等待补货，不修改订单数量。补货到位后请手动确认。'}
                </div>
              )}

              {resolution === 'SUBSTITUTE' && (
                <div className="space-y-3">
                  <div className="bg-yellow-50 rounded p-3 text-sm">
                    {isEn ? (
                      <>The original product is adjusted to the actual picked quantity of {Number(resolving.pickedQty).toFixed(1)}, with the difference returned to stock.
                      A new substitute product line is added.</>
                    ) : (
                      <>原商品按实拣数量 {Number(resolving.pickedQty).toFixed(1)} 调整，差额退回库存。
                      新增替代商品行。</>
                    )}
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">{isEn ? 'Search substitute product' : '搜索替代商品'}</label>
                    <input
                      value={subProductSearch}
                      onChange={e => setSubProductSearch(e.target.value)}
                      className="w-full border rounded px-3 py-2 text-sm"
                      style={{ borderColor: BORDER }}
                      placeholder={isEn ? 'Enter product name...' : '输入商品名...'}
                    />
                  </div>

                  {subProductsLoading ? (
                    <div className="text-xs text-gray-400">{isEn ? 'Loading product list...' : '加载商品列表...'}</div>
                  ) : (
                    <div className="border rounded max-h-32 overflow-y-auto" style={{ borderColor: BORDER }}>
                      {filteredSubProducts.slice(0, 20).map(p => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setSubProductId(p.id)
                            setSubPrice(String(Number(p.listPrice ?? 0)))
                          }}
                          className="block w-full text-left px-3 py-1.5 hover:bg-purple-50 border-b last:border-b-0 text-sm"
                          style={{
                            borderColor: '#f0e4ee',
                            background: subProductId === p.id ? '#f3e8f9' : undefined,
                          }}
                        >
                          {p.name}
                          <span className="ml-2 text-xs text-gray-400">{isEn ? 'Stock' : '库存'}: {Number(p.qtyOnHand ?? 0).toFixed(1)}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {subProductId && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-medium text-gray-600 block mb-1">{isEn ? 'Substitute quantity *' : '替代数量 *'}</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0.1"
                          value={subQty}
                          onChange={e => setSubQty(e.target.value)}
                          className="w-full border rounded px-3 py-2 text-sm"
                          style={{ borderColor: BORDER }}
                          required
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-gray-600 block mb-1">{isEn ? 'Unit price *' : '单价 *'}</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={subPrice}
                          onChange={e => setSubPrice(e.target.value)}
                          className="w-full border rounded px-3 py-2 text-sm"
                          style={{ borderColor: BORDER }}
                          required
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">{isEn ? 'Resolution note' : '处理备注'}</label>
                <textarea
                  value={resolveNote}
                  onChange={e => setResolveNote(e.target.value)}
                  className="w-full border rounded px-3 py-2 text-sm"
                  style={{ borderColor: BORDER }}
                  rows={2}
                  placeholder={isEn ? 'Resolution notes...' : '处理说明...'}
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => { setShowResolveDialog(false); setResolving(null) }} className="px-4 py-2 rounded text-sm border" style={{ borderColor: BORDER }}>
                  {isEn ? 'Cancel' : '取消'}
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded text-sm text-white disabled:opacity-50"
                  style={{ background: PURPLE }}
                >
                  {submitting ? (isEn ? 'Processing...' : '处理中...') : (isEn ? 'Confirm Resolve' : '确认处理')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
