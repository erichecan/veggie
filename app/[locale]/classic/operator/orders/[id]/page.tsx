'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'
import OrderLineEditor from '@/components/classic/OrderLineEditor'
import { formatDriverSlotFromOrder, type DriverSlotInfo } from '@/lib/driver-slot'
import type { Order, Customer, OdooPricelist as Pricelist } from '@/lib/types'
import { displayOrderCode } from '@/lib/order-code'
import { OrderChatter } from '@/components/order/OrderChatter'
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
  const [externalNote, setExternalNote] = useState('')
  const [deliveryNote, setDeliveryNote] = useState('')
  const [showDeliveryNoteModal, setShowDeliveryNoteModal] = useState(false)
  const [savingDeliveryNote, setSavingDeliveryNote] = useState(false)
  const [noteTab, setNoteTab] = useState<'internal' | 'external'>('internal')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [salesUserId, setSalesUserId] = useState('')
  const [salesUsers, setSalesUsers] = useState<{ id: string; name: string }[]>([])
  useEffect(() => { apiGet<{ id: string; name: string }[]>('/api/users?role=SALES').then(setSalesUsers).catch(() => {}) }, [])
  const [deliveryBatch, setDeliveryBatch] = useState('')
  const [driverSlotId, setDriverSlotId] = useState('')
  const [pricelistId, setPricelistId] = useState('')
  const [priceType, setPriceType] = useState('multi')
  const [driverSlots, setDriverSlots] = useState<DriverSlotInfo[]>([])

  useEffect(() => {
    apiGet<DriverSlotInfo[]>('/api/driver-slots').then(d => setDriverSlots(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  type EditLine = NonNullable<Order['lines']>[number]
  const [editLines, setEditLines] = useState<EditLine[]>([])
  // 重复商品检测：同一 productId 在编辑缓冲区中出现多次（与 place-order 创建页一致）
  const duplicateCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const l of editLines) if (l.productId) counts.set(l.productId, (counts.get(l.productId) ?? 0) + 1)
    return counts
  }, [editLines])
  const [allProducts, setAllProducts] = useState<AllProduct[]>([])

  // P1-5: audit log
  const [auditLogs, setAuditLogs] = useState<{ id: string; action: string; detail?: string; userName?: string; createdAt: string }[]>([])
  const [showAuditLog, setShowAuditLog] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const ord = await apiGet<Order>(`/api/orders/${id}`)
      setOrder(ord)
      setInternalNote(ord.internalNote ?? '')
      setExternalNote((ord as unknown as { externalNote?: string }).externalNote ?? '')
      setDeliveryNote((ord as unknown as { deliveryNote?: string }).deliveryNote ?? '')
      setDeliveryDate(ord.deliveryDate ? new Date(ord.deliveryDate).toISOString().slice(0, 10) : '')
      setSalesUserId((ord as unknown as { salesUserId?: string }).salesUserId ?? '')
      setDeliveryBatch(ord.deliveryBatch ?? '')
      // 编辑态司机预选与显示态同源:优先用所属 wave 派生的 currentDriverSlotId,回退下单意向列
      setDriverSlotId((ord as unknown as { currentDriverSlotId?: string; driverSlotId?: string }).currentDriverSlotId
        ?? (ord as unknown as { driverSlotId?: string }).driverSlotId ?? '')
      setPricelistId(ord.pricelistId ?? '')
      setPriceType((ord as unknown as { priceType?: string }).priceType ?? 'multi')

      // 首屏只依赖订单本身:拿到订单即渲染,客户/价格表异步补(不再为一条订单 await 全量客户表)
      if (ord.restaurantId) {
        apiGet<Customer>(`/api/customers/${ord.restaurantId}`).then(setCustomer).catch(() => {})
      }
      apiGet<Pricelist[]>('/api/pricelists')
        .then(pls => {
          setPricelists(pls)
          if (ord.pricelistId) setPricelist(pls.find(p => p.id === ord.pricelistId) ?? null)
        }).catch(() => {})

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
      const newTotalAmount = editLines.length > 0
        ? Math.round(editLines.reduce((s, l) => s + Number(l.subtotal), 0) * 100) / 100
        : undefined
      const slot = driverSlots.find(s => s.id === driverSlotId)
      const batchStr = slot ? `${slot.batchNum} ${slot.timeOfDay} ${slot.driverName}` : deliveryBatch
      await apiPut(`/api/orders/${order.id}`, {
        internalNote, externalNote: externalNote || null, salesUserId: salesUserId || null,
        deliveryDate: deliveryDate ? new Date(deliveryDate).toISOString() : null,
        deliveryBatch: batchStr, driverSlotId: driverSlotId || null,
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
      window.open(`${prefix}/classic/print/${order.id}`, '_blank', 'noopener,noreferrer')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打印失败')
    } finally {
      setPrinting(false)
    }
    load().catch(() => {})
  }

  async function handleSaveDeliveryNote() {
    if (!order || savingDeliveryNote) return
    setSavingDeliveryNote(true)
    try {
      await apiPut(`/api/orders/${order.id}`, { deliveryNote: deliveryNote || null })
      toast.success('Delivery Note 已保存')
      setShowDeliveryNoteModal(false)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSavingDeliveryNote(false)
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
  // 已出发及以后:司机归属由调度台管，详情页不可改派(后端亦拒绝)，编辑态司机字段只读
  const driverLocked = ['IN_DELIVERY', 'COMPLETED', 'LOCKED', 'CANCELLED'].includes(statusUp)
  const balance = customer ? Number((customer as unknown as { balance?: number }).balance ?? 0) : 0
  const lines = order.lines ?? []
  const displayLines = editing && editLines.length > 0 ? editLines : lines
  const subtotalExTax = displayLines.reduce((s, l) => s + Number(l.subtotal), 0)
  const displayTotal = editing && editLines.length > 0
    ? displayLines.reduce((s, l) => s + Number(l.subtotal), 0)
    : Number(order.totalAmount)

  const totalTax = displayLines.reduce((s, l) => s + Number(l.subtotal) * (Number(l.taxRate ?? 0) / 100), 0)
  const margin = displayLines.reduce((s, l) => {
    const cost = Number((l as unknown as { cost?: number }).cost ?? 0)
    return s + (Number(l.unitPrice) - cost) * Number(l.orderedQty)
  }, 0)
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

  return (
    <div className="min-h-screen" style={{ background: '#f5f5f5' }}>
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
              <div className={`flex items-center rounded ${editing && !driverLocked ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Driver</div>
                {editing && !driverLocked ? (
                  <select value={driverSlotId} onChange={e => { setDriverSlotId(e.target.value); const s = driverSlots.find(x => x.id === e.target.value); setDeliveryBatch(s ? `${s.batchNum} ${s.timeOfDay} ${s.driverName}` : '') }}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none">
                    <option value="">— unassigned —</option>
                    {driverSlots.map(s => <option key={s.id} value={s.id}>{s.batchNum} {s.timeOfDay} {s.driverName}</option>)}
                  </select>
                ) : (
                  <div className="flex-1">
                    <span style={{ color: PURPLE }}>{(order ? formatDriverSlotFromOrder(order) : deliveryBatch) || '—'}</span>
                    {editing && driverLocked && <span className="ml-2 text-xs text-gray-400">已出发，改派请到调度台</span>}
                  </div>
                )}
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
              onDeleteLine={(_lineId, i) => deleteLine(i)}
              emptyColSpan={16}
              searchColSpan={15}
              products={allProducts}
              onAddProduct={addProductLine}
              selectOnTab
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
              renderRow={(l, i, { inputCls, deleteButton, focusSearch, firstFieldRef }) => {
                const fc = forecastMap.get(l.productId)
                const cost = Number((l as unknown as { cost?: number }).cost ?? 0)
                const taxPct = l.taxRate != null && Number(l.taxRate) > 0 ? Number(l.taxRate).toFixed(1) + '%' : '0%'
                const isDuplicate = !!l.productId && (duplicateCounts.get(l.productId) ?? 0) > 1
                return (
                  <>
                    <td className="px-2 py-2">
                      {deleteButton ?? <span className="text-gray-300">▶</span>}
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
                    <td className="px-2 py-2 text-center">
                      <button className="px-2 py-0.5 border border-gray-300 rounded text-xs text-gray-500">Price</button>
                    </td>
                    <td className="px-2 py-2 text-center">
                      {editing ? (
                        <select className="w-16 text-right border border-amber-400 rounded px-1 py-0.5 text-xs bg-amber-50 focus:outline-none"
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

          {/* Totals */}
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
      {showDeliveryNoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !savingDeliveryNote && setShowDeliveryNoteModal(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-200">
              <h3 className="text-base font-semibold text-gray-900">Delivery Note</h3>
              <p className="text-xs text-gray-500 mt-0.5">记录第三方替我们送货时的具体信息（会打印在送货单上）</p>
            </div>
            <div className="px-5 py-4">
              <textarea
                value={deliveryNote}
                onChange={e => setDeliveryNote(e.target.value)}
                rows={5}
                placeholder="例如：由 XX 物流代送，联系人 XX，电话 XXX，送货时间 XX…"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#714b67]/40 resize-y"
              />
            </div>
            <div className="px-5 py-4 border-t border-gray-200 flex justify-end gap-2">
              <button
                onClick={() => setShowDeliveryNoteModal(false)}
                disabled={savingDeliveryNote}
                className="px-4 py-1.5 border border-gray-300 rounded text-sm hover:bg-gray-50 disabled:opacity-40"
              >
                取消
              </button>
              <button
                onClick={handleSaveDeliveryNote}
                disabled={savingDeliveryNote}
                className="px-4 py-1.5 bg-[#714b67] text-white rounded text-sm font-medium hover:bg-[#5d3d55] disabled:opacity-40"
              >
                {savingDeliveryNote ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
