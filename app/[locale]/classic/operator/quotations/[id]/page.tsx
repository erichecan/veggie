'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import { formatDriverSlotFromOrder, type DriverSlotInfo } from '@/lib/driver-slot'
import OrderLineEditor from '@/components/classic/OrderLineEditor'
import type { Order, Customer, OdooPricelist as Pricelist } from '@/lib/types'
import { displayOrderCode } from '@/lib/order-code'
import { OrderChatter } from '@/components/order/OrderChatter'
import { getSession, type UserSession } from '@/lib/session'
import { resolveCustomerPrice } from '@/lib/pricing-engine'

const PURPLE = '#875A7B'

interface AllProduct {
  id: string
  name: string
  internalRef?: string | null
  listPrice?: number
  standardPrice?: number
  customerTaxRate?: number
  uomName?: string
  uomId?: string
}

interface CreditInfo {
  outstandingBalance: number
  overdueAmount: number
  paymentTerm: string
  creditLimit: number
  canOrder: boolean
  blockReason?: string
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
  const [cancelModalOpen, setCancelModalOpen] = useState(false)
  // Editable buffer
  const [internalNote, setInternalNote] = useState('')
  const [externalNote, setExternalNote] = useState('')
  const [noteTab, setNoteTab] = useState<'internal' | 'external'>('internal')
  const [salesUserId, setSalesUserId] = useState('')
  const [salesUsers, setSalesUsers] = useState<{ id: string; name: string }[]>([])
  useEffect(() => { apiGet<{ id: string; name: string }[]>('/api/users?role=SALES').then(setSalesUsers).catch(() => {}) }, [])
  const [deliveryDate, setDeliveryDate] = useState('')
  const [deliveryBatch, setDeliveryBatch] = useState('')
  const [driverSlotId, setDriverSlotId] = useState('')
  const [pricelistId, setPricelistId] = useState('')
  const [priceType, setPriceType] = useState('multi')
  const [driverSlots, setDriverSlots] = useState<DriverSlotInfo[]>([])
  useEffect(() => { apiGet<DriverSlotInfo[]>('/api/driver-slots').then(setDriverSlots).catch(() => {}) }, [])

