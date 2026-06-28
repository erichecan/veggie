'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import { Trash2 } from 'lucide-react'
import { formatDriverSlotFromOrder, type DriverSlotInfo } from '@/lib/driver-slot'
import type { Order, Customer, OdooPricelist as Pricelist } from '@/lib/types'
import { displayOrderCode } from '@/lib/order-code'
import { formatDateTimeShort } from '@/lib/format-date'
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
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
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

export default function QuotationDetailPage() {
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
  const [confirming, setConfirming] = useState(false)
  const [auditLogs, setAuditLogs] = useState<{ id: string; action: string; detail?: string; userName?: string; createdAt: string }[]>([])
  const [showAuditLog, setShowAuditLog] = useState(false)
  const [cancelModalOpen, setCancelModalOpen] = useState(false)
  // Editable buffer
  const [internalNote, setInternalNote] = useState('')
  const [externalNote, setExternalNote] = useState('')
  const [noteTab, setNoteTab] = useState<'internal' | 'external'>('internal')
  const [salesman, setSalesman] = useState('')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [deliveryBatch, setDeliveryBatch] = useState('')
  const [driverSlotId, setDriverSlotId] = useState('')
  const [pricelistId, setPricelistId] = useState('')
  const [priceType, setPriceType] = useState('multi')
  const [driverSlots, setDriverSlots] = useState<DriverSlotInfo[]>([])
  useEffect(() => { apiGet<DriverSlotInfo[]>('/api/driver-slots').then(setDriverSlots).catch(() => {}) }, [])

  type EditLine = NonNullable<Order['lines']>[number] & { commissionPrice?: number }
  const [editLines, setEditLines] = useState<EditLine[]>([])
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [handleActive, setHandleActive] = useState(false)

  const [allProducts, setAllProducts] = useState<AllProduct[]>([])
  const [addLineQuery, setAddLineQuery] = useState('')
  const [addLineOpen, setAddLineOpen] = useState(false)
  const [addLineHighlight, setAddLineHighlight] = useState(-1)
  const addLineRef = useRef<HTMLDivElement>(null)
  const addLineInputRef = useRef<HTMLInputElement>(null)
  const addLinePortalRef = useRef<HTMLDivElement>(null)
  const [addLineRect, setAddLineRect] = useState<{ top: number; left: number; width: number } | null>(null)

  async function load() {
    setLoading(true)
    try {
      const ord = await apiGet<Order>(`/api/orders/${id}`)
      setOrder(ord)
      setInternalNote(ord.internalNote ?? '')
      setExternalNote((ord as unknown as { externalNote?: string }).externalNote ?? '')
      setSalesman((ord as unknown as { salesman?: string }).salesman ?? '')
      setDeliveryDate(ord.deliveryDate ? new Date(ord.deliveryDate).toISOString().slice(0, 10) : '')
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

      apiGet<typeof auditLogs>(`/api/orders/${id}/audit`).then(setAuditLogs).catch(() => {})

      const productIds = Array.from(new Set((ord.lines ?? []).map(l => l.productId).filter(Boolean)))
      if (productIds.length > 0) {
        apiGet<ForecastRow[]>(`/api/products/forecast?ids=${productIds.join(',')}`)
          .then(rows => {
            const m = new Map<string, ForecastRow>()
            rows.forEach(r => m.set(r.productId, r))
            setForecastMap(m)
          }).catch(() => {})
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  useEffect(() => {
    apiGet<AllProduct[]>('/api/products?limit=500').then(p => setAllProducts(Array.isArray(p) ? p : [])).catch(() => {})
  }, [])

  // 操作历史:动作中文标签 + 兜底创建人条目(导入订单可能无 created 审计记录)
  const ACTION_LABEL: Record<string, string> = { created: '创建', confirmed: '确认', withdrawn: '撤回', cancelled: '取消', updated: '修改' }
  const displayLogs = useMemo(() => {
    if (!order) return auditLogs
    if (auditLogs.some(l => l.action === 'created')) return auditLogs
    const name = (order as unknown as { createdByName?: string }).createdByName
    return [...auditLogs, { id: '__created__', action: 'created', userName: name, createdAt: String(order.createdAt) }]
  }, [auditLogs, order])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const clickedInWrapper = addLineRef.current?.contains(e.target as Node)
      const clickedInPortal = addLinePortalRef.current?.contains(e.target as Node)
      if (!clickedInWrapper && !clickedInPortal) setAddLineOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Status flow
  const flowSegment: 'quotation' | 'sale' = useMemo(() => {
    if (!order) return 'quotation'
    return order.status.toUpperCase() === 'PENDING' ? 'quotation' : 'sale'
  }, [order])

  function deleteLine(idx: number) {
    setEditLines(prev => prev.filter((_, i) => i !== idx))
  }

  function moveLine(from: number, to: number) {
    setEditLines(prev => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
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
      const newTotalAmount = Math.round(editLines.reduce((s, l) => s + Number(l.subtotal), 0) * 100) / 100
      const orderedLines = editLines.map((l, idx) => ({ ...l, sequence: idx }))
      await apiPut(`/api/orders/${order.id}`, {
        internalNote, externalNote: externalNote || null, salesman,
        deliveryDate: deliveryDate ? new Date(deliveryDate).toISOString() : null,
        driverSlotId: driverSlotId || null,
        deliveryBatch: driverSlotId ? (() => { const s = driverSlots.find(x => x.id === driverSlotId); return s ? `${s.batchNum} ${s.timeOfDay} ${s.driverName}` : deliveryBatch })() : deliveryBatch,
        pricelistId: pricelistId || null,
        priceType,
        lines: orderedLines,
        totalAmount: newTotalAmount,
      })
      toast.success('Saved')
      setEditing(false)
      setEditLines([])
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    }
  }

  async function handleConfirm() {
    if (!order || confirming) return
    setConfirming(true)
    try {
      await apiPut(`/api/orders/${order.id}`, { status: 'CONFIRMED' })
      toast.success('Quotation confirmed')
      router.push(`${prefix}/classic/operator/orders/${order.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Confirm failed')
      setConfirming(false)
    }
  }

  async function handleSend() {
    if (!order) return
    try {
      await apiPut(`/api/orders/${order.id}`, { sentAt: new Date().toISOString() })
      toast.success('Marked as sent')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    }
  }

  function handleCancel() {
    if (!order) return
    setCancelModalOpen(true)
  }

  async function handleConfirmCancel() {
    if (!order) return
    try {
      await apiPut(`/api/orders/${order.id}`, { status: 'CANCELLED' })
      toast.success('报价单已取消')
      router.push(`${prefix}/classic/operator/quotations`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '取消失败')
    } finally {
      setCancelModalOpen(false)
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
        <p className="text-gray-400 mb-4">Quotation not found</p>
        <button onClick={() => router.push(`${prefix}/classic/operator/quotations`)}
          className="px-4 py-2 border border-gray-300 rounded text-sm">Back to Quotations</button>
      </div>
    )
  }

  const statusUp = order.status.toUpperCase()
  const isQuotation = statusUp === 'PENDING'
  const isSalesOrder = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED'].includes(statusUp)
  const isLocked = statusUp === 'LOCKED' || statusUp === 'CANCELLED'
  const balance = customer ? Number((customer as unknown as { balance?: number }).balance ?? 0) : 0
  const lines = order.lines ?? []
  const displayLines = editing ? editLines : lines
  const subtotalExTax = displayLines.reduce((s, l) => s + Number(l.subtotal) / (1 + Number(l.taxRate ?? 0) / 100), 0)
  const displayTotal = editing
    ? displayLines.reduce((s, l) => s + Number(l.subtotal), 0)
    : Number(order.totalAmount)

  const filteredProducts = allProducts
    .filter(p => p.name.toLowerCase().includes(addLineQuery.toLowerCase()))
    .slice(0, 20)

  function addProductLine(p: AllProduct) {
    const price = Number(p.listPrice ?? 0)
    const newLine = {
      id: '',
      orderId: order!.id,
      productId: p.id,
      productName: p.name,
      spec: null,
      uomId: p.uomId ?? null,
      uomName: p.uomName ?? 'Unit(s)',
      unitPrice: price,
      orderedQty: 1,
      deliveredQty: 0,
      invoicedQty: 0,
      subtotal: Math.round(price * 100) / 100,
      taxRate: Number(p.customerTaxRate ?? 0),
      sequence: editLines.length,
      commissionPrice: Number(p.commissionPrice ?? 0),
      cost: Number(p.standardPrice ?? 0),
    } as unknown as EditLine
    setEditLines(prev => [...prev, newLine])
    setAddLineQuery('')
    setAddLineOpen(false)
    setAddLineHighlight(-1)
  }
  const totalTax = displayTotal - subtotalExTax
  const margin = displayLines.reduce((s, l) => {
    const cost = Number((l as unknown as { cost?: number }).cost ?? 0)
    return s + (Number(l.unitPrice) - cost) * Number(l.orderedQty)
  }, 0)
  const commissionTotal = displayLines.reduce((s, l) => {
    const cms = Number((l as unknown as { commissionPrice?: number }).commissionPrice ?? 0)
    return s + cms * Number(l.orderedQty)
  }, 0)

  function StatusPill({ label, active, dim }: { label: string; active?: boolean; dim?: boolean }) {
    return (
      <span className={`px-3 py-1 text-xs rounded-full ${active ? 'text-white font-medium' : dim ? 'text-gray-400' : 'text-gray-600'}`}
        style={active ? { background: PURPLE } : undefined}>{label}</span>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: '#f5f5f5' }}>
      {/* Region 1: Breadcrumb + action bar */}
      <div className="bg-white border-b border-gray-200 px-6 pt-3 pb-2">
        <div className="text-sm">
          <button onClick={() => router.push(`${prefix}/classic/operator/quotations`)}
            className="hover:underline" style={{ color: PURPLE }}>Quotations</button>
          <span className="text-gray-400 mx-1">/</span>
          <span className="text-gray-700">{displayOrderCode(order)}</span>
        </div>
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2">
            {!editing ? (
              <button onClick={() => {
                setEditLines(lines.map(l => {
                  const qty = Number(l.orderedQty)
                  const price = Number(l.unitPrice)
                  return {
                    ...l,
                    subtotal: Math.round(qty * price * 100) / 100,
                    commissionPrice: (l as unknown as { commissionPrice?: number }).commissionPrice ?? 0,
                  }
                }))
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
            <button onClick={() => router.push(`${prefix}/classic/operator/place-order`)}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">Create</button>
            <div className="h-5 w-px bg-gray-200 mx-1" />
            <button
              onClick={() => window.open(`${prefix}/classic/print/${order.id}`, '_blank')}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
              Print
            </button>
            {isQuotation && (
              <button onClick={handleConfirm} disabled={confirming}
                className="h-8 px-3 text-sm rounded border border-gray-300 bg-white disabled:opacity-50"
                style={{ color: PURPLE }}>
                {confirming ? 'Confirming…' : 'Confirm'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 text-sm text-gray-500">
            <span>1 / 40</span>
            <button className="h-7 w-7 border border-gray-300 rounded ml-2">‹</button>
            <button className="h-7 w-7 border border-gray-300 rounded">›</button>
          </div>
        </div>

        {/* Region 2: secondary actions + status flow */}
        <div className="flex items-center justify-between mt-3">
          <div className="flex items-center gap-2">
            <button disabled={!isSalesOrder}
              onClick={() => router.push(`${prefix}/operator/orders/${order.id}#invoice`)}
              className="h-8 px-3 text-sm rounded text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: PURPLE }}>Create Invoice</button>
            <button
              onClick={() => window.open(`${prefix}/classic/print/${order?.id}`, '_blank')}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">Preview</button>
            <button disabled={!isLocked}
              onClick={async () => {
                if (!order) return
                await apiPut(`/api/orders/${order.id}`, { status: 'COMPLETED', lockedAt: null })
                toast.success('Unlocked')
                await load()
              }}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed">Unlock</button>
            <div className="w-px h-5 bg-gray-300 mx-1" />
            <button onClick={handleCancel} disabled={isLocked}
              className="h-8 px-3 text-sm rounded border border-red-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed">
              取消报价单
            </button>
          </div>
          <div className="flex items-center gap-1">
            <StatusPill label="Quotation" active={flowSegment === 'quotation'} dim={flowSegment !== 'quotation'} />
            <span className="text-gray-300">›</span>
            <StatusPill label="Sales Order" active={flowSegment === 'sale'} dim={flowSegment !== 'sale'} />
          </div>
        </div>
      </div>

      {/* Region 3: Main info card */}
      <div className="px-6 py-4" ref={editFormRef} onKeyDown={editing ? handleTabNav : undefined}>
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
            <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-sm">
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
              <div className={`rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="flex border-b border-gray-200 mb-1">
                  {(['internal', 'external'] as const).map(tab => (
                    <button key={tab} onClick={() => setNoteTab(tab)}
                      className={`px-3 py-1 text-xs font-medium border-b-2 transition-colors ${noteTab === tab ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                      {tab === 'internal' ? '内部备注' : '外部备注'}
                    </button>
                  ))}
                </div>
                {noteTab === 'internal' ? (
                  editing ? (
                    <input value={internalNote} onChange={e => setInternalNote(e.target.value)}
                      className="w-full border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none" maxLength={30}
                      placeholder="仅内部可见，不会打印给客户" />
                  ) : <div className="text-sm text-gray-700">{internalNote || '—'}</div>
                ) : (
                  editing ? (
                    <textarea value={externalNote} onChange={e => setExternalNote(e.target.value)}
                      rows={3} placeholder="会打印在报价单和送货单上，客户可见"
                      className="w-full border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none resize-none" />
                  ) : <div className="text-sm text-gray-700 whitespace-pre-wrap">{externalNote || '—'}</div>
                )}
              </div>
            </div>

            {/* Right col */}
            <div className="space-y-3 text-sm">
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Delivery Date</div>
                {editing ? (
                  <input
                    type="date"
                    value={deliveryDate}
                    onChange={e => setDeliveryDate(e.target.value)}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300"
                  />
                ) : <div className="text-gray-800">{deliveryDate || '—'}</div>}
              </div>
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Delivery Batch</div>
                {editing ? (
                  <select value={driverSlotId} onChange={e => { setDriverSlotId(e.target.value); const s = driverSlots.find(x => x.id === e.target.value); setDeliveryBatch(s ? `${s.batchNum} ${s.timeOfDay} ${s.driverName}` : '') }}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300">
                    <option value="">— unassigned —</option>
                    {driverSlots.map(s => <option key={s.id} value={s.id}>{s.batchNum} {s.timeOfDay} {s.driverName}</option>)}
                  </select>
                ) : <div style={{ color: PURPLE }}>{formatDriverSlotFromOrder(order) || '—'}</div>}
              </div>
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Pricelist</div>
                {editing ? (
                  <select value={pricelistId} onChange={e => setPricelistId(e.target.value)}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300">
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
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Sales Person</div>
                {editing ? (
                  <input
                    type="text"
                    value={salesman}
                    onChange={e => setSalesman(e.target.value)}
                    placeholder="业务员姓名"
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300"
                  />
                ) : <div className="text-gray-800">{salesman || '—'}</div>}
              </div>
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Price Type</div>
                {editing ? (
                  <select value={priceType} onChange={e => setPriceType(e.target.value)}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300">
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

        {/* Region 4: tabs */}
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

          {/* Region 5: order lines table */}
          {tab === 'lines' && (
            <>
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
                      <tr key={l.id}
                        draggable={editing && handleActive}
                        onDragStart={editing ? () => setDragIndex(i) : undefined}
                        onDragOver={editing ? (e) => { e.preventDefault(); if (overIndex !== i) setOverIndex(i) } : undefined}
                        onDrop={editing ? (e) => { e.preventDefault(); if (dragIndex !== null) moveLine(dragIndex, i); setDragIndex(null); setOverIndex(null); setHandleActive(false) } : undefined}
                        onDragEnd={() => { setDragIndex(null); setOverIndex(null); setHandleActive(false) }}
                        className={`border-b border-gray-100 hover:bg-gray-50 ${dragIndex === i ? 'opacity-40' : ''} ${editing && overIndex === i && dragIndex !== null && dragIndex !== i ? 'border-t-2 border-t-[#875A7B]' : ''}`}>
                        <td className="px-2 py-2">
                          {editing ? (
                            <div className="flex items-center gap-1.5">
                              <span
                                title="拖动以调整顺序"
                                onMouseDown={() => setHandleActive(true)}
                                onMouseUp={() => setHandleActive(false)}
                                className="cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-600 select-none leading-none">☰</span>
                              {l.productId && (
                                <button onClick={() => deleteLine(i)} className="text-red-400 hover:text-red-600 leading-none"><Trash2 className="h-3.5 w-3.5" /></button>
                              )}
                            </div>
                          ) : <span className="text-gray-300 select-none" title="编辑后可拖动调整顺序">☰</span>}
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
                              onChange={e => updateLine(i, 'orderedQty', Number(e.target.value))}
                              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addLineInputRef.current?.focus() } }} />
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
                              onChange={e => updateLine(i, 'unitPrice', Number(e.target.value))}
                              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addLineInputRef.current?.focus() } }} />
                          ) : Number(l.unitPrice).toFixed(2)}
                        </td>
                        <td className="px-2 py-2 text-right text-gray-400">{cost.toFixed(2)}</td>
                        <td className="px-2 py-2 text-center"><button className="px-2 py-0.5 border border-gray-300 rounded text-xs text-gray-500">Price</button></td>
                        <td className="px-2 py-2 text-center">
                          {editing ? (
                            <input type="number" step="0.1" min="0" className="w-16 text-right border border-amber-400 rounded px-1 py-0.5 text-xs bg-amber-50 focus:outline-none focus:ring-1 focus:ring-amber-300 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                              value={Number(l.taxRate ?? 0)}
                              onChange={e => updateLine(i, 'taxRate', Number(e.target.value))}
                              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addLineInputRef.current?.focus() } }} />
                          ) : <span className="px-1.5 py-0.5 bg-gray-100 rounded text-xs text-gray-600">{taxPct}</span>}
                        </td>
                        <td className="px-2 py-2 text-right text-gray-600">{cms.toFixed(2)}</td>
                        <td className="px-2 py-2 text-right" style={{ color: PURPLE }}>€ {(cms * Number(l.orderedQty)).toFixed(2)}</td>
                        <td className="px-2 py-2 text-right font-bold" style={{ color: PURPLE }}>€ {Number(l.subtotal).toFixed(2)}</td>
                      </tr>
                    )
                  })}
                  {editing && tab === 'lines' && (
                    <tr>
                      <td className="px-2 py-2" />
                      <td className="px-2 py-2" colSpan={18}>
                        <div ref={addLineRef}>
                          <input
                            ref={addLineInputRef}
                            type="text"
                            value={addLineQuery}
                            placeholder="Add a product"
                            onChange={e => {
                              setAddLineQuery(e.target.value)
                              setAddLineHighlight(-1)
                              setAddLineOpen(true)
                              if (addLineInputRef.current) {
                                const r = addLineInputRef.current.getBoundingClientRect()
                                setAddLineRect({ top: r.bottom + window.scrollY, left: r.left + window.scrollX, width: r.width })
                              }
                            }}
                            onFocus={() => {
                              setAddLineOpen(true)
                              if (addLineInputRef.current) {
                                const r = addLineInputRef.current.getBoundingClientRect()
                                setAddLineRect({ top: r.bottom + window.scrollY, left: r.left + window.scrollX, width: r.width })
                              }
                            }}
                            onKeyDown={e => {
                              if (e.key === 'Escape') {
                                setAddLineOpen(false)
                                setAddLineHighlight(-1)
                                return
                              }
                              if (e.key === 'Tab') {
                                setAddLineOpen(false)
                                return
                              }
                              if (!addLineOpen || filteredProducts.length === 0) return
                              if (e.key === 'ArrowDown') {
                                e.preventDefault()
                                setAddLineHighlight(h => Math.min(h + 1, filteredProducts.length - 1))
                              } else if (e.key === 'ArrowUp') {
                                e.preventDefault()
                                setAddLineHighlight(h => Math.max(h - 1, 0))
                              } else if (e.key === 'Enter') {
                                e.preventDefault()
                                const idx = addLineHighlight >= 0 ? addLineHighlight : 0
                                if (filteredProducts[idx]) addProductLine(filteredProducts[idx])
                              }
                            }}
                            className="border border-dashed border-gray-300 rounded px-3 py-1.5 text-sm text-gray-500 focus:outline-none focus:border-purple-400 bg-transparent w-72"
                          />
                        </div>
                        {addLineOpen && filteredProducts.length > 0 && addLineRect && typeof document !== 'undefined' && createPortal(
                          <div
                            ref={addLinePortalRef}
                            style={{ position: 'absolute', top: addLineRect.top + 2, left: addLineRect.left, width: Math.max(addLineRect.width, 288), zIndex: 9999 }}
                            className="bg-white border border-gray-200 rounded shadow-lg max-h-52 overflow-y-auto"
                          >
                            {filteredProducts.map((p, idx) => (
                              <button
                                key={p.id}
                                type="button"
                                onMouseDown={() => { addProductLine(p); setAddLineHighlight(-1) }}
                                onMouseEnter={() => setAddLineHighlight(idx)}
                                className={`w-full text-left px-3 py-2 text-sm text-gray-700 ${idx === addLineHighlight ? 'bg-[#875A7B]/20' : 'hover:bg-[#875A7B]/20'}`}
                              >
                                {p.name}
                              </button>
                            ))}
                          </div>,
                          document.body
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {editing && (
              <div className="px-4 py-2.5 border-t border-gray-100 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => { setAddLineOpen(true); addLineInputRef.current?.focus() }}
                  className="text-sm text-[#875A7B] hover:underline font-medium"
                >
                  + Add a product
                </button>
              </div>
            )}
            </>
          )}

          {tab !== 'lines' && (
            <div className="p-12 text-center text-gray-400 text-sm">No data on this tab yet.</div>
          )}

          {/* Region 6: totals */}
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

        {/* 修改日志 / 操作历史 */}
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
                          <span className="text-gray-400 text-xs">{formatDateTimeShort(log.createdAt)}</span>
                        </div>
                        <div className="text-gray-600 mt-0.5">{ACTION_LABEL[log.action] ?? log.action}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Region 7: Chatter */}
        <OrderChatter orderId={order.id} status={order.status} />
      </div>

      {cancelModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-bold text-gray-900 mb-2">确认取消此报价单？</h3>
            <p className="text-sm text-gray-600 mb-6">
              取消后订单状态将变为「已取消」，可在列表中查看，但无法恢复为报价中。
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setCancelModalOpen(false)}
                className="h-9 px-4 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
                取消操作
              </button>
              <button
                onClick={handleConfirmCancel}
                className="h-9 px-4 text-sm rounded bg-red-600 text-white hover:bg-red-700 font-medium">
                确认取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
