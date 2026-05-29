'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import { NumericInput } from '@/components/ui/numeric-input'
import ChatterFeed from '@/components/shared/chatter-feed'
import type { ProductTemplate, ProductCategory, Order } from '@/lib/types'

// ── SVG Smart Button Icons ─────────────────────────────────────────────────────
function IconSales() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2 9m12-9l2 9M9 22a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2z"/>
    </svg>
  )
}
function IconPurchase() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z"/><path d="M16 3H8l-4 4h16l-4-4z"/>
    </svg>
  )
}
function IconInventory() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
      <polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>
    </svg>
  )
}
function IconMoves() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/>
    </svg>
  )
}

// ── SmartButton ────────────────────────────────────────────────────────────────
function SmartButton({ icon, value, label, onClick }: { icon: React.ReactNode; value: string | number; label: string; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-0.5 px-4 py-2 rounded border transition-colors text-center min-w-[90px] hover:bg-[#875A7B]/20"
      style={{ borderColor: '#d4b8d0' }}
    >
      <div className="flex items-center gap-1 text-xs font-semibold" style={{ color: '#875A7B' }}>
        {icon}
        <span>{value}</span>
      </div>
      <span className="text-xs text-gray-500 whitespace-nowrap">{label}</span>
    </button>
  )
}

// ── ReadField ─────────────────────────────────────────────────────────────────
function ReadField({ label, value, wide }: { label: string; value?: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`flex items-start gap-3 ${wide ? 'col-span-2' : ''}`}>
      <span className="text-sm text-gray-500 w-44 flex-shrink-0 pt-0.5">{label}</span>
      <span className="text-sm text-gray-800 flex-1">{value ?? <span className="text-gray-300">—</span>}</span>
    </div>
  )
}

// ── Section ───────────────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h4 className="text-sm font-semibold mb-3 pb-1 border-b border-gray-100" style={{ color: '#875A7B' }}>{title}</h4>
      {children}
    </div>
  )
}

// ── Types ─────────────────────────────────────────────────────────────────────
const TAX_OPTIONS = [
  { value: '0', label: '0%' },
  { value: '0.135', label: '13.5%' },
  { value: '0.23', label: '23%' },
]
const TAX_LABEL: Record<string, string> = { '0': '0%', '0.135': '13.5%', '0.23': '23%' }
const TYPE_OPTIONS = [
  { value: 'product', label: 'Storable Product' },
  { value: 'consu', label: 'Consumable' },
  { value: 'service', label: 'Service' },
]
const TYPE_LABEL: Record<string, string> = { product: 'Storable Product', consu: 'Consumable', service: 'Service' }

interface VendorLine {
  id: string
  supplier: string
  productVariant: string
  minQty: number
  uom: string
  price: number
  currency: string
  dateStart: string
  dateEnd: string
}

type FormTab = 'general' | 'sales' | 'ecommerce' | 'purchase' | 'inventory'