  type EditLine = NonNullable<Order['lines']>[number]
  const [editLines, setEditLines] = useState<EditLine[]>([])
  // 重复商品检测：同一 productId 在编辑缓冲区中出现多次（与 place-order 创建页一致）
  const duplicateCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const l of editLines) if (l.productId) counts.set(l.productId, (counts.get(l.productId) ?? 0) + 1)
    return counts
  }, [editLines])
  const [allProducts, setAllProducts] = useState<AllProduct[]>([])
  const [creditInfo, setCreditInfo] = useState<CreditInfo | null>(null)
  const [session, setSession] = useState<UserSession | null>(null)
  useEffect(() => { setSession(getSession()) }, [])

  async function load() {
    setLoading(true)
    try {
      const ord = await apiGet<Order>(`/api/orders/${id}`)
      setOrder(ord)
      setInternalNote(ord.internalNote ?? '')
      setExternalNote((ord as unknown as { externalNote?: string }).externalNote ?? '')
      setSalesUserId((ord as unknown as { salesUserId?: string }).salesUserId ?? '')
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
      if (ord.restaurantId) {
        apiGet<CreditInfo>(`/api/customers/${ord.restaurantId}/credit`).then(setCreditInfo).catch(() => {})
      }


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

  function updateLine(idx: number, field: 'orderedQty' | 'unitPrice' | 'taxRate' | 'spec', value: number | string) {
    setEditLines(prev => {
      const next = [...prev]
      const line: EditLine = { ...next[idx], [field]: value }
      if (field === 'orderedQty' || field === 'unitPrice') {
        const qty = field === 'orderedQty' ? Number(value) : Number(next[idx].orderedQty)
        const price = field === 'unitPrice' ? Number(value) : Number(next[idx].unitPrice)
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
        internalNote, externalNote: externalNote || null, salesUserId: salesUserId || null,
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
  const canOverrideCredit = session?.roles?.includes('BOSS') || session?.roles?.includes('FINANCE') || session?.role === 'BOSS' || session?.role === 'FINANCE'
  const creditBlocked = creditInfo?.canOrder === false && !canOverrideCredit
  const isSalesOrder = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED'].includes(statusUp)
  const isLocked = statusUp === 'LOCKED' || statusUp === 'CANCELLED'
  const balance = customer ? Number((customer as unknown as { balance?: number }).balance ?? 0) : 0
  const lines = order.lines ?? []
  const displayLines = editing ? editLines : lines
  const subtotalExTax = displayLines.reduce((s, l) => s + Number(l.subtotal), 0)
  const displayTotal = editing
    ? displayLines.reduce((s, l) => s + Number(l.subtotal), 0)
    : Number(order.totalAmount)

  function addProductLine(p: AllProduct) {
    const resolution = customer
      ? resolveCustomerPrice(p as never, customer, pricelists)
      : null
    const price = resolution ? resolution.price : Number(p.listPrice ?? 0)
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
      taxRate: Number(p.customerTaxRate ?? 0) * 100,
      sequence: editLines.length,
      cost: Number(p.standardPrice ?? 0),
    } as unknown as EditLine
    setEditLines(prev => [...prev, newLine])
  }
  // 合并重复商品：同一 productId 的行合并为一行，数量相加（与 place-order 创建页一致）
  function mergeDuplicateLines() {
    setEditLines(prev => {
      const seen = new Map<string, EditLine>()
      const result: EditLine[] = []
      for (const l of prev) {
        if (!l.productId) { result.push(l); continue }
        const existing = seen.get(l.productId)
        if (existing) {
          const qty = Number(existing.orderedQty) + Number(l.orderedQty)
          existing.orderedQty = qty
          existing.subtotal = Math.round(Number(existing.unitPrice) * qty * 100) / 100
        } else {
          const copy = { ...l }
          seen.set(l.productId, copy)
          result.push(copy)
        }
      }
      return result
    })
    toast.success('已合并重复商品')
  }
  const totalTax = displayLines.reduce((s, l) => s + Number(l.subtotal) * (Number(l.taxRate ?? 0) / 100), 0)
  const margin = displayLines.reduce((s, l) => {
    const cost = Number((l as unknown as { cost?: number }).cost ?? 0)
    return s + (Number(l.unitPrice) - cost) * Number(l.orderedQty)
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
              onClick={() => window.open(`${prefix}/classic/print/${order.id}`, '_blank', 'noopener,noreferrer')}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
              Print
            </button>
            {isQuotation && (
              <>
                <button onClick={handleConfirm} disabled={confirming || creditBlocked}
                  className="h-8 px-3 text-sm rounded border border-gray-300 bg-white disabled:opacity-50"
                  style={{ color: PURPLE }}>
                  {confirming ? 'Confirming…' : 'Confirm'}
                </button>
                {creditBlocked && (
                  <span className="px-2 py-1 text-xs rounded bg-red-100 text-red-700 font-medium border border-red-200">信用冻结</span>
                )}
              </>
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
            <button onClick={handleCancel} disabled={isLocked}
              className="h-8 px-3 text-sm rounded border border-red-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed">
              取消报价单
            </button>
            <div className="w-px h-5 bg-gray-300 mx-1" />
            <button disabled={!isSalesOrder}
              onClick={() => router.push(`${prefix}/operator/orders/${order.id}#invoice`)}
              className="h-8 px-3 text-sm rounded text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: PURPLE }}>Create Invoice</button>
            <button
              onClick={() => window.open(`${prefix}/classic/print/${order?.id}?preview=1`, '_blank', 'noopener,noreferrer')}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">Preview</button>
            <button disabled={!isLocked}
              onClick={async () => {
                if (!order) return
                await apiPut(`/api/orders/${order.id}`, { status: 'COMPLETED', lockedAt: null })
                toast.success('Unlocked')
                await load()
              }}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed">Unlock</button>
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
              {creditInfo && (
                <div className={`flex flex-wrap gap-3 py-2 px-3 rounded-lg text-xs ${creditInfo.canOrder === false ? 'bg-red-50 border border-red-200' : 'bg-gray-50 border border-gray-200'}`}>
                  <div>
                    <span className="text-gray-500">欠款余额</span>
                    <span className={`ml-1 font-medium ${creditInfo.outstandingBalance > 0 ? 'text-red-600' : 'text-gray-800'}`}>
                      € {creditInfo.outstandingBalance.toFixed(2)}
                    </span>
                  </div>
                  {creditInfo.creditLimit > 0 && (
                    <div>
                      <span className="text-gray-500">信用额度</span>
                      <span className="ml-1 font-medium text-gray-800">€ {creditInfo.creditLimit.toFixed(2)}</span>
                    </div>
                  )}
                  {creditInfo.paymentTerm && (
                    <div>
                      <span className="text-gray-500">付款条件</span>
                      <span className="ml-1 font-medium text-gray-800">{creditInfo.paymentTerm}</span>
                    </div>
                  )}
                  {creditInfo.canOrder === false && (
                    <div className="w-full flex items-center gap-1 text-red-700 font-medium">
                      <span>⚠️</span>
                      <span>{creditInfo.blockReason || '信用冻结，无法确认'}</span>
                      {canOverrideCredit && <span className="text-gray-500 font-normal">(已用管理员权限覆盖)</span>}
                    </div>
                  )}
                </div>
              )}
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
                    <textarea value={internalNote} onChange={e => setInternalNote(e.target.value)}
                      rows={3} maxLength={30}
                      className="w-full border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none resize-none"
                      placeholder="仅内部可见，不会打印给客户" />
                  ) : <div className="text-sm text-gray-700 whitespace-pre-wrap">{internalNote || '—'}</div>
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
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Driver</div>
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
                  <select
                    value={salesUserId}
                    onChange={e => setSalesUserId(e.target.value)}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300"
                  >
                    <option value="">— none —</option>
                    {salesUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                ) : <div className="text-gray-800">{(order as unknown as { salesman?: string })?.salesman || '—'}</div>}
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
            {editing && (() => {
              const dups = [...duplicateCounts.entries()].filter(([, c]) => c > 1)
              if (dups.length === 0) return null
              const nameOf = (pid: string) => editLines.find(l => l.productId === pid)?.productName ?? pid
              return (
                <div className="mx-3 mt-3 rounded-md border border-purple-200 bg-purple-50 px-4 py-2.5 flex items-start gap-3">
                  <span className="text-lg leading-none mt-0.5">🔁</span>
                  <div className="text-sm flex-1">
                    <span className="font-semibold text-purple-700">重复商品提醒：</span>
                    <span className="text-purple-600">
                      {dups.length} 个商品被重复添加
                      <span className="text-xs text-purple-500 ml-1">
                        ({dups.map(([pid, c]) => `${nameOf(pid)} ×${c}`).join('、')})
                      </span>
                    </span>
                    <span className="text-xs text-gray-500 ml-1">— 可点右侧「合并」合并为一行（数量相加），或保留现状手动调整</span>
                  </div>
                  <button
                    onClick={mergeDuplicateLines}
                    className="shrink-0 px-3 py-1 rounded text-xs font-medium text-white"
                    style={{ background: PURPLE }}
                  >
                    合并重复项
                  </button>
                </div>
              )
            })()}
            <OrderLineEditor
              lines={displayLines}
              editing={editing}
              onReorder={moveLine}
              onDeleteLine={(_lineId, i) => deleteLine(i)}
              products={allProducts}
              onAddProduct={addProductLine}
              selectOnTab
              searchColSpan={15}
              emptyColSpan={16}
              renderHeaders={() => (
                <tr className="border-b border-gray-200 text-xs font-bold text-gray-700 align-bottom">
                  <th className="px-2 py-3 w-6"></th>
                  <th className="px-2 py-3 text-left">NO</th>
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
                  <th className="px-2 py-3 text-right">Total</th>
                </tr>
              )}
              renderRow={(l, i, { inputCls, dragHandle, deleteButton, focusSearch, firstFieldRef }) => {
                const fc = forecastMap.get(l.productId)
                const cost = Number((l as unknown as { cost?: number }).cost ?? 0)
                const taxPct = l.taxRate != null && Number(l.taxRate) > 0 ? Number(l.taxRate).toFixed(1) + '%' : '0%'
                const isDuplicate = !!l.productId && (duplicateCounts.get(l.productId) ?? 0) > 1
                return (
                  <>
                    <td className="px-2 py-2">
                      {editing ? (
                        <div className="flex items-center gap-1.5">
                          {dragHandle}
                          {deleteButton}
                        </div>
                      ) : <span className="text-gray-300 select-none" title="编辑后可拖动调整顺序">☰</span>}
                    </td>
                    <td className="px-2 py-2 text-gray-700">
                      {i + 1}
                      {isDuplicate && <span className="ml-1 text-[10px] text-purple-600" title="重复商品">🔁</span>}
                    </td>
                    <td className="px-2 py-2" style={{ color: PURPLE }}>{l.productName}</td>
                    <td className="px-2 py-2 text-gray-500 text-xs">{(l as unknown as { internalRef?: string }).internalRef || productRefMap.get(l.productId) || ''}</td>
                    <td className="px-2 py-2 text-gray-600 text-xs">
                      {editing ? (
                        <input
                          type="text"
                          className="border border-amber-400 rounded px-1 py-0.5 text-xs bg-amber-50 focus:outline-none focus:ring-1 focus:ring-amber-300 w-24"
                          value={l.spec ?? ''}
                          onChange={e => updateLine(i, 'spec', e.target.value)}
                        />
                      ) : (l.spec || '')}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {editing ? (
                        <input type="number" step="0.001" min="0" className={inputCls}
                          ref={firstFieldRef as React.Ref<HTMLInputElement>}
                          value={Number(l.orderedQty)}
                          onChange={e => updateLine(i, 'orderedQty', Number(e.target.value))}
                          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); focusSearch() } }} />
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
                          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); focusSearch() } }} />
                      ) : Number(l.unitPrice).toFixed(2)}
                    </td>
                    <td className="px-2 py-2 text-right text-gray-400">{cost.toFixed(2)}</td>
                    <td className="px-2 py-2 text-center"><button className="px-2 py-0.5 border border-gray-300 rounded text-xs text-gray-500">Price</button></td>
                    <td className="px-2 py-2 text-center">
                      {editing ? (
                        <select className="w-16 text-right border border-amber-400 rounded px-1 py-0.5 text-xs bg-amber-50 focus:outline-none focus:ring-1 focus:ring-amber-300"
                          value={Number(l.taxRate ?? 0)}
                          onChange={e => updateLine(i, 'taxRate', Number(e.target.value))}>
                          <option value={0}>0%</option>
                          <option value={13.5}>13.5%</option>
                          <option value={23}>23%</option>
                        </select>
                      ) : <span className="px-1.5 py-0.5 bg-gray-100 rounded text-xs text-gray-600">{taxPct}</span>}
                    </td>
                    <td className="px-2 py-2 text-right font-bold" style={{ color: PURPLE }}>€ {Number(l.subtotal).toFixed(2)}</td>
                  </>
                )
              }}
            />
            </>
          )}

          {tab !== 'lines' && (
            <div className="p-12 text-center text-gray-400 text-sm">No data on this tab yet.</div>
          )}

          {/* Region 6: totals */}
          <div className="border-t border-gray-200 px-6 py-4 flex items-start justify-end bg-gray-50">
            <div className="text-sm text-right space-y-1 min-w-[260px]">
              <div className="flex justify-between"><span className="text-gray-600">Untaxed Amount:</span><span className="text-gray-800">€ {subtotalExTax.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-gray-600">Taxes:</span><span className="text-gray-800">€ {totalTax.toFixed(2)}</span></div>
              <div className="border-t border-gray-200 my-1" />
              <div className="flex justify-between text-base"><span className="font-bold text-gray-700">Total:</span><span className="font-bold text-gray-900">€ {(subtotalExTax + totalTax).toFixed(2)}</span></div>
              <div className="flex justify-between text-xs"><span className="text-gray-500">Margin:</span><span className="text-gray-500">€ {margin.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-gray-600">Amount Due:</span><span className="text-gray-800">{(subtotalExTax + totalTax).toFixed(2)}</span></div>
            </div>
          </div>
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
