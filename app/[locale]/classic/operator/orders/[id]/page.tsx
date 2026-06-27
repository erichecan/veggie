'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'
import { Trash2 } from 'lucide-react'
import { formatDriverSlotFromOrder, type DriverSlotInfo } from '@/lib/driver-slot'
import type { Order, Customer, OdooPricelist as Pricelist } from '@/lib/types'
import { displayOrderCode } from '@/lib/order-code'
import { OrderChatter } from '@/components/order/OrderChatter'

const PURPLE = '#875A7B'

interface AllProduct {
  id: string
  name: string
  internalRef?: string | null
  listPrice?: number
  standardPrice?: number
  commissionPrice?: number
  customerTaxRate?: number
  uomName?: string
  uomId?: string
}

function formatDate(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`
}

type Tab = 'lines' | 'optional' | 'automation' | 'other'

interface ForecastRow { productId: string; forecast: number; qtyOnHand: number }

const STATUS_LABEL: Record<string, string> = {
  PENDING: '待处理',
  CONFIRMED: '已确认',
  WAVE_ASSIGNED: '已生成拣货单',
  IN_DELIVERY: '配送中',
  COMPLETED: '已完成',
  LOCKED: '已锁定',
  CANCELLED: '已取消',
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: 'bg-yellow-50 text-yellow-700',
  CONFIRMED: 'bg-blue-50 text-blue-700',
  WAVE_ASSIGNED: 'bg-indigo-50 text-indigo-700',
  IN_DELIVERY: 'bg-purple-50 text-purple-700',
  COMPLETED: 'bg-green-50 text-green-700',
  LOCKED: 'bg-gray-200 text-gray-700',
  CANCELLED: 'bg-red-50 text-red-600',
}

export default function SalesOrderDetailPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const params = useParams<{ id: string }>()
  const id = params.id

  const [order, setOrder] = useState<Order | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [pricelist, setPricelist] = useState<Pricelist | null>(null)
  const [pricelists, setPricelists] = useState<Pricelist[]>([])
  const [forecastMap, setForecastMap] = useState<Map<string, ForecastRow>>(new Map())
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('lines')
  const [editing, setEditing] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [internalNote, setInternalNote] = useState('')
  const [deliveryBatch, setDeliveryBatch] = useState('')
  const [driverSlotId, setDriverSlotId] = useState('')
  const [pricelistId, setPricelistId] = useState('')
  const [priceType, setPriceType] = useState('multi')
  const [driverSlots, setDriverSlots] = useState<DriverSlotInfo[]>([])

  useEffect(() => {
    apiGet<DriverSlotInfo[]>('/api/driver-slots').then(d => setDriverSlots(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  type EditLine = NonNullable<Order['lines']>[number] & { commissionPrice?: number }
  const [editLines, setEditLines] = useState<EditLine[]>([])
  const [allProducts, setAllProducts] = useState<AllProduct[]>([])

  // P1-5: audit log
  const [auditLogs, setAuditLogs] = useState<{ id: string; action: string; detail?: string; userName?: string; createdAt: string }[]>([])
  const [showAuditLog, setShowAuditLog] = useState(false)

  // P1-6: edit approval
  const [approving, setApproving] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [showRejectInput, setShowRejectInput] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const ord = await apiGet<Order>(`/api/orders/${id}`)
      setOrder(ord)
      setInternalNote(ord.internalNote ?? '')
      setDeliveryBatch(ord.deliveryBatch ?? '')
      setDriverSlotId((ord as unknown as { driverSlotId?: string }).driverSlotId ?? '')
      setPricelistId(ord.pricelistId ?? '')
      setPriceType((ord as unknown as { priceType?: string }).priceType ?? 'multi')

      const [cs, pls] = await Promise.all([
        apiGet<Customer[]>('/api/customers').catch(() => [] as Customer[]),
        apiGet<Pricelist[]>('/api/pricelists').catch(() => [] as Pricelist[]),
      ])
      setCustomer(cs.find(c => c.id === ord.restaurantId) ?? null)
      setPricelists(pls)
      if (ord.pricelistId) setPricelist(pls.find(p => p.id === ord.pricelistId) ?? null)

      const productIds = Array.from(new Set((ord.lines ?? []).map(l => l.productId).filter(Boolean)))
      if (productIds.length > 0) {
        apiGet<ForecastRow[]>(`/api/products/forecast?ids=${productIds.join(',')}`)
          .then(rows => {
            const m = new Map<string, ForecastRow>()
            rows.forEach(r => m.set(r.productId, r))
            setForecastMap(m)
          }).catch(() => {})
      }

      apiGet<typeof auditLogs>(`/api/orders/${id}/audit`).then(setAuditLogs).catch(() => {})
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  // 操作历史:动作中文标签 + 兜底创建人条目(导入订单可能无 created 审计记录)
  const ACTION_LABEL: Record<string, string> = { created: '创建', confirmed: '确认', withdrawn: '撤回', cancelled: '取消', updated: '修改' }
  const displayLogs = useMemo(() => {
    if (!order) return auditLogs
    if (auditLogs.some(l => l.action === 'created')) return auditLogs
    const name = (order as unknown as { createdByName?: string }).createdByName
    return [...auditLogs, { id: '__created__', action: 'created', userName: name, createdAt: String(order.createdAt) }]
  }, [auditLogs, order])

  useEffect(() => {
    apiGet<AllProduct[]>('/api/products?limit=500').then(p => setAllProducts(Array.isArray(p) ? p : [])).catch(() => {})
  }, [])

  function deleteLine(idx: number) {
    setEditLines(prev => prev.filter((_, i) => i !== idx))
  }

  function updateLine(idx: number, field: 'orderedQty' | 'unitPrice' | 'taxRate' | 'commissionPrice', value: number) {
    setEditLines(prev => {
      const next = [...prev]
      const line: EditLine = { ...next[idx], [field]: value }
      if (field === 'orderedQty' || field === 'unitPrice') {
        const qty = field === 'orderedQty' ? value : Number(next[idx].orderedQty)
        const price = field === 'unitPrice' ? value : Number(next[idx].unitPrice)
        line.subtotal = Math.round(qty * price * 100) / 100
      }
      next[idx] = line
      return next
    })
  }

  async function handleSave() {
    if (!order) return
    try {
      const newTotalAmount = editLines.length > 0
        ? Math.round(editLines.reduce((s, l) => s + Number(l.subtotal), 0) * 100) / 100
        : undefined
      const slot = driverSlots.find(s => s.id === driverSlotId)
      const batchStr = slot ? `${slot.batchNum} ${slot.timeOfDay} ${slot.driverName}` : deliveryBatch
      await apiPut(`/api/orders/${order.id}`, {
        internalNote, deliveryBatch: batchStr, driverSlotId: driverSlotId || null,
        pricelistId: pricelistId || null, priceType,
        ...(editLines.length > 0 && { lines: editLines, totalAmount: newTotalAmount }),
      })
      toast.success('已保存')
      setEditing(false)
      setEditLines([])
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  async function handleWithdraw() {
    if (!order) return
    if (!confirm(`确认将销售单 ${displayOrderCode(order)} 撤回到报价单状态？`)) return
    try {
      await apiPut(`/api/orders/${order.id}`, { status: 'PENDING', confirmationDate: null })
      toast.success('已撤回到报价单')
      router.push(`${prefix}/classic/operator/quotations/${order.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '撤回失败')
    }
  }

  async function handleDeleteOrder() {
    if (!order) return
    if (!confirm(`确认删除报价单 ${displayOrderCode(order)}？此操作不可撤销。`)) return
    try {
      await apiDelete(`/api/orders/${order.id}`)
      toast.success('报价单已删除')
      router.push(`${prefix}/classic/operator/quotations`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  async function handlePrint() {
    if (!order || printing) return
    setPrinting(true)
    try {
      await apiPost(`/api/orders/${order.id}/mark-printed`, { type: 'SALES' })
      window.open(`${prefix}/classic/print/${order.id}`, '_blank')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打印失败')
    } finally {
      setPrinting(false)
    }
  }

  async function handleApproveEdit(approved: boolean) {
    if (!order) return
    setApproving(true)
    try {
      await apiPut(`/api/orders/${order.id}/approve-edit`, {
        approved,
        ...(!approved && rejectReason ? { reason: rejectReason } : {}),
      })
      toast.success(approved ? '已批准编辑' : '已驳回编辑')
      setShowRejectInput(false)
      setRejectReason('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      setApproving(false)
    }
  }

  const productRefMap = useMemo(() => {
    const m = new Map<string, string>()
    allProducts.forEach(p => { if (p.internalRef) m.set(p.id, p.internalRef) })
    return m
  }, [allProducts])

  const editFormRef = useRef<HTMLDivElement>(null)
  const handleTabNav = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const container = editFormRef.current
    if (!container) return
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(
      'input:not([disabled]):not([type=hidden]), select:not([disabled])'
    ))
    if (focusable.length === 0) return
    const idx = focusable.indexOf(e.target as HTMLElement)
    if (idx === -1) return
    const next = e.shiftKey ? idx - 1 : idx + 1
    if (next >= 0 && next < focusable.length) {
      e.preventDefault()
      focusable[next].focus()
    }
  }, [])

  if (loading) return <div className="text-center py-20 text-gray-400">Loading…</div>
  if (!order) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-400 mb-4">订单不存在</p>
        <button onClick={() => router.push(`${prefix}/classic/operator/orders`)}
          className="px-4 py-2 border border-gray-300 rounded text-sm">返回销售单</button>
      </div>
    )
  }

  const statusUp = order.status.toUpperCase()
  const isConfirmed = statusUp === 'CONFIRMED'
  const isLocked = statusUp === 'LOCKED' || statusUp === 'CANCELLED'
  const balance = customer ? Number((customer as unknown as { balance?: number }).balance ?? 0) : 0
  const lines = order.lines ?? []
  const displayLines = editing && editLines.length > 0 ? editLines : lines
  const subtotalExTax = displayLines.reduce((s, l) => s + Number(l.subtotal) / (1 + Number(l.taxRate ?? 0) / 100), 0)
  const displayTotal = editing && editLines.length > 0
    ? displayLines.reduce((s, l) => s + Number(l.subtotal), 0)
    : Number(order.totalAmount)

  const totalTax = displayTotal - subtotalExTax
  const margin = displayLines.reduce((s, l) => {
    const cost = Number((l as unknown as { cost?: number }).cost ?? 0)
    return s + (Number(l.unitPrice) - cost) * Number(l.orderedQty)
  }, 0)
  const commissionTotal = displayLines.reduce((s, l) => {
    const cms = Number((l as unknown as { commissionPrice?: number }).commissionPrice ?? 0)
    return s + cms * Number(l.orderedQty)
  }, 0)

  return (
    <div className="min-h-screen" style={{ background: '#f5f5f5' }}>
      {/* P1-6: Edit approval banner */}
      {(order as unknown as { editApprovalRequired?: boolean }).editApprovalRequired && (
        <div className="bg-amber-50 border-b border-amber-300 px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-amber-800">
              <span className="text-lg">⚠️</span>
              <span className="font-medium text-sm">此订单已在确认后被修改，需要审批</span>
            </div>
            <div className="flex items-center gap-2">
              {showRejectInput ? (
                <>
                  <input
                    value={rejectReason}
                    onChange={e => setRejectReason(e.target.value)}
                    placeholder="驳回原因（可选）"
                    className="border border-amber-400 rounded px-2 py-1 text-sm w-48 focus:outline-none"
                  />
                  <button onClick={() => handleApproveEdit(false)} disabled={approving}
                    className="h-8 px-3 text-sm rounded bg-red-600 text-white font-medium disabled:opacity-50">
                    确认驳回
                  </button>
                  <button onClick={() => setShowRejectInput(false)}
                    className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700">
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => handleApproveEdit(true)} disabled={approving}
                    className="h-8 px-4 text-sm rounded bg-green-600 text-white font-medium disabled:opacity-50">
                    批准
                  </button>
                  <button onClick={() => setShowRejectInput(true)} disabled={approving}
                    className="h-8 px-3 text-sm rounded bg-red-600 text-white font-medium disabled:opacity-50">
                    驳回
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="bg-white border-b border-gray-200 px-6 pt-3 pb-2">
        <div className="text-sm">
          <button onClick={() => router.push(`${prefix}/classic/operator/orders`)}
            className="hover:underline" style={{ color: PURPLE }}>销售单</button>
          <span className="text-gray-400 mx-1">/</span>
          <span className="text-gray-700">{displayOrderCode(order)}</span>
        </div>
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2">
            {!editing ? (
              <button onClick={() => {
                setEditLines(lines.map(l => ({
                  ...l,
                  subtotal: Math.round(Number(l.orderedQty) * Number(l.unitPrice) * 100) / 100,
                  commissionPrice: (l as unknown as { commissionPrice?: number }).commissionPrice ?? 0,
                })))
                setEditing(true)
              }} disabled={isLocked}
                className="h-8 px-4 text-sm rounded text-white font-medium disabled:opacity-50"
                style={{ background: PURPLE }}>Edit</button>
            ) : (
              <>
                <button onClick={handleSave}
                  className="h-8 px-4 text-sm rounded text-white font-medium"
                  style={{ background: PURPLE }}>Save</button>
                <button onClick={() => { setEditing(false); setEditLines([]); load() }}
                  className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">Discard</button>
              </>
            )}
            <div className="h-5 w-px bg-gray-200 mx-1" />
            <button
              onClick={handlePrint}
              disabled={printing}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              Print
            </button>
            {isConfirmed && !editing && (
              <button onClick={handleWithdraw}
                className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
                撤回到报价单
              </button>
            )}
            {statusUp === 'PENDING' && !editing && (
              <button onClick={handleDeleteOrder}
                className="h-8 px-3 text-sm rounded border border-red-300 bg-white text-red-600 hover:bg-red-50">
                删除
              </button>
            )}
          </div>
          <span className={`inline-block px-3 py-1 rounded text-xs font-medium ${STATUS_COLOR[statusUp] ?? 'bg-gray-100 text-gray-600'}`}>
            {STATUS_LABEL[statusUp] ?? order.status}
          </span>
        </div>

        {/* Status flow */}
        <div className="flex items-center gap-1 mt-3 pb-1">
          <span className="px-3 py-1 text-xs rounded-full text-gray-400">Quotation</span>
          <span className="text-gray-300">›</span>
          <span className="px-3 py-1 text-xs rounded-full text-gray-400">Quotation Sent</span>
          <span className="text-gray-300">›</span>
          <span className="px-3 py-1 text-xs rounded-full text-white font-medium" style={{ background: PURPLE }}>Sales Order</span>
        </div>
      </div>

      <div className="px-6 py-4" ref={editFormRef} onKeyDown={editing ? handleTabNav : undefined}>
        {/* Header card */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
          <div className="flex items-start justify-between">
            <h1 className="text-3xl font-bold text-gray-800">{displayOrderCode(order)}</h1>
            <div className="flex items-center gap-2 px-3 py-2 rounded bg-gray-100">
              <span className="text-xl">🚚</span>
              <div className="text-xs">
                <div className="font-bold text-gray-800">{deliveryBatch ? 1 : 0}</div>
                <div className="text-gray-500">Delivery</div>
              </div>
            </div>
          </div>

          {editing && (
            <div className="mt-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-sm">
              <span>✏️</span>
              <span className="font-medium">Editing</span>
              <span className="text-amber-500 text-xs">— highlighted fields below are editable</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-12 mt-6">
            {/* Left col */}
            <div className="space-y-3 text-sm">
              <div className="flex">
                <div className="w-32 font-bold text-gray-700">Customer</div>
                <div className="flex-1">
                  <div style={{ color: PURPLE }} className="font-medium">{order.restaurantName}</div>
                  {customer?.address && <div className="text-xs text-gray-500">{customer.address}</div>}
                </div>
              </div>
              <div className="flex">
                <div className="w-32 font-bold text-gray-700">Balance</div>
                <div className={balance < 0 ? 'text-red-600' : 'text-gray-800'}>€ {balance.toFixed(2)}</div>
              </div>
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Internal Notes</div>
                {editing ? (
                  <input value={internalNote} onChange={e => setInternalNote(e.target.value)}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none" maxLength={30} />
                ) : <div className="text-gray-700">{internalNote || '—'}</div>}
              </div>
            </div>

            {/* Right col */}
            <div className="space-y-3 text-sm">
              <div className="flex">
                <div className="w-32 font-bold text-gray-700">Order Date</div>
                <div className="text-gray-800">{formatDate(order.quotationDate ?? order.createdAt)}</div>
              </div>
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Delivery Batch</div>
                {editing ? (
                  <select value={driverSlotId} onChange={e => { setDriverSlotId(e.target.value); const s = driverSlots.find(x => x.id === e.target.value); setDeliveryBatch(s ? `${s.batchNum} ${s.timeOfDay} ${s.driverName}` : '') }}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none">
                    <option value="">— unassigned —</option>
                    {driverSlots.map(s => <option key={s.id} value={s.id}>{s.batchNum} {s.timeOfDay} {s.driverName}</option>)}
                  </select>
                ) : <div style={{ color: PURPLE }}>{(order ? formatDriverSlotFromOrder(order) : deliveryBatch) || '—'}</div>}
              </div>
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Pricelist</div>
                {editing ? (
                  <select value={pricelistId} onChange={e => setPricelistId(e.target.value)}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none">
                    <option value="">— none —</option>
                    {pricelists.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                ) : <div style={{ color: PURPLE }}>{pricelist?.name || '—'}</div>}
              </div>
              <div className="flex">
                <div className="w-32 font-bold text-gray-700">Payment Terms</div>
                <div className="text-gray-800">{customer?.paymentTerm ?? '—'}</div>
              </div>
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Price Type</div>
                {editing ? (
                  <select value={priceType} onChange={e => setPriceType(e.target.value)}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none">
                    <option value="multi">Multi-Pricelist</option>
                    <option value="default">Default Price</option>
                    <option value="last">Last Price</option>
                  </select>
                ) : <div className="text-gray-800">{
                  order.priceType === 'multi' ? 'Multi-Pricelist'
                  : order.priceType === 'last' ? 'Last Price'
                  : 'Default Price'
                }</div>}
              </div>
            </div>
          </div>
        </div>

        {/* Tabs + order lines */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
          <div className="border-b border-gray-200 flex">
            {([
              { v: 'lines', label: 'Order Lines' },
              { v: 'optional', label: 'Optional Products' },
              { v: 'automation', label: 'Automation Information' },
              { v: 'other', label: 'Other Information' },
            ] as { v: Tab; label: string }[]).map(t => (
              <button key={t.v} onClick={() => setTab(t.v)}
                className={`px-4 py-3 text-sm ${tab === t.v ? 'font-bold text-gray-900 border-b-2' : 'text-gray-500'}`}
                style={tab === t.v ? { borderColor: PURPLE } : undefined}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'lines' && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs font-bold text-gray-700 align-bottom">
                    <th className="px-2 py-3 w-6"></th>
                    <th className="px-2 py-3 text-left">NO</th>
                    <th className="px-2 py-3 text-left"><div className="leading-tight">Product<br/>Code</div></th>
                    <th className="px-2 py-3 text-left">Product</th>
                    <th className="px-2 py-3 text-left"><div className="leading-tight">Internal<br/>Reference</div></th>
                    <th className="px-2 py-3 text-left">Description</th>
                    <th className="px-2 py-3 text-right"><div className="leading-tight">Ordered<br/>Qty</div></th>
                    <th className="px-2 py-3 text-right"><div className="leading-tight">Forecast<br/>Quantity</div></th>
                    <th className="px-2 py-3 text-right"><div className="leading-tight">Quantity<br/>On Hand</div></th>
                    <th className="px-2 py-3 text-right"><div className="leading-tight">Delivered<br/>Quantity</div></th>
                    <th className="px-2 py-3 text-right"><div className="leading-tight">Invoiced<br/>Quantity</div></th>
                    <th className="px-2 py-3 text-left"><div className="leading-tight">Unit of<br/>Measure</div></th>
                    <th className="px-2 py-3 text-right"><div className="leading-tight">Unit<br/>Price</div></th>
                    <th className="px-2 py-3 text-right">Cost</th>
                    <th className="px-2 py-3 text-center">Price</th>
                    <th className="px-2 py-3 text-center">Taxes</th>
                    <th className="px-2 py-3 text-right"><div className="leading-tight">Cms<br/>Price</div></th>
                    <th className="px-2 py-3 text-right"><div className="leading-tight">Cms<br/>Sub</div></th>
                    <th className="px-2 py-3 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {displayLines.map((l, i) => {
                    const fc = forecastMap.get(l.productId)
                    const cost = Number((l as unknown as { cost?: number }).cost ?? 0)
                    const cms = Number((l as unknown as { commissionPrice?: number }).commissionPrice ?? 0)
                    const taxPct = l.taxRate != null && Number(l.taxRate) > 0 ? Number(l.taxRate).toFixed(1) + '%' : '0%'
                    const inputCls = 'w-20 text-right border border-amber-400 rounded px-1 py-0.5 text-xs bg-amber-50 focus:outline-none focus:ring-1 focus:ring-amber-300 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'
                    return (
                      <tr key={l.id} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="px-2 py-2">
                          {editing && l.productId
                            ? <button onClick={() => deleteLine(i)} className="text-red-400 hover:text-red-600 leading-none"><Trash2 className="h-3.5 w-3.5" /></button>
                            : <span className="text-gray-300">▶</span>}
                        </td>
                        <td className="px-2 py-2 text-gray-700">{i + 1}</td>
                        <td className="px-2 py-2 text-gray-500 text-xs">{(l as unknown as { internalRef?: string }).internalRef || productRefMap.get(l.productId) || ''}</td>
                        <td className="px-2 py-2" style={{ color: PURPLE }}>{l.productName}</td>
                        <td className="px-2 py-2 text-gray-500 text-xs">{(l as unknown as { internalRef?: string }).internalRef || productRefMap.get(l.productId) || ''}</td>
                        <td className="px-2 py-2 text-gray-600 text-xs">{l.spec || ''}</td>
                        <td className="px-2 py-2 text-right">
                          {editing ? (
                            <input type="number" step="0.001" min="0" className={inputCls}
                              value={Number(l.orderedQty)}
                              onChange={e => updateLine(i, 'orderedQty', Number(e.target.value))} />
                          ) : Number(l.orderedQty).toFixed(3)}
                        </td>
                        <td className="px-2 py-2 text-right text-emerald-700">{fc ? Number(fc.forecast).toFixed(3) : '—'}</td>
                        <td className="px-2 py-2 text-right">{fc ? Number(fc.qtyOnHand).toFixed(3) : '—'}</td>
                        <td className="px-2 py-2 text-right text-blue-700">{Number(l.deliveredQty).toFixed(3)}</td>
                        <td className="px-2 py-2 text-right text-purple-700">{Number(l.invoicedQty).toFixed(3)}</td>
                        <td className="px-2 py-2 text-gray-600">{l.uomName ?? 'Unit(s)'}</td>
                        <td className="px-2 py-2 text-right">
                          {editing ? (
                            <input type="number" step="0.01" min="0" className={inputCls}
                              value={Number(l.unitPrice)}
                              onChange={e => updateLine(i, 'unitPrice', Number(e.target.value))} />
                          ) : Number(l.unitPrice).toFixed(2)}
                        </td>
                        <td className="px-2 py-2 text-right text-gray-400">{cost.toFixed(2)}</td>
                        <td className="px-2 py-2 text-center">
                          <button className="px-2 py-0.5 border border-gray-300 rounded text-xs text-gray-500">Price</button>
                        </td>
                        <td className="px-2 py-2 text-center">
                          {editing ? (
                            <input type="number" step="0.1" min="0"
                              className="w-16 text-right border border-amber-400 rounded px-1 py-0.5 text-xs bg-amber-50 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                              value={Number(l.taxRate ?? 0)}
                              onChange={e => updateLine(i, 'taxRate', Number(e.target.value))} />
                          ) : <span className="px-1.5 py-0.5 bg-gray-100 rounded text-xs text-gray-600">{taxPct}</span>}
                        </td>
                        <td className="px-2 py-2 text-right text-gray-600">{cms.toFixed(2)}</td>
                        <td className="px-2 py-2 text-right" style={{ color: PURPLE }}>€ {(cms * Number(l.orderedQty)).toFixed(2)}</td>
                        <td className="px-2 py-2 text-right font-bold" style={{ color: PURPLE }}>€ {Number(l.subtotal).toFixed(2)}</td>
                      </tr>
                    )
                  })}
                  {displayLines.length === 0 && (
                    <tr><td colSpan={19} className="px-3 py-8 text-center text-gray-400">暂无明细</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab !== 'lines' && (
            <div className="p-12 text-center text-gray-400 text-sm">No data on this tab yet.</div>
          )}

          {/* Totals */}
          <div className="border-t border-gray-200 px-6 py-4 flex items-start justify-between bg-gray-50">
            <div className="text-sm text-gray-600">
              <span className="font-bold">Commission Total</span>
              <span className="ml-3">€ {commissionTotal.toFixed(2)}</span>
            </div>
            <div className="text-sm text-right space-y-1 min-w-[260px]">
              <div className="flex justify-between"><span className="text-gray-600">Untaxed Amount:</span><span className="text-gray-800">€ {subtotalExTax.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-gray-600">Taxes:</span><span className="text-gray-800">€ {totalTax.toFixed(2)}</span></div>
              <div className="border-t border-gray-200 my-1" />
              <div className="flex justify-between text-base"><span className="font-bold text-gray-700">Total:</span><span className="font-bold text-gray-900">€ {displayTotal.toFixed(2)}</span></div>
              <div className="flex justify-between text-xs"><span className="text-gray-500">Margin:</span><span className="text-gray-500">€ {margin.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-gray-600">Amount Due:</span><span className="text-gray-800">{displayTotal.toFixed(2)}</span></div>
            </div>
          </div>
        </div>

        {/* P1-5: Audit Log */}
        <div className="bg-white rounded-xl border border-gray-200 mb-4">
          <button
            onClick={() => setShowAuditLog(!showAuditLog)}
            className="w-full flex items-center justify-between px-6 py-3 text-sm font-bold text-gray-700 hover:bg-gray-50"
          >
            <span>修改日志 ({displayLogs.length})</span>
            <span className="text-gray-400">{showAuditLog ? '▲' : '▼'}</span>
          </button>
          {showAuditLog && (
            <div className="border-t border-gray-200 px-6 py-4">
              {displayLogs.length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-4">暂无修改记录</p>
              ) : (
                <div className="space-y-3">
                  {displayLogs.map(log => (
                    <div key={log.id} className="flex items-start gap-3 text-sm">
                      <div className="w-2 h-2 rounded-full bg-purple-400 mt-1.5 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-800">{log.userName || '系统'}</span>
                          <span className="text-gray-400 text-xs">{formatDate(log.createdAt)}</span>
                        </div>
                        <div className="text-gray-600 mt-0.5">{ACTION_LABEL[log.action] ?? log.action}</div>
                        {log.detail && (
                          <pre className="text-xs text-gray-500 mt-1 whitespace-pre-wrap bg-gray-50 rounded p-2">{log.detail}</pre>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Chatter */}
        <OrderChatter orderId={order.id} status={order.status} />
      </div>
    </div>
  )
}
