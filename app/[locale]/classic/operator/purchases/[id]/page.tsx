'use client'
import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { apiGet, apiPost, apiPut, apiPatch, authHeaders } from '@/lib/api'
import { formatDateOnly } from '@/lib/format-date'
import { parseStoredQc, lineVerdict, formatQcSummary, QC_REJECT_REASON_LABELS, type QcRejectReason } from '@/lib/purchase/qc'
import ProductSearchInput from '@/components/classic/ProductSearchInput'
import SimilarProductAlert from '@/components/shared/similar-product-alert'

async function openPurchaseOrderPdf(poId: string, isEn: boolean) {
  // JWT 存在 localStorage，直接 window.open API 路由不会带 Authorization 头会 401，
  // 必须先用带鉴权的 fetch 取回 HTML 文本，再开新窗口写入。
  const win = window.open('', '_blank')
  try {
    const res = await fetch(`/api/purchase-orders/${poId}/pdf`, { headers: authHeaders() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    if (win) {
      win.document.open()
      win.document.write(html)
      win.document.close()
    }
  } catch (e) {
    win?.close()
    toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to generate PDF' : 'PDF 生成失败'))
  }
}

const PURPLE = '#875A7B'
const DARK = '#1f2d3d'

type POStatus = 'DRAFT' | 'SENT' | 'CONFIRMED' | 'RECEIVED' | 'INVOICED' | 'LOCKED' | 'TO_APPROVE' | 'CANCELLED'

interface POLine {
  id: string
  sequence: number
  productId?: string | null
  productName: string
  spec?: string | null
  uomName?: string | null
  orderedQty: number
  unitCost: number
  taxRate: number
  bestBefore?: string | null
  subtotalExTax: number
  taxAmount: number
  subtotalIncTax: number
}

interface POBill {
  id: string
  name: string
  status: string
  totalIncTax: number
  createdAt: string
}

interface ActivityLogEntry {
  id: string
  action: string
  detail: string | null
  userName: string
  createdAt: string
}

interface GoodsReceiptRow {
  id: string
  name: string
  arrivedAt: string
  receivedBy?: string | null
  notes?: string | null
  photos?: string[]
  lines: Array<{
    productId: string; productName: string; qty: number
    condition?: 'ok' | 'damaged' | 'rejected'
    /** 收货质检（台账 F4）：随收货行落库，这里是**读取派生**，不另存一份 */
    qc?: unknown
    rejectReason?: QcRejectReason | null
  }>
}

interface PurchaseOrder {
  id: string
  name: string
  status: POStatus
  supplierId: string
  supplierName?: string
  orderDate: string
  expectedDate?: string | null
  notes?: string | null
  lockedAt?: string | null
  editApprovalRequired?: boolean
  currency: string
  exchangeRate?: number | null
  exchangeRatePending?: boolean
  subtotalExTax: number
  totalTax: number
  totalIncTax: number
  totalIncTaxEur?: number | null
  createdAt: string
  lines: POLine[]
  bills?: POBill[]
  receipts?: GoodsReceiptRow[]
  activityLog?: ActivityLogEntry[]
}

interface Supplier {
  id: string
  name: string
  supplierPaymentTerm?: string | null
}

interface PurchaseProduct {
  id: string
  name: string
  internalRef?: string | null
  category?: string | null
  spec?: string | null
  uomId?: string | null
  uomName?: string | null
  standardPrice?: number | null
  price?: number | null
}

interface Category {
  id: string
  name: string
  nameZh?: string | null
}

interface Uom {
  id: string
  name: string
  nameZh?: string | null
}

function toInputDate(iso?: string | null) {
  if (!iso) return ''
  try { return new Date(iso).toISOString().slice(0, 10) } catch { return '' }
}

function OdooStatusBar({ status, isEn }: { status: POStatus; isEn: boolean }) {
  const steps = [
    { label: isEn ? 'Request for Quotation' : '询价单', statuses: ['DRAFT'] as POStatus[] },
    { label: isEn ? 'RFQ Sent' : '询价单已发送', statuses: ['SENT', 'TO_APPROVE'] as POStatus[] },
    { label: isEn ? 'Purchase Order' : '采购订单', statuses: ['CONFIRMED', 'RECEIVED', 'INVOICED'] as POStatus[] },
    { label: isEn ? 'Locked' : '已锁定', statuses: ['LOCKED'] as POStatus[] },
  ]
  const activeIdx = steps.findIndex(s => s.statuses.includes(status))

  if (status === 'CANCELLED') {
    return (
      <span className="px-4 py-1 text-sm font-medium rounded-full" style={{ background: '#fef2f2', color: '#dc2626' }}>
        {isEn ? 'Cancelled' : '已取消'}
      </span>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {status === 'TO_APPROVE' && (
        <span className="px-3 py-1 text-xs font-medium rounded-full" style={{ background: '#fef3cd', color: '#856404' }}>
          {isEn ? 'Pending Approval' : '待审批'}
        </span>
      )}
      <div className="flex items-stretch gap-0" style={{ height: '28px' }}>
        {steps.map((step, i) => {
          const isActive = i === activeIdx
          const isPast = i < activeIdx
          const bg = isActive ? PURPLE : isPast ? '#c8b0d0' : '#ede7f0'
          const color = isActive ? 'white' : isPast ? '#5a3060' : '#9d7ab0'
          const paddingLeft = i === 0 ? 'pl-5' : 'pl-8'

          return (
            <div
              key={step.label}
              className={`relative flex items-center ${paddingLeft} pr-5 text-xs font-medium select-none`}
              style={{
                background: bg,
                color,
                clipPath: i === 0
                  ? 'polygon(0 0, calc(100% - 11px) 0, 100% 50%, calc(100% - 11px) 100%, 0 100%)'
                  : i === steps.length - 1
                  ? 'polygon(0 0, 100% 0, 100% 100%, 0 100%, 11px 50%)'
                  : 'polygon(0 0, calc(100% - 11px) 0, 100% 50%, calc(100% - 11px) 100%, 0 100%, 11px 50%)',
                marginLeft: i > 0 ? '-1px' : '0',
              }}
            >
              {isActive && <span className="mr-1.5 text-xs">●</span>}
              {step.label}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function PurchaseDetailPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale
  const params = useParams<{ id: string }>()
  const id = params.id

  const [po, setPo] = useState<PurchaseOrder | null>(null)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [acting, setActing] = useState(false)
  const [activeTab, setActiveTab] = useState<'products' | 'other'>('products')

  const [editNotes, setEditNotes] = useState('')
  const [editExpectedDate, setEditExpectedDate] = useState('')
  const [editSupplierId, setEditSupplierId] = useState('')
  const [editLines, setEditLines] = useState<POLine[]>([])

  // 汇率待确认时的独立补录输入(不进整单编辑态，DRAFT/SENT 都能直接补)
  const [fixRateInput, setFixRateInput] = useState('')
  const [fixingRate, setFixingRate] = useState(false)

  // ── 选品 / 快速建档 ──
  const [purchaseProducts, setPurchaseProducts] = useState<PurchaseProduct[]>([])
  const [productQuery, setProductQuery] = useState('')
  const [categories, setCategories] = useState<Category[]>([])
  const [uoms, setUoms] = useState<Uom[]>([])
  const [showQuickCreate, setShowQuickCreate] = useState(false)
  const [qcName, setQcName] = useState('')
  const [qcCategoryId, setQcCategoryId] = useState('')
  const [qcUomId, setQcUomId] = useState('')
  const [qcUnitCost, setQcUnitCost] = useState('')
  const [qcSubmitting, setQcSubmitting] = useState(false)
  const newLineSeq = useRef(0)
  const productsLoaded = useRef(false)

  function loadPurchaseProducts() {
    apiGet<PurchaseProduct[]>('/api/products?purchasable=1&slim=1').then(setPurchaseProducts).catch(() => {})
  }

  async function loadPickerData() {
    if (productsLoaded.current) return
    productsLoaded.current = true
    loadPurchaseProducts()
    apiGet<Category[]>('/api/product-categories').then(setCategories).catch(() => {})
    apiGet<Uom[]>('/api/uoms').then(setUoms).catch(() => {})
  }

  function addProductLine(prod: PurchaseProduct) {
    newLineSeq.current += 1
    const unitCost = Number(prod.standardPrice ?? prod.price ?? 0)
    setEditLines(prev => [
      ...prev,
      {
        id: `new-${newLineSeq.current}`,
        sequence: (prev[prev.length - 1]?.sequence ?? 0) + 10,
        productId: prod.id,
        productName: prod.name,
        spec: prod.spec ?? null,
        uomName: prod.uomName ?? null,
        orderedQty: 1,
        unitCost,
        taxRate: 0,
        bestBefore: null,
        subtotalExTax: unitCost,
        taxAmount: 0,
        subtotalIncTax: unitCost,
      },
    ])
  }

  function deleteProductLine(lineId: string) {
    setEditLines(prev => prev.filter(l => l.id !== lineId))
  }

  function openQuickCreate() {
    setQcName(productQuery)
    setQcCategoryId('')
    setQcUomId('')
    setQcUnitCost('')
    setShowQuickCreate(true)
  }

  async function submitQuickCreate() {
    if (!qcName.trim()) { toast.error(isEn ? 'Product name is required' : '商品名称不能为空'); return }
    setQcSubmitting(true)
    try {
      const created = await apiPost<PurchaseProduct>('/api/products/quick-create', {
        name: qcName.trim(),
        categoryId: qcCategoryId || undefined,
        purchaseUomId: qcUomId || undefined,
        unitCost: qcUnitCost ? Number(qcUnitCost) : undefined,
      })
      const uomRecord = uoms.find(u => u.id === qcUomId)
      const uomName = isEn ? (uomRecord?.name || uomRecord?.nameZh) : (uomRecord?.nameZh || uomRecord?.name)
      const withUom = { ...created, uomName: uomName ?? null, standardPrice: qcUnitCost ? Number(qcUnitCost) : 0 }
      setPurchaseProducts(prev => [withUom, ...prev])
      addProductLine(withUom)
      setProductQuery('')
      setShowQuickCreate(false)
      toast.success(isEn ? `Created "${created.name}" and added to purchase lines` : `已创建「${created.name}」并加入采购行`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to create product' : '创建商品失败'))
    } finally {
      setQcSubmitting(false)
    }
  }

  async function load() {
    setLoading(true)
    try {
      const data = await apiGet<PurchaseOrder>(`/api/purchase-orders/${id}`)
      setPo(data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])
  useEffect(() => {
    apiGet<{ items: Supplier[] }>('/api/customers?isVendor=true&limit=200')
      .then(d => setSuppliers(d.items ?? (d as unknown as Supplier[])))
      .catch(() => {})
  }, [])

  function startEdit() {
    if (!po) return
    loadPickerData()
    setEditNotes(po.notes ?? '')
    setEditExpectedDate(toInputDate(po.expectedDate))
    setEditSupplierId(po.supplierId)
    setEditLines(po.lines.map(l => ({ ...l })))
    setEditing(true)
  }

  function discardEdit() {
    setEditing(false)
    setEditLines([])
  }

  function updateLine(idx: number, field: 'orderedQty' | 'unitCost' | 'taxRate', value: number) {
    setEditLines(prev => {
      const next = [...prev]
      const l = { ...next[idx], [field]: value }
      const qty = field === 'orderedQty' ? value : Number(next[idx].orderedQty)
      const cost = field === 'unitCost' ? value : Number(next[idx].unitCost)
      const tax = field === 'taxRate' ? value : Number(next[idx].taxRate)
      l.subtotalExTax = qty * cost
      l.taxAmount = l.subtotalExTax * tax / 100
      l.subtotalIncTax = l.subtotalExTax + l.taxAmount
      next[idx] = l
      return next
    })
  }

  async function handleSave() {
    if (!po) return
    setSaving(true)
    try {
      const updated = await apiPut<PurchaseOrder>(`/api/purchase-orders/${id}`, {
        notes: editNotes || null,
        expectedDate: editExpectedDate || null,
        supplierId: editSupplierId,
        lines: editLines.map(l => ({
          id: l.id,
          ...(l.id.startsWith('new-') && { productId: l.productId, productName: l.productName }),
          orderedQty: Number(l.orderedQty),
          unitCost: Number(l.unitCost),
          taxRate: Number(l.taxRate),
          bestBefore: l.bestBefore || null,
        })),
      })
      setPo(updated)
      setEditing(false)
      setEditLines([])
      toast.success(isEn ? 'Saved successfully' : '保存成功')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  // 汇率待确认时补录：直接 PUT exchangeRate，后端会连带把行/表头的欧元折算字段一起重算(20260713)
  async function handleFixRate() {
    if (!po) return
    const rate = Number(fixRateInput)
    if (!Number.isFinite(rate) || rate <= 0) {
      toast.error(isEn ? 'Please enter a valid rate' : '请输入有效的汇率'); return
    }
    setFixingRate(true)
    try {
      const updated = await apiPut<PurchaseOrder>(`/api/purchase-orders/${id}`, { exchangeRate: rate })
      setPo(updated)
      setFixRateInput('')
      toast.success(isEn ? 'Exchange rate confirmed' : '汇率已确认')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to save' : '保存失败'))
    } finally {
      setFixingRate(false)
    }
  }

  const ACTION_LABELS: Record<string, { zh: string; en: string }> = {
    send: { zh: '发送', en: 'Send' },
    confirm: { zh: '确认采购', en: 'Confirm Purchase' },
    cancel: { zh: '取消', en: 'Cancel' },
    invoice: { zh: '创建账单', en: 'Create Bill' },
    lock: { zh: '锁定', en: 'Lock' },
    approve: { zh: '审批通过', en: 'Approve' },
    reset_to_draft: { zh: '重置为草稿', en: 'Reset to Draft' },
  }

  async function handleAction(action: string) {
    if (!po || acting) return
    const label = isEn ? (ACTION_LABELS[action]?.en ?? action) : (ACTION_LABELS[action]?.zh ?? action)
    setActing(true)
    try {
      await apiPatch<PurchaseOrder>(`/api/purchase-orders/${id}`, { action })
      await load()
      toast.success(isEn ? `${label} succeeded` : `${label}成功`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? `${label} failed` : `${label}失败`))
    } finally {
      setActing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-400">
        <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: PURPLE }} />
        {isEn ? 'Loading...' : '加载中...'}
      </div>
    )
  }

  if (!po) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-400 mb-4">{isEn ? 'Purchase order not found' : '采购单不存在'}</p>
        <button onClick={() => router.push(`${prefix}/classic/operator/purchases`)}
          className="px-4 py-2 border border-gray-300 rounded text-sm text-gray-600 hover:bg-gray-50">
          {isEn ? 'Back to list' : '返回列表'}
        </button>
      </div>
    )
  }

  const isEditable = po.status === 'DRAFT' || po.status === 'SENT'
  const isLocked = po.status === 'LOCKED'
  const isCancelled = po.status === 'CANCELLED'
  const displayLines = editing ? editLines : po.lines

  const subtotalExTax = displayLines.reduce((s, l) => s + Number(l.subtotalExTax), 0)
  const totalTax = displayLines.reduce((s, l) => s + Number(l.taxAmount), 0)
  const totalIncTax = displayLines.reduce((s, l) => s + Number(l.subtotalIncTax), 0)

  const supplier = suppliers.find(s => s.id === (editing ? editSupplierId : po.supplierId))
  const supplierName = supplier?.name ?? po.supplierName ?? po.supplierId

  const latestBill = [...(po.bills ?? [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]

  const timeline = [
    ...(po.activityLog ?? []).map(l => ({ id: l.id, text: l.detail || l.action, at: l.createdAt })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  const inputCls = 'border border-gray-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100'
  const numInputCls = 'border border-gray-300 rounded px-1.5 py-0.5 text-sm bg-white text-right focus:outline-none focus:border-blue-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

  return (
    <div className="flex flex-col h-full overflow-auto" style={{ background: '#f3f4f5' }}>

      {/* ── Top control bar ─────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 flex-shrink-0">

        {/* Row 1: breadcrumb */}
        <div className="px-6 pt-3 pb-1 text-xs text-gray-500">
          <button
            onClick={() => router.push(`${prefix}/classic/operator/purchases`)}
            className="hover:underline"
            style={{ color: PURPLE }}
          >
            {isEn ? 'Request for Quotation' : '询价单'}
          </button>
          <span className="mx-1 text-gray-400">/</span>
          <span className="text-gray-700 font-medium">{po.name}</span>
        </div>

        {/* Row 2: action buttons + pagination */}
        <div className="px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            {!editing ? (
              <>
                <button
                  onClick={startEdit}
                  disabled={!isEditable || isCancelled || isLocked}
                  className="h-7 px-3 text-sm rounded border disabled:opacity-40 font-medium"
                  style={{ borderColor: '#d0d5dd', color: DARK, background: 'white' }}
                  onMouseEnter={e => { if (isEditable && !isCancelled && !isLocked) (e.currentTarget as HTMLElement).style.background = '#f5f5f5' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'white' }}
                >
                  {isEn ? 'Edit' : '编辑'}
                </button>
                <button
                  onClick={() => { router.push(`${prefix}/classic/operator/purchases`) }}
                  className="h-7 px-3 text-sm rounded border font-medium hover:bg-gray-50"
                  style={{ borderColor: '#d0d5dd', color: DARK }}
                >
                  {isEn ? 'New' : '新建'}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="h-7 px-3 text-sm rounded border disabled:opacity-40 font-medium"
                  style={{ borderColor: PURPLE, color: PURPLE, background: 'white' }}
                >
                  {saving ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Save' : '手动保存')}
                </button>
                <button
                  onClick={discardEdit}
                  className="h-7 px-3 text-sm rounded border font-medium hover:bg-gray-50"
                  style={{ borderColor: '#d0d5dd', color: DARK }}
                >
                  {isEn ? 'Discard' : '放弃'}
                </button>
              </>
            )}
            <div className="w-px h-4 bg-gray-300 mx-1" />
            <button onClick={() => openPurchaseOrderPdf(po.id, isEn)}
              className="h-7 px-3 text-sm rounded border font-medium hover:bg-gray-50 flex items-center gap-1"
              style={{ borderColor: '#d0d5dd', color: DARK }}>
              {isEn ? 'Print' : '打印'}
            </button>
            <button className="h-7 px-3 text-sm rounded border font-medium hover:bg-gray-50 flex items-center gap-1"
              style={{ borderColor: '#d0d5dd', color: DARK }}>
              {isEn ? 'Actions' : '操作'} <span className="text-xs leading-none">▾</span>
            </button>
          </div>

          {/* Pagination stub */}
          <div className="flex items-center gap-1">
            <button className="w-6 h-6 rounded border border-gray-200 hover:bg-gray-50 flex items-center justify-center text-gray-500 text-xs">
              ‹
            </button>
            <button className="w-6 h-6 rounded border border-gray-200 hover:bg-gray-50 flex items-center justify-center text-gray-500 text-xs">
              ›
            </button>
          </div>
        </div>

        {/* Row 3: status action buttons */}
        {!editing && (
          <div className="px-6 py-2.5 border-t border-gray-100 flex items-center gap-2">
            {po.status === 'DRAFT' && (
              <>
                <button onClick={() => handleAction('send')} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  {isEn ? 'Send by Email' : '发送邮件'}
                </button>
                <button onClick={() => openPurchaseOrderPdf(po.id, isEn)}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
                  {isEn ? 'Print RFQ' : '打印询价单'}
                </button>
                <button onClick={() => handleAction('confirm')} disabled={acting || po.exchangeRatePending}
                  title={po.exchangeRatePending ? (isEn ? 'Exchange rate pending, please fill it in below first' : '汇率待确认，请先在下方补充汇率') : undefined}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                  {isEn ? 'Confirm Purchase' : '确认采购'}
                </button>
                <button onClick={() => { if (confirm(isEn ? 'Cancel this purchase order?' : '确定取消此采购单？')) handleAction('cancel') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {isEn ? 'Cancel' : '取消'}
                </button>
              </>
            )}
            {po.status === 'SENT' && (
              <>
                <button onClick={() => handleAction('confirm')} disabled={acting || po.exchangeRatePending}
                  title={po.exchangeRatePending ? (isEn ? 'Exchange rate pending, please fill it in below first' : '汇率待确认，请先在下方补充汇率') : undefined}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  {isEn ? 'Confirm Purchase' : '确认采购'}
                </button>
                <button onClick={() => { if (confirm(isEn ? 'Cancel this purchase order?' : '确定取消此采购单？')) handleAction('cancel') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {isEn ? 'Cancel' : '取消'}
                </button>
              </>
            )}
            {po.status === 'CONFIRMED' && (
              <>
                <button
                  onClick={() => router.push(`${prefix}/classic/operator/inventory?tab=receive&poId=${po.id}`)}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  {isEn ? 'Confirm Receipt' : '确认收货'}
                </button>
                <button onClick={() => { if (confirm(isEn ? 'Cancel this purchase order?' : '确定取消此采购单？')) handleAction('cancel') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {isEn ? 'Cancel' : '取消'}
                </button>
              </>
            )}
            {po.status === 'RECEIVED' && (
              <button onClick={() => handleAction('invoice')} disabled={acting}
                className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                style={{ background: PURPLE }}>
                {isEn ? 'Create Bill' : '创建账单'}
              </button>
            )}
            {po.status === 'INVOICED' && (
              <button onClick={() => handleAction('lock')} disabled={acting}
                className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                style={{ background: PURPLE }}>
                🔒 {isEn ? 'Lock' : '锁定'}
              </button>
            )}
            {po.status === 'TO_APPROVE' && (
              <>
                <button onClick={() => handleAction('approve')} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: '#16a34a' }}>
                  ✓ {isEn ? 'Approve' : '审批通过'}
                </button>
                <button onClick={() => { if (confirm(isEn ? 'Cancel this purchase order?' : '确定取消此采购单？')) handleAction('cancel') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {isEn ? 'Cancel' : '取消'}
                </button>
              </>
            )}
            {isLocked && (
              <span className="text-sm font-medium px-3 py-1 rounded flex items-center gap-1.5" style={{ background: '#f0fdf4', color: '#166534' }}>
                🔒 {isEn ? 'Locked — no changes allowed' : '已锁定 — 不可变更'}
              </span>
            )}
            {isCancelled && (
              <>
                <button onClick={() => handleAction('reset_to_draft')} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  {isEn ? 'Reset to Draft' : '重置为草稿'}
                </button>
                <span className="text-sm font-medium px-3 py-1 rounded" style={{ background: '#fef2f2', color: '#dc2626' }}>
                  {isEn ? 'This purchase order has been cancelled' : '此采购单已取消'}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Status progress bar ──────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-end flex-shrink-0">
        <OdooStatusBar status={po.status} isEn={isEn} />
      </div>

      {/* ── Main form card ───────────────────────────────── */}
      <div className="flex-1 p-6 overflow-auto">
        {latestBill && (
          <div
            className="mb-4 flex items-center gap-2 px-4 py-2.5 rounded text-sm"
            style={{ background: '#e5f1e9', color: '#2e7d4f' }}
          >
            {isEn
              ? <>✓ Vendor bill <b>{latestBill.name}</b> generated ({latestBill.totalIncTax.toFixed(2)}) · Finance role notified</>
              : <>✓ 已生成供应商账单 <b>{latestBill.name}</b>（{latestBill.totalIncTax.toFixed(2)}）· 已通知财务角色</>}
          </div>
        )}
        <div className="bg-white rounded border border-gray-200 shadow-sm">

          {/* Form header */}
          <div className="px-6 pt-5 pb-4">
            <div className="grid grid-cols-2 gap-10">

              {/* Left column */}
              <div className="space-y-3">
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Vendor' : '供应商'}</label>
                  {editing ? (
                    <select
                      value={editSupplierId}
                      onChange={e => setEditSupplierId(e.target.value)}
                      className={`flex-1 ${inputCls}`}
                    >
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  ) : (
                    <span className="text-sm font-medium" style={{ color: PURPLE }}>{supplierName}</span>
                  )}
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Vendor Reference' : '供应商参考'}</label>
                  {editing ? (
                    <input type="text" placeholder={isEn ? "Vendor's order reference" : '供应商的订单参考号'} className={`flex-1 ${inputCls}`} />
                  ) : (
                    <span className="text-sm text-gray-400">—</span>
                  )}
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Payment Terms' : '付款条款'}</label>
                  <span className="text-sm text-gray-700">{supplier?.supplierPaymentTerm || '—'}</span>
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Currency' : '货币'}</label>
                  <span className="text-sm text-gray-700">CNY</span>
                </div>
              </div>

              {/* Right column */}
              <div className="space-y-3">
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Order Date' : '订单日期'}</label>
                  <span className="text-sm text-gray-800">{formatDateOnly(po.orderDate ?? po.createdAt)}</span>
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Expected Arrival' : '预期到货日期'}</label>
                  {editing ? (
                    <input
                      type="date"
                      value={editExpectedDate}
                      onChange={e => setEditExpectedDate(e.target.value)}
                      className={inputCls}
                      style={{ width: '180px' }}
                    />
                  ) : (
                    <span className="text-sm text-gray-800">{formatDateOnly(po.expectedDate) || '—'}</span>
                  )}
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Purchase Rep' : '采购代表'}</label>
                  <span className="text-sm text-gray-400">—</span>
                </div>
              </div>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex border-t border-b border-gray-200 px-6 bg-gray-50">
            {(['products', 'other'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className="px-5 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px"
                style={{
                  borderBottomColor: activeTab === tab ? PURPLE : 'transparent',
                  color: activeTab === tab ? PURPLE : '#6b7280',
                  background: 'transparent',
                }}
              >
                {tab === 'products' ? (isEn ? 'Products' : '产品') : (isEn ? 'Other Info' : '其他信息')}
              </button>
            ))}
          </div>

          {/* ── Products tab ── */}
          {activeTab === 'products' && (
            <div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr style={{ background: '#f8f8f8', borderBottom: '1px solid #e8e8e8' }}>
                      {editing && <th className="w-8 px-2 py-2.5" />}
                      <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">{isEn ? 'Product' : '商品'}</th>
                      <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">{isEn ? 'Description' : '描述'}</th>
                      <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">{isEn ? 'Qty' : '数量'}</th>
                      <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">{isEn ? 'UoM' : '单位'}</th>
                      <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">{isEn ? 'Unit Price' : '单价'}</th>
                      <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">{isEn ? 'Tax %' : '税率%'}</th>
                      <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">Best Before</th>
                      <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">{isEn ? 'Subtotal' : '小计'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayLines.map((l, i) => (
                      <tr key={l.id} className="border-b border-gray-100 hover:bg-blue-50/30 transition-colors">
                        {editing && (
                          <td className="px-2 py-2.5 text-center">
                            <button onClick={() => deleteProductLine(l.id)} className="text-red-400 hover:text-red-600" title={isEn ? 'Delete this line' : '删除此行'}>
                              <Trash2 className="h-3.5 w-3.5 inline" />
                            </button>
                          </td>
                        )}
                        <td className="px-4 py-2.5 font-medium" style={{ color: PURPLE }}>{l.productName}</td>
                        <td className="px-4 py-2.5 text-gray-500 text-xs max-w-[180px] truncate">{l.spec || ''}</td>
                        <td className="px-4 py-2.5 text-right">
                          {editing ? (
                            <input type="number" step="0.001" min="0"
                              className={numInputCls} style={{ width: '80px' }}
                              value={Number(l.orderedQty)}
                              onChange={e => updateLine(i, 'orderedQty', Number(e.target.value))} />
                          ) : (
                            <span className="text-gray-800">{Number(l.orderedQty).toFixed(3)}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 text-xs">{l.uomName || '—'}</td>
                        <td className="px-4 py-2.5 text-right">
                          {editing ? (
                            <input type="number" step="0.01" min="0"
                              className={numInputCls} style={{ width: '90px' }}
                              value={Number(l.unitCost)}
                              onChange={e => updateLine(i, 'unitCost', Number(e.target.value))} />
                          ) : (
                            <span className="text-gray-800">{Number(l.unitCost).toFixed(2)}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {editing ? (
                            <input type="number" step="0.1" min="0"
                              className={numInputCls} style={{ width: '60px' }}
                              value={Number(l.taxRate ?? 0)}
                              onChange={e => updateLine(i, 'taxRate', Number(e.target.value))} />
                          ) : (
                            <span className="text-gray-600 text-xs">{Number(l.taxRate ?? 0).toFixed(1)}%</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {editing ? (
                            <input type="date"
                              className={`${numInputCls} text-xs`} style={{ width: '120px' }}
                              value={toInputDate(l.bestBefore)}
                              onChange={e => {
                                setEditLines(prev => {
                                  const next = [...prev]
                                  next[i] = { ...next[i], bestBefore: e.target.value || null }
                                  return next
                                })
                              }} />
                          ) : (
                            <span className="text-gray-600 text-xs">{formatDateOnly(l.bestBefore) || '—'}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium text-gray-800">
                          {Number(l.subtotalExTax).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                    {displayLines.length === 0 && (
                      <tr>
                        <td colSpan={editing ? 9 : 8} className="px-4 py-10 text-center text-gray-400 text-sm">{isEn ? 'No lines yet' : '暂无明细行'}</td>
                      </tr>
                    )}
                    {editing && (
                      <tr>
                        <td className="px-2 py-2" />
                        <td className="px-2 py-2" colSpan={7}>
                          <div className="flex items-center gap-2">
                            <ProductSearchInput
                              value={productQuery}
                              onChange={setProductQuery}
                              onSelect={p => { addProductLine(p); setProductQuery('') }}
                              products={purchaseProducts}
                              placeholder={isEn ? 'Search and add product…' : '搜索并添加商品…'}
                              inputClassName="border border-dashed border-gray-300 rounded px-3 py-1.5 text-sm text-gray-500 focus:outline-none focus:border-purple-400 bg-transparent w-64"
                              portalDropdown
                            />
                            <button
                              onClick={openQuickCreate}
                              className="text-xs whitespace-nowrap hover:underline"
                              style={{ color: PURPLE }}
                            >
                              {isEn ? "Can't find it? Create product" : '找不到？新建商品'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="border-t border-gray-200 px-6 py-5 flex justify-end">
                <div style={{ minWidth: '280px' }}>
                  <div className="flex justify-between py-1 text-sm">
                    <span className="text-gray-500">{isEn ? 'Untaxed Amount' : '税前金额'}</span>
                    <span className="text-gray-800 font-medium">{subtotalExTax.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1 text-sm">
                    <span className="text-gray-500">{isEn ? 'Tax' : '税额'}</span>
                    <span className="text-gray-800">{totalTax.toFixed(2)}</span>
                  </div>
                  <div className="border-t border-gray-300 mt-1 pt-2 flex justify-between">
                    <span className="text-sm font-semibold" style={{ color: DARK }}>{isEn ? 'Total' : '合计'}</span>
                    <span className="text-base font-bold" style={{ color: DARK }}>{po.currency} {totalIncTax.toFixed(2)}</span>
                  </div>
                  {po.currency !== 'EUR' && (
                    <div className="flex justify-between py-1 text-sm">
                      <span className="text-gray-400">{isEn ? `≈ EUR (rate ${po.exchangeRate ?? '—'})` : `≈ 折合欧元（汇率 ${po.exchangeRate ?? '—'}）`}</span>
                      <span className={po.exchangeRatePending ? 'text-red-500 font-medium' : 'text-gray-500'}>
                        {po.exchangeRatePending ? (isEn ? '🔴 pending' : '🔴 待确认') : `€${Number(po.totalIncTaxEur ?? 0).toFixed(2)}`}
                      </span>
                    </div>
                  )}
                  {po.exchangeRatePending && (po.status === 'DRAFT' || po.status === 'SENT') && (
                    <div className="mt-2 flex items-center gap-1.5 bg-red-50 border border-red-200 rounded px-2.5 py-2">
                      <span className="text-xs text-red-700 flex-shrink-0">{isEn ? `Rate ${po.currency}→EUR` : `汇率 ${po.currency}→EUR`}</span>
                      <input
                        type="number" step="0.000001" min="0"
                        value={fixRateInput}
                        onChange={e => setFixRateInput(e.target.value)}
                        placeholder={isEn ? 'e.g. 0.92' : '例如 0.92'}
                        className="border border-gray-300 rounded px-2 py-1 text-xs w-24 text-right"
                      />
                      <button
                        onClick={handleFixRate}
                        disabled={fixingRate}
                        className="h-6 px-2.5 text-xs font-medium rounded text-white disabled:opacity-50 flex-shrink-0"
                        style={{ background: PURPLE }}
                      >{fixingRate ? '…' : (isEn ? 'Confirm' : '确认')}</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Other Information tab ── */}
          {activeTab === 'other' && (
            <div className="p-6">
              <div className="grid grid-cols-2 gap-10">
                <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <label className="w-36 text-sm text-gray-500 flex-shrink-0 pt-1">{isEn ? 'Notes' : '备注'}</label>
                    {editing ? (
                      <textarea
                        value={editNotes}
                        onChange={e => setEditNotes(e.target.value)}
                        rows={3}
                        placeholder={isEn ? 'Internal notes...' : '内部备注...'}
                        className={`flex-1 ${inputCls} resize-none`}
                      />
                    ) : (
                      <span className="text-sm text-gray-700 whitespace-pre-line">{po.notes || '—'}</span>
                    )}
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Source Document' : '来源单据'}</label>
                    <span className="text-sm text-gray-400">—</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Created On' : '创建日期'}</label>
                    <span className="text-sm text-gray-700">{formatDateOnly(po.createdAt)}</span>
                  </div>
                </div>
              </div>

              {/* 收货记录：实际到货时间以此为准（可能分批多条），来自库存管理「收货」工作台 */}
              {(po.receipts?.length ?? 0) > 0 && (
                <div className="mt-6 pt-6 border-t border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">{isEn ? 'Goods Receipts' : '收货记录'}</h3>
                  <div className="space-y-3">
                    {[...(po.receipts ?? [])]
                      .sort((a, b) => new Date(b.arrivedAt).getTime() - new Date(a.arrivedAt).getTime())
                      .map(gr => {
                        const damaged = gr.lines.filter(l => l.condition === 'damaged')
                        const rejected = gr.lines.filter(l => l.condition === 'rejected')
                        // 质检信息在采购单上可见（台账 F4 验收第二条）：只列**填过**的行，
                        // 没做质检的收货一个字都不多印
                        const checked = gr.lines
                          .map(l => ({ line: l, qc: parseStoredQc(l.qc) }))
                          .filter(x => x.qc || x.line.condition === 'rejected')
                        return (
                          <div key={gr.id} className="border border-gray-200 rounded p-3 text-sm">
                            <div className="flex items-center justify-between">
                              <span className="font-medium text-gray-800">{gr.name}</span>
                              <span className="text-gray-500">{isEn ? 'Arrived' : '到货'} {formatDateOnly(gr.arrivedAt)}{gr.receivedBy ? ` · ${gr.receivedBy}` : ''}</span>
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                              {isEn ? `${gr.lines.length} item(s)` : `${gr.lines.length} 个品项`}
                              {damaged.length > 0 && (
                                <span className="text-red-600 ml-1">{isEn ? `· ${damaged.length} damaged` : `· ${damaged.length} 项有损坏`}</span>
                              )}
                              {rejected.length > 0 && (
                                <span className="text-red-700 ml-1 font-medium">{isEn ? `· ${rejected.length} rejected` : `· ${rejected.length} 项拒收`}</span>
                              )}
                            </div>
                            {checked.length > 0 && (
                              <div className="mt-2 rounded bg-gray-50 border border-gray-100 p-2 space-y-1">
                                <div className="text-xs font-medium text-gray-600">{isEn ? 'Quality check' : '质检记录'}</div>
                                {checked.map(({ line, qc }, i) => {
                                  const isRejected = line.condition === 'rejected'
                                  const verdict = lineVerdict(qc, isRejected ? Number(line.qty) : 0)
                                  return (
                                    <div key={`${line.productId}-${i}`} className="text-xs text-gray-600 flex items-start gap-1.5 flex-wrap">
                                      <span className="text-gray-800">{line.productName}</span>
                                      {verdict && (
                                        <span className={`px-1.5 py-0.5 rounded ${verdict === 'FAIL' ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'}`}>
                                          {verdict === 'FAIL' ? (isEn ? 'Failed' : '不合格') : (isEn ? 'Passed' : '合格')}
                                        </span>
                                      )}
                                      {isRejected && (
                                        <span className="text-red-700">
                                          {isEn ? `Rejected ${Number(line.qty)}` : `拒收 ${Number(line.qty)}`}
                                          {line.rejectReason ? `（${isEn ? QC_REJECT_REASON_LABELS[line.rejectReason].en : QC_REJECT_REASON_LABELS[line.rejectReason].zh}）` : ''}
                                        </span>
                                      )}
                                      <span className="text-gray-500">{formatQcSummary(qc, isEn ? 'en' : 'zh')}</span>
                                    </div>
                                  )
                                })}
                                {rejected.length > 0 && (
                                  <div className="text-xs text-red-700">
                                    {isEn
                                      ? 'Rejected quantities are not counted as received — this PO stays open until the supplier replaces or credits them.'
                                      : '拒收数量不计入已收 —— 本采购单会保持未收齐，直到供应商补货或退款。'}
                                  </div>
                                )}
                              </div>
                            )}
                            {gr.notes && <div className="text-xs text-gray-500 mt-1">{gr.notes}</div>}
                            {(gr.photos?.length ?? 0) > 0 && (
                              <div className="flex gap-1.5 mt-2 flex-wrap">
                                {(gr.photos ?? []).map((src, i) => (
                                  <img key={i} src={src} alt={isEn ? `${gr.name} photo ${i + 1}` : `${gr.name} 照片 ${i + 1}`} className="w-12 h-12 rounded object-cover border border-gray-200" />
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Chatter / message area ────────────────────── */}
        <div className="mt-4 bg-white rounded border border-gray-200 shadow-sm p-5">
          <div className="flex items-center gap-3 mb-4">
            <button className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 flex items-center gap-1.5">
              <span>✉</span> {isEn ? 'Send Message' : '发送消息'}
            </button>
            <button className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 flex items-center gap-1.5">
              <span>📝</span> {isEn ? 'Log Note' : '记录备注'}
            </button>
            <button className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 flex items-center gap-1.5">
              <span>📅</span> {isEn ? 'Schedule Activity' : '安排活动'}
            </button>
          </div>
          {timeline.length === 0 ? (
            <div className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-200 rounded">
              {isEn ? 'No activity records yet' : '暂无操作记录'}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {timeline.map(t => (
                <div key={t.id} className="flex items-start gap-3 text-sm">
                  <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: PURPLE }} />
                  <span className="text-gray-400 font-mono text-xs w-32 flex-shrink-0 pt-px">
                    {new Date(t.at).toLocaleString(isEn ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="text-gray-700">{t.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showQuickCreate && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-800">{isEn ? 'New Product' : '新建商品'}</h2>
            <p className="text-xs text-gray-400">{isEn ? "Create minimal info for this purchase; not saleable by default. You can later fill in sale price/tax rate/image in the product catalog before listing it." : '先建最小信息用于本次采购；默认不可销售，之后可在商品库补全销售价/税率/图片再上架。'}</p>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Product Name' : '商品名称'}</label>
              <input
                value={qcName}
                onChange={e => setQcName(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                autoFocus
              />
              <SimilarProductAlert name={qcName} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Category' : '分类'}</label>
                <select
                  value={qcCategoryId}
                  onChange={e => setQcCategoryId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                >
                  <option value="">{isEn ? 'Uncategorized' : '未分类'}</option>
                  {categories.map(c => (
                    <option key={c.id} value={c.id}>{isEn ? (c.name || c.nameZh) : (c.nameZh || c.name)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Purchase UoM' : '采购单位'}</label>
                <select
                  value={qcUomId}
                  onChange={e => setQcUomId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                >
                  <option value="">{isEn ? 'Unspecified' : '未指定'}</option>
                  {uoms.map(u => (
                    <option key={u.id} value={u.id}>{isEn ? (u.name || u.nameZh) : (u.nameZh || u.name)}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Reference Purchase Price (optional)' : '参考采购单价（可选）'}</label>
              <input
                type="number" step="0.01" min="0"
                value={qcUnitCost}
                onChange={e => setQcUnitCost(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setShowQuickCreate(false)}
                className="flex-1 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
              >
                {isEn ? 'Cancel' : '取消'}
              </button>
              <button
                onClick={submitQuickCreate}
                disabled={qcSubmitting}
                className="flex-1 py-2 rounded text-sm text-white disabled:opacity-50"
                style={{ background: PURPLE }}
              >
                {qcSubmitting ? (isEn ? 'Creating…' : '创建中…') : (isEn ? 'Create and add to lines' : '创建并加入采购行')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