export default function ClassicProductDetailPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const params = useParams()
  const id = params.id as string
  const isNew = id === 'new'

  const [tmpl, setTmpl] = useState<ProductTemplate | null>(isNew ? {
    id: 'new',
    name: '',
    internalRef: '',
    listPrice: 0,
    standardPrice: 0,
    customerTaxRate: 0.23,
    type: 'consu',
    canBeSold: true,
    canBePurchased: true,
    isPackaging: false,
    canBeExpensed: false,
    images: [],
    attributeLines: [],
    status: 'active',
    createdAt: new Date().toISOString(),
    websitePublished: false,
    sequence: 0,
    commissionPrice: 0,
    weight: 0,
  } : null)
  const [original, setOriginal] = useState<ProductTemplate | null>(null)
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [uoms, setUoms] = useState<{ id: string; name: string; nameZh?: string | null; category?: { name: string } }[]>([])
  const [activeTab, setActiveTab] = useState<FormTab>('general')
  const [editMode, setEditMode] = useState(isNew)
  const [saving, setSaving] = useState(false)

  // Smart button stats
  const [soldCount, setSoldCount] = useState(0)
  const [soldAmount, setSoldAmount] = useState(0)
  const [onHandQty, setOnHandQty] = useState(0)

  // Extra local state (not in ProductTemplate)
  const [vendorLines, setVendorLines] = useState<VendorLine[]>([])
  const [availableInPos, setAvailableInPos] = useState(false)
  const [loyaltyPoint, setLoyaltyPoint] = useState('')
  const [nonRefundable, setNonRefundable] = useState(false)
  const [returnValidDays, setReturnValidDays] = useState('')
  const [invoicingPolicy, setInvoicingPolicy] = useState<'order' | 'delivery'>('order')
  const [purchaseDescription, setPurchaseDescription] = useState('')

  // Print / Action dropdown
  const [printOpen, setPrintOpen] = useState(false)
  const [actionOpen, setActionOpen] = useState(false)
  const printRef = useRef<HTMLDivElement>(null)
  const actionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function outside(e: MouseEvent) {
      if (printRef.current && !printRef.current.contains(e.target as Node)) setPrintOpen(false)
      if (actionRef.current && !actionRef.current.contains(e.target as Node)) setActionOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [])

  async function load() {
    try {
      const [found, cats, orders, uomList] = await Promise.all([
        isNew ? Promise.resolve(null) : apiGet<ProductTemplate>(`/api/product-templates/${id}`),
        apiGet<ProductCategory[]>('/api/product-categories'),
        apiGet<Order[]>('/api/orders?include_lines=false'),
        apiGet<{ id: string; name: string; nameZh?: string | null; category?: { name: string } }[]>('/api/uoms').catch(() => [] as { id: string; name: string; nameZh?: string | null; category?: { name: string } }[]),
      ])
      const HIDDEN_CATEGORIES = ['Length', 'Time']
      setUoms(uomList.filter(u => !HIDDEN_CATEGORIES.includes(u.category?.name ?? '')))
      if (!isNew) {
        if (!found) { router.push(`${prefix}/classic/operator/products`); return }
        const normalized = { ...found, status: found.status?.toLowerCase() as ProductTemplate['status'] ?? found.status }
        setTmpl(normalized)
        setOriginal({ ...normalized })
        const templateId = found.id
        let count = 0
        let amount = 0
        for (const order of orders) {
          const matching = (order.items ?? []).filter(item => item.productId === templateId)
          if (matching.length > 0) {
            count++
            amount += matching.reduce((s, item) => s + (item.subtotal ?? item.price * item.quantity), 0)
          }
        }
        setSoldCount(count)
        setSoldAmount(amount)
        try {
          const allProducts = await apiGet<Array<{ templateId: string; qtyOnHand: number }>>('/api/products')
          const qty = allProducts.filter(p => p.templateId === templateId).reduce((s, p) => s + (p.qtyOnHand ?? 0), 0)
          setOnHandQty(qty)
        } catch { /* ignore */ }
      }
      setCategories(cats)
    } catch {
      if (!isNew) router.push(`${prefix}/classic/operator/products`)
    }
  }

  useEffect(() => { load() }, [id])

  function setField<K extends keyof ProductTemplate>(key: K, value: ProductTemplate[K]) {
    setTmpl(prev => prev ? { ...prev, [key]: value } : null)
  }

  async function handleSave() {
    if (!tmpl || saving) return
    if (!tmpl.name.trim()) { toast.error('商品名称不能为空'); return }
    setSaving(true)
    try {
      if (isNew) {
        const { id: _id, ...fields } = tmpl
        const created = await (await import('@/lib/api')).apiPost<ProductTemplate>('/api/product-templates', {
          ...fields,
          createdAt: new Date().toISOString(),
        })
        toast.success(`已创建「${created.name}」`)
        router.push(`${prefix}/classic/operator/products/${created.id}`)
      } else {
        const updated = { ...tmpl, updatedAt: new Date().toISOString() }
        await apiPut(`/api/product-templates/${tmpl.id}`, updated)
        setOriginal({ ...updated })
        setTmpl({ ...updated })
        setEditMode(false)
        toast.success(`已保存「${updated.name}」`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  function handleDiscard() {
    if (isNew) { router.push(`${prefix}/classic/operator/products`); return }
    if (original) { setTmpl({ ...original }) }
    setEditMode(false)
  }

  if (!tmpl) return <div className="p-8 text-gray-400 text-sm">加载中...</div>

  const tabs: { key: FormTab; label: string }[] = [
    { key: 'general', label: 'General Information' },
    { key: 'sales', label: 'Sales' },
    { key: 'ecommerce', label: 'eCommerce' },
    { key: 'purchase', label: 'Purchase' },
    { key: 'inventory', label: 'Inventory' },
  ]

  const fieldClass = "w-full h-8 px-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 bg-white"
  const focusStyle = { '--tw-ring-color': '#875A7B' } as React.CSSProperties
  const btnBase = "h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
  const catName = categories.find(c => c.id === tmpl.categoryId)?.nameZh ?? categories.find(c => c.id === tmpl.categoryId)?.name

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── 顶部控制栏 ───────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-4">
        {/* 面包屑 */}
        <div className="py-2 text-sm flex items-center gap-1 text-gray-500">
          <button onClick={() => router.push(`${prefix}/classic/operator/products`)} className="hover:underline" style={{ color: '#875A7B' }}>
            Product Variants
          </button>
          <span className="text-gray-300 mx-1">›</span>
          <span className="text-gray-800 font-medium">{isNew ? 'New' : (tmpl.name || '（未命名）')}</span>
        </div>

        {/* 操作按钮行 */}
        <div className="pb-2 flex items-center gap-2 flex-wrap">
          {editMode ? (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="h-8 px-4 text-sm font-medium text-white rounded transition-colors"
                style={{ background: '#875A7B' }}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button onClick={handleDiscard} disabled={saving} className={btnBase}>
                Discard
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setEditMode(true)}
                className="h-8 px-4 text-sm font-medium text-white rounded"
                style={{ background: '#875A7B' }}
              >
                Edit
              </button>
              <button
                onClick={() => router.push(`${prefix}/classic/operator/products/new`)}
                className={btnBase}
              >
                Create
              </button>

              {/* Print ▼ */}
              <div className="relative" ref={printRef}>
                <button onClick={() => { setPrintOpen(v => !v); setActionOpen(false) }} className={`${btnBase} flex items-center gap-1`}>
                  Print
                  <svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                </button>
                {printOpen && (
                  <div className="absolute left-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded shadow-lg z-30 text-sm py-1">
                    {['Product Label', 'Product Sheet'].map(item => (
                      <button key={item} onClick={() => { toast.info('打印功能即将推出'); setPrintOpen(false) }}
                        className="w-full text-left px-4 py-2 hover:bg-gray-50 text-gray-700">{item}</button>
                    ))}
                  </div>
                )}
              </div>

              {/* Action ▼ */}
              <div className="relative" ref={actionRef}>
                <button onClick={() => { setActionOpen(v => !v); setPrintOpen(false) }} className={`${btnBase} flex items-center gap-1`}>
                  Action
                  <svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                </button>
                {actionOpen && (
                  <div className="absolute left-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded shadow-lg z-30 text-sm py-1">
                    {['Duplicate', 'Archive', 'Delete'].map(item => (
                      <button key={item} onClick={() => { toast.info('功能即将推出'); setActionOpen(false) }}
                        className="w-full text-left px-4 py-2 hover:bg-gray-50 text-gray-700">{item}</button>
                    ))}
                  </div>
                )}
              </div>

              {/* 1 / — < > */}
              <div className="flex items-center gap-1 ml-auto text-sm text-gray-500">
                <span>1 / —</span>
                <button className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-30" disabled>‹</button>
                <button className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-30" disabled>›</button>
              </div>
            </>
          )}
        </div>

        {/* 次级操作：Update Qty / Replenish (只在读模式 + 非新建时) */}
        {!editMode && !isNew && (
          <div className="pb-2 flex items-center gap-2 border-t border-gray-100 pt-2">
            <button onClick={() => toast.info('即将推出')} className={btnBase}>
              Update Qty On Hand
            </button>
            <button onClick={() => toast.info('即将推出')} className={btnBase}>
              Replenish
            </button>
          </div>
        )}
      </div>

      {/* ── 主内容卡片 ───────────────────────────────────────────────────────── */}
      <div className="m-4 bg-white border border-gray-200 rounded">

        {/* 商品头部 */}
        <div className="p-5 border-b border-gray-100">
          <div className="flex items-start gap-4">
            <div className="flex gap-4 flex-1">
              {/* 图片 */}
              <div
                className="w-24 h-24 rounded-full border-2 border-dashed border-gray-300 flex items-center justify-center flex-shrink-0 overflow-hidden bg-gray-50"
                style={{ cursor: editMode ? 'pointer' : 'default' }}
                title={editMode ? '点击上传图片' : undefined}
              >
                {tmpl.images?.[0] ? (
                  <img src={tmpl.images[0]} alt="" className="w-full h-full object-cover" />
                ) : (
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="text-gray-300">
                    <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                    <circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M21 15l-5-5L5 21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                )}
              </div>

              <div className="flex-1">
                {editMode ? (
                  <input
                    value={tmpl.name}
                    onChange={e => setField('name', e.target.value)}
                    placeholder="Product Name"
                    className="w-full text-xl font-semibold text-gray-900 placeholder-gray-300 border-0 outline-none bg-transparent mb-2 p-0"
                  />
                ) : (
                  <h1 className="text-xl font-semibold text-gray-900 mb-2">{tmpl.name || '（未命名）'}</h1>
                )}
                <div className="flex flex-wrap gap-4">
                  {[
                    { key: 'isPackaging' as const, label: 'Is Packaging' },
                    { key: 'canBeSold' as const, label: 'Can be Sold' },
                    { key: 'canBePurchased' as const, label: 'Can be Purchased' },
                    { key: 'canBeExpensed' as const, label: 'Can be Expensed' },
                  ].map(({ key, label }) => (
                    <label key={key} className={`flex items-center gap-1.5 text-sm text-gray-700 select-none ${editMode ? 'cursor-pointer' : ''}`}>
                      <input
                        type="checkbox"
                        checked={(tmpl[key] as boolean) ?? false}
                        onChange={e => editMode && setField(key, e.target.checked)}
                        readOnly={!editMode}
                        className="rounded w-3.5 h-3.5"
                        style={{ accentColor: '#875A7B' }}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {/* Smart Buttons */}
            {!isNew && (
              <div className="flex flex-wrap gap-2 justify-end flex-shrink-0 max-w-sm">
                <SmartButton icon={<IconSales />} value={soldCount} label="Sales" />
                <SmartButton icon={<IconPurchase />} value={`€${soldAmount.toFixed(2)}`} label="Purchased" />
                <SmartButton icon={<IconInventory />} value={onHandQty.toFixed(2)} label="On Hand" />
                <SmartButton icon={<IconMoves />} value={0} label="Product Moves" />
              </div>
            )}
          </div>
        </div>

        {/* Tab 栏 */}
        <div className="flex gap-0 border-b border-gray-200 px-4 overflow-x-auto">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className="px-4 py-3 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap"
              style={{
                borderBottomColor: activeTab === t.key ? '#875A7B' : 'transparent',
                color: activeTab === t.key ? '#875A7B' : '#6b7280',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab 内容 */}
        <div className="px-6 py-5">

          {/* ── General Information ── */}
          {activeTab === 'general' && (
            editMode ? (
              <div className="grid grid-cols-2 gap-x-12 gap-y-3 max-w-3xl">
                <div className="space-y-3">
                  <Row label="Product Type">
                    <select value={tmpl.type} onChange={e => setField('type', e.target.value as ProductTemplate['type'])} className={fieldClass} style={focusStyle}>
                      {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </Row>
                  <Row label="Internal Reference">
                    <input value={tmpl.internalRef ?? ''} onChange={e => setField('internalRef', e.target.value || undefined)} className={fieldClass} style={{ ...focusStyle, color: '#875A7B' }} />
                  </Row>
                  <Row label="Barcode">
                    <input value={tmpl.barcode ?? ''} onChange={e => setField('barcode', e.target.value || undefined)} className={fieldClass} style={focusStyle} />
                  </Row>
                  <Row label="Product Category">
                    <select value={tmpl.categoryId ?? ''} onChange={e => setField('categoryId', e.target.value || undefined)} className={fieldClass} style={focusStyle}>
                      <option value="">— All —</option>
                      {categories.map(c => <option key={c.id} value={c.id}>{c.nameZh ?? c.name}</option>)}
                    </select>
                  </Row>
                </div>
                <div className="space-y-3">
                  <Row label="Sequence">
                    <NumericInput value={tmpl.sequence ?? 0} onChange={e => setField('sequence', parseInt(e.target.value) || 0)} className={fieldClass} style={focusStyle} />
                  </Row>
                  <Row label="Sales Price">
                    <PriceInput value={tmpl.listPrice} onChange={v => setField('listPrice', v)} />
                  </Row>
                  <Row label="Customer Taxes">
                    <select value={String(tmpl.customerTaxRate)} onChange={e => setField('customerTaxRate', parseFloat(e.target.value))} className={fieldClass} style={focusStyle}>
                      {TAX_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </Row>
                  <Row label="Cost">
                    <PriceInput value={tmpl.standardPrice} onChange={v => setField('standardPrice', v)} />
                  </Row>
                  <Row label="Unit of Measure">
                    <select value={tmpl.unitOfMeasure ?? ''} onChange={e => setField('unitOfMeasure', e.target.value || undefined)} className={fieldClass} style={focusStyle}>
                      <option value="">— 请选择 —</option>
                      {uoms.map(u => <option key={u.id} value={u.name}>{u.nameZh ?? u.name}</option>)}
                    </select>
                  </Row>
                  <Row label="Commission Price">
                    <PriceInput value={tmpl.commissionPrice ?? 0} onChange={v => setField('commissionPrice', v || undefined)} />
                  </Row>
                  <Row label="Purchase UoM">
                    <select value={tmpl.purchaseUoM ?? ''} onChange={e => setField('purchaseUoM', e.target.value || undefined)} className={fieldClass} style={focusStyle}>
                      <option value="">— 请选择 —</option>
                      {uoms.map(u => <option key={u.id} value={u.name}>{u.nameZh ?? u.name}</option>)}
                    </select>
                  </Row>
                </div>
                <div className="col-span-2 mt-2">
                  <h4 className="text-sm font-semibold mb-2" style={{ color: '#875A7B' }}>Internal Notes</h4>
                  <textarea
                    value={tmpl.description ?? ''}
                    onChange={e => setField('description', e.target.value || undefined)}
                    placeholder="This note is only for internal purposes."
                    rows={3}
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 bg-white"
                    style={focusStyle}
                  />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-12 gap-y-2 max-w-3xl">
                <ReadField label="Product Type" value={TYPE_LABEL[tmpl.type] ?? tmpl.type} />
                <ReadField label="Sequence" value={tmpl.sequence ?? 0} />
                <ReadField label="Internal Reference" value={tmpl.internalRef ? <span style={{ color: '#875A7B' }}>{tmpl.internalRef}</span> : undefined} />
                <ReadField label="Sales Price" value={`€${tmpl.listPrice.toFixed(2)}`} />
                <ReadField label="Barcode" value={tmpl.barcode} />
                <ReadField label="Customer Taxes" value={TAX_LABEL[String(tmpl.customerTaxRate)] ?? `${(tmpl.customerTaxRate * 100).toFixed(0)}%`} />
                <ReadField label="Product Category" value={catName} />
                <ReadField label="Cost" value={`€${tmpl.standardPrice.toFixed(2)}`} />
                <ReadField label="Unit of Measure" value={
                  tmpl.unitOfMeasure
                    ? (uoms.find(u => u.name === tmpl.unitOfMeasure)?.nameZh ?? tmpl.unitOfMeasure)
                    : 'Unit(s)'
                } />
                <ReadField label="Commission Price" value={tmpl.commissionPrice != null ? `€${tmpl.commissionPrice.toFixed(2)}` : undefined} />
                <ReadField label="Purchase UoM" value={
                  tmpl.purchaseUoM
                    ? (uoms.find(u => u.name === tmpl.purchaseUoM)?.nameZh ?? tmpl.purchaseUoM)
                    : 'Unit(s)'
                } />
                {tmpl.description && (
                  <div className="col-span-2 mt-4">
                    <h4 className="text-sm font-semibold mb-2" style={{ color: '#875A7B' }}>Internal Notes</h4>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{tmpl.description}</p>
                  </div>
                )}
              </div>
            )
          )}

          {/* ── Sales ── */}
          {activeTab === 'sales' && (
            <div className="max-w-2xl space-y-0">
              <Section title="Point Of Sale">
                {editMode ? (
                  <div className="space-y-3">
                    <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <input type="checkbox" checked={availableInPos} onChange={e => setAvailableInPos(e.target.checked)} className="rounded w-3.5 h-3.5" style={{ accentColor: '#875A7B' }} />
                      Available in POS
                    </label>
                    <Row label="Loyalty Point">
                      <input value={loyaltyPoint} onChange={e => setLoyaltyPoint(e.target.value)} placeholder="0.00" className={fieldClass} style={focusStyle} />
                    </Row>
                    <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <input type="checkbox" checked={nonRefundable} onChange={e => setNonRefundable(e.target.checked)} className="rounded w-3.5 h-3.5" style={{ accentColor: '#875A7B' }} />
                      Non-Refundable
                    </label>
                    <Row label="Return Valid Days">
                      <input value={returnValidDays} onChange={e => setReturnValidDays(e.target.value)} placeholder="0" className={fieldClass} style={focusStyle} />
                    </Row>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <ReadField label="Available in POS" value={availableInPos ? 'Yes' : 'No'} />
                    <ReadField label="Loyalty Point" value={loyaltyPoint || '0.00'} />
                    <ReadField label="Non-Refundable" value={nonRefundable ? 'Yes' : 'No'} />
                    <ReadField label="Return Valid Days" value={returnValidDays || '0'} />
                  </div>
                )}
              </Section>

              <Section title="Invoicing">
                {editMode ? (
                  <div className="space-y-2">
                    {[
                      { value: 'order', label: 'Ordered quantities' },
                      { value: 'delivery', label: 'Delivered quantities' },
                    ].map(opt => (
                      <label key={opt.value} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                        <input
                          type="radio"
                          name="invoicingPolicy"
                          value={opt.value}
                          checked={invoicingPolicy === opt.value}
                          onChange={() => setInvoicingPolicy(opt.value as 'order' | 'delivery')}
                          style={{ accentColor: '#875A7B' }}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                ) : (
                  <ReadField label="Invoicing Policy" value={invoicingPolicy === 'order' ? 'Ordered quantities' : 'Delivered quantities'} />
                )}
              </Section>

              <Section title="Description for Customers">
                {editMode ? (
                  <textarea
                    value={tmpl.saleDescription ?? ''}
                    onChange={e => setField('saleDescription', e.target.value || undefined)}
                    placeholder="This note will be printed on sales orders and invoices."
                    rows={4}
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1"
                    style={focusStyle}
                  />
                ) : (
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">
                    {tmpl.saleDescription || <span className="text-gray-300">—</span>}
                  </p>
                )}
              </Section>
            </div>
          )}

          {/* ── eCommerce ── */}
          {activeTab === 'ecommerce' && (
            <div className="max-w-xl space-y-3">
              {editMode ? (
                <>
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input type="checkbox" checked={tmpl.websitePublished ?? false} onChange={e => setField('websitePublished', e.target.checked)} className="rounded w-3.5 h-3.5" style={{ accentColor: '#875A7B' }} />
                    Published on website
                  </label>
                  <Row label="Website Name">
                    <input value={tmpl.websiteName ?? ''} onChange={e => setField('websiteName', e.target.value || undefined)} className={fieldClass} style={focusStyle} />
                  </Row>
                </>
              ) : (
                <>
                  <ReadField label="Published on website" value={tmpl.websitePublished ? 'Yes' : 'No'} />
                  <ReadField label="Website Name" value={tmpl.websiteName} />
                </>
              )}
            </div>
          )}

          {/* ── Purchase ── */}
          {activeTab === 'purchase' && (
            <div className="max-w-4xl space-y-0">
              <Section title="Vendors">
                <div className="border border-gray-200 rounded overflow-hidden mb-2">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        {['Vendor', 'Product Variant', 'Min Qty', 'UoM', 'Price', 'Currency', 'Start Date', 'End Date', ''].map(h => (
                          <th key={h} className="px-3 py-2 text-left font-medium text-gray-600 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {vendorLines.length === 0 && (
                        <tr><td colSpan={9} className="px-3 py-4 text-center text-gray-400">暂无供应商行</td></tr>
                      )}
                      {vendorLines.map((line, i) => (
                        <tr key={line.id} className="border-b border-gray-100">
                          <td className="px-2 py-1">
                            {editMode
                              ? <input value={line.supplier} onChange={e => updateVendorLine(i, 'supplier', e.target.value)} className="w-28 h-6 px-1 text-xs border border-gray-300 rounded" />
                              : <span>{line.supplier}</span>}
                          </td>
                          <td className="px-2 py-1">
                            {editMode
                              ? <input value={line.productVariant} onChange={e => updateVendorLine(i, 'productVariant', e.target.value)} className="w-24 h-6 px-1 text-xs border border-gray-300 rounded" />
                              : <span>{line.productVariant}</span>}
                          </td>
                          <td className="px-2 py-1">
                            {editMode
                              ? <input type="number" value={line.minQty} onChange={e => updateVendorLine(i, 'minQty', parseFloat(e.target.value) || 0)} className="w-16 h-6 px-1 text-xs border border-gray-300 rounded" />
                              : <span>{line.minQty}</span>}
                          </td>
                          <td className="px-2 py-1">
                            {editMode
                              ? <input value={line.uom} onChange={e => updateVendorLine(i, 'uom', e.target.value)} className="w-16 h-6 px-1 text-xs border border-gray-300 rounded" />
                              : <span>{line.uom}</span>}
                          </td>
                          <td className="px-2 py-1">
                            {editMode
                              ? <input type="number" value={line.price} step="0.01" onChange={e => updateVendorLine(i, 'price', parseFloat(e.target.value) || 0)} className="w-20 h-6 px-1 text-xs border border-gray-300 rounded" />
                              : <span>{line.price.toFixed(2)}</span>}
                          </td>
                          <td className="px-2 py-1">
                            {editMode
                              ? <input value={line.currency} onChange={e => updateVendorLine(i, 'currency', e.target.value)} className="w-16 h-6 px-1 text-xs border border-gray-300 rounded" />
                              : <span>{line.currency}</span>}
                          </td>
                          <td className="px-2 py-1">
                            {editMode
                              ? <input type="date" value={line.dateStart} onChange={e => updateVendorLine(i, 'dateStart', e.target.value)} className="w-28 h-6 px-1 text-xs border border-gray-300 rounded" />
                              : <span>{line.dateStart}</span>}
                          </td>
                          <td className="px-2 py-1">
                            {editMode
                              ? <input type="date" value={line.dateEnd} onChange={e => updateVendorLine(i, 'dateEnd', e.target.value)} className="w-28 h-6 px-1 text-xs border border-gray-300 rounded" />
                              : <span>{line.dateEnd}</span>}
                          </td>
                          {editMode && (
                            <td className="px-2 py-1">
                              <button onClick={() => removeVendorLine(i)} className="text-gray-400 hover:text-red-500 transition-colors">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {editMode && (
                  <button onClick={addVendorLine} className="text-sm flex items-center gap-1 hover:underline" style={{ color: '#875A7B' }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                    Add a line
                  </button>
                )}
              </Section>

              <Section title="Vendor Bills">
                {editMode ? (
                  <div className="space-y-3">
                    <Row label="Vendor Taxes">
                      <select value={String(tmpl.vendorTaxRate ?? '')} onChange={e => setField('vendorTaxRate', e.target.value ? parseFloat(e.target.value) : undefined)} className={fieldClass} style={focusStyle}>
                        <option value="">— None —</option>
                        {TAX_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </Row>
                    <div>
                      <span className="text-sm text-gray-700 block mb-1">Control Policy</span>
                      {[
                        { value: 'order', label: 'On ordered quantities' },
                        { value: 'receipt', label: 'On received quantities (Bill control)' },
                      ].map(opt => (
                        <label key={opt.value} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer mb-1">
                          <input type="radio" name="controlPolicy" value={opt.value} defaultChecked={opt.value === 'order'} style={{ accentColor: '#875A7B' }} />
                          {opt.label}
                        </label>
                      ))}
                    </div>
                  </div>
                ) : (
                  <ReadField label="Vendor Taxes" value={tmpl.vendorTaxRate != null ? (TAX_LABEL[String(tmpl.vendorTaxRate)] ?? `${(tmpl.vendorTaxRate * 100).toFixed(0)}%`) : undefined} />
                )}
              </Section>

              <Section title="Description for Vendors">
                {editMode ? (
                  <textarea
                    value={purchaseDescription}
                    onChange={e => setPurchaseDescription(e.target.value)}
                    placeholder="A note for the vendor."
                    rows={4}
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1"
                    style={focusStyle}
                  />
                ) : (
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">
                    {purchaseDescription || <span className="text-gray-300">—</span>}
                  </p>
                )}
              </Section>
            </div>
          )}

          {/* ── Inventory ── */}
          {activeTab === 'inventory' && (
            editMode ? (
              <div className="grid grid-cols-2 gap-x-12 gap-y-3 max-w-xl">
                <Row label="Weight (kg)">
                  <NumericInput step="0.001" min={0} value={tmpl.weight ?? 0} onChange={e => setField('weight', parseFloat(e.target.value) || undefined)} className={fieldClass} style={focusStyle} />
                </Row>
                <Row label="Volume (L)">
                  <NumericInput step="0.001" min={0} value={tmpl.volume ?? 0} onChange={e => setField('volume', parseFloat(e.target.value) || undefined)} className={fieldClass} style={focusStyle} />
                </Row>
                <Row label="Tracking">
                  <select value={tmpl.tracking ?? 'none'} onChange={e => setField('tracking', e.target.value as ProductTemplate['tracking'])} className={fieldClass} style={focusStyle}>
                    <option value="none">No Tracking</option>
                    <option value="lot">By Lot</option>
                    <option value="serial">By Serial Number</option>
                  </select>
                </Row>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-12 gap-y-2 max-w-xl">
                <ReadField label="Weight (kg)" value={tmpl.weight != null ? `${tmpl.weight} kg` : undefined} />
                <ReadField label="Volume (L)" value={tmpl.volume != null ? `${tmpl.volume} L` : undefined} />
                <ReadField label="Tracking" value={
                  tmpl.tracking === 'lot' ? 'By Lot' :
                  tmpl.tracking === 'serial' ? 'By Serial Number' : 'No Tracking'
                } />
              </div>
            )
          )}

        </div>
      </div>

      {/* ── Chatter ──────────────────────────────────────────────────────────── */}
      <div className="mx-4 mb-4 bg-white border border-gray-200 rounded p-4">
        <div className="flex items-center gap-4 pb-3 border-b border-gray-100">
          <button className="text-sm text-gray-500 hover:text-gray-700 font-medium">Send message</button>
          <button className="text-sm text-gray-500 hover:text-gray-700">Log note</button>
          <button className="text-sm text-gray-500 hover:text-gray-700">Schedule activity</button>
        </div>

        <div className="pt-4">
          <ChatterFeed
            resource="product-template"
            resourceId={isNew ? undefined : tmpl.id}
            isNew={isNew}
            fallbackCreatedAt={tmpl.createdAt}
            fallbackCreatedBy={tmpl.createdBy ?? 'Administrator'}
          />
        </div>
      </div>
    </div>
  )

  // ── Vendor line helpers ────────────────────────────────────────────────────
  function addVendorLine() {
    setVendorLines(prev => [...prev, {
      id: Date.now().toString(),
      supplier: '',
      productVariant: '',
      minQty: 0,
      uom: 'Unit(s)',
      price: 0,
      currency: 'EUR',
      dateStart: '',
      dateEnd: '',
    }])
  }

  function removeVendorLine(index: number) {
    setVendorLines(prev => prev.filter((_, i) => i !== index))
  }

  function updateVendorLine(index: number, field: keyof VendorLine, value: unknown) {
    setVendorLines(prev => prev.map((line, i) => i === index ? { ...line, [field]: value } : line))
  }
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-gray-700 w-44 flex-shrink-0">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  )
}

function PriceInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center flex-1 border border-gray-300 rounded h-8 overflow-hidden bg-white">
      <span className="px-2 text-sm text-gray-500 border-r border-gray-200 h-full flex items-center bg-gray-50">€</span>
      <NumericInput
        step="0.01"
        min={0}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className="flex-1 h-full px-2 text-sm outline-none"
      />
    </div>
  )
}
