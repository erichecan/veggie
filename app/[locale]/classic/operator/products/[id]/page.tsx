'use client'
import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut, apiPost } from '@/lib/api'
import { NumericInput } from '@/components/ui/numeric-input'
import ChatterFeed from '@/components/shared/chatter-feed'
import SimilarProductAlert from '@/components/shared/similar-product-alert'
import type { ProductTemplate, ProductCategory, Order } from '@/lib/types'

// ── SVG Smart Button Icons ─────────────────────────────────────────────────────
function IconSales() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2 9m12-9l2 9M9 22a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2z"/>
    </svg>
  )
}

// ── SmartButton ────────────────────────────────────────────────────────────────
function SmartButton({ icon, value, label }: { icon: React.ReactNode; value: string | number; label: string }) {
  return (
    <div
      className="flex flex-col items-center gap-0.5 px-4 py-2 rounded border text-center min-w-[90px]"
      style={{ borderColor: '#d4b8d0' }}
    >
      <div className="flex items-center gap-1 text-xs font-semibold" style={{ color: '#875A7B' }}>
        {icon}
        <span>{value}</span>
      </div>
      <span className="text-xs text-gray-500 whitespace-nowrap">{label}</span>
    </div>
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
    sequence: 0,
    commissionPrice: 0,
    weight: 0,
  } : null)
  const [original, setOriginal] = useState<ProductTemplate | null>(null)
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [uoms, setUoms] = useState<{ id: string; name: string; nameZh?: string | null; category?: { name: string } }[]>([])
  const [editMode, setEditMode] = useState(isNew)
  const [saving, setSaving] = useState(false)

  // Smart button stats
  const [soldCount, setSoldCount] = useState(0)
  const [onHandQty, setOnHandQty] = useState(0)

  // 手动库存调整（针对本商品的库存单元 variant）
  const [variants, setVariants] = useState<{ id: string; name: string; qtyOnHand: number; uomName?: string }[]>([])
  const [showAdjust, setShowAdjust] = useState(false)
  const [adjVariantId, setAdjVariantId] = useState('')
  const [adjDir, setAdjDir] = useState<'in' | 'out'>('in')
  const [adjQty, setAdjQty] = useState('')
  const [adjNote, setAdjNote] = useState('')
  const [adjSubmitting, setAdjSubmitting] = useState(false)

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
        for (const order of orders) {
          const matching = (order.items ?? []).filter(item => item.productId === templateId)
          if (matching.length > 0) count++
        }
        setSoldCount(count)
        try {
          const allProducts = await apiGet<Array<{ id: string; name: string; templateId: string; qtyOnHand: number; uomName?: string }>>('/api/products')
          const mine = allProducts.filter(p => p.templateId === templateId)
          setOnHandQty(mine.reduce((s, p) => s + (p.qtyOnHand ?? 0), 0))
          setVariants(mine.map(p => ({ id: p.id, name: p.name, qtyOnHand: p.qtyOnHand ?? 0, uomName: p.uomName })))
          if (mine.length === 1) setAdjVariantId(mine[0].id)
        } catch { /* ignore */ }
      }
      setCategories(cats)
    } catch {
      if (!isNew) router.push(`${prefix}/classic/operator/products`)
    }
  }

  useEffect(() => { load() }, [id])

  async function submitAdjust() {
    const vid = adjVariantId || variants[0]?.id
    if (!vid) { toast.error('该商品暂无可调整的库存单元'); return }
    const n = Number(adjQty)
    if (!Number.isFinite(n) || n <= 0) { toast.error('请输入大于 0 的调整数量'); return }
    const qty = adjDir === 'in' ? n : -n
    const v = variants.find(x => x.id === vid)
    setAdjSubmitting(true)
    try {
      await apiPost('/api/stock-moves', {
        productId: vid,
        productName: v?.name ?? tmpl?.name ?? '商品',
        qty,
        type: 'ADJUSTMENT',
        note: adjNote.trim() || (adjDir === 'in' ? '手动盘盈' : '手动盘亏'),
      })
      toast.success('库存调整成功')
      setShowAdjust(false); setAdjQty(''); setAdjNote(''); setAdjDir('in')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '调整失败')
    } finally {
      setAdjSubmitting(false)
    }
  }

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

              {/* 1 / — < > */}
              <div className="flex items-center gap-1 ml-auto text-sm text-gray-500">
                <span>1 / —</span>
                <button className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-30" disabled>‹</button>
                <button className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-30" disabled>›</button>
              </div>
            </>
          )}
        </div>
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
                {editMode && (
                  <SimilarProductAlert name={tmpl.name} excludeId={isNew ? undefined : tmpl.id} />
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
              </div>
            )}
          </div>
        </div>

        {/* 内容区：单页分区块 */}
        <div className="px-6 py-5">

          <Section title="Basic Info">
            {editMode ? (
              <div className="grid grid-cols-2 gap-x-12 gap-y-3 max-w-3xl">
                <Row label="Internal Reference">
                  <input value={tmpl.internalRef ?? ''} onChange={e => setField('internalRef', e.target.value || undefined)} className={fieldClass} style={{ ...focusStyle, color: '#875A7B' }} />
                </Row>
                <Row label="Product Type">
                  <select value={tmpl.type} onChange={e => setField('type', e.target.value as ProductTemplate['type'])} className={fieldClass} style={focusStyle}>
                    {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Row>
                <Row label="Barcode">
                  <input value={tmpl.barcode ?? ''} onChange={e => setField('barcode', e.target.value || undefined)} className={fieldClass} style={focusStyle} />
                </Row>
                <Row label="Sequence">
                  <NumericInput value={tmpl.sequence ?? 0} onChange={e => setField('sequence', parseInt(e.target.value) || 0)} className={fieldClass} style={focusStyle} />
                </Row>
                <Row label="Product Category">
                  <select value={tmpl.categoryId ?? ''} onChange={e => setField('categoryId', e.target.value || undefined)} className={fieldClass} style={focusStyle}>
                    <option value="">— All —</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.nameZh ?? c.name}</option>)}
                  </select>
                </Row>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-12 gap-y-2 max-w-3xl">
                <ReadField label="Internal Reference" value={tmpl.internalRef ? <span style={{ color: '#875A7B' }}>{tmpl.internalRef}</span> : undefined} />
                <ReadField label="Product Type" value={TYPE_LABEL[tmpl.type] ?? tmpl.type} />
                <ReadField label="Barcode" value={tmpl.barcode} />
                <ReadField label="Sequence" value={tmpl.sequence ?? 0} />
                <ReadField label="Product Category" value={catName} />
              </div>
            )}
          </Section>

          <Section title="Pricing & Tax">
            {editMode ? (
              <div className="grid grid-cols-2 gap-x-12 gap-y-3 max-w-3xl">
                <Row label="Sales Price">
                  <PriceInput value={tmpl.listPrice} onChange={v => setField('listPrice', v)} />
                </Row>
                <Row label="Cost">
                  <PriceInput value={tmpl.standardPrice} onChange={v => setField('standardPrice', v)} />
                </Row>
                <Row label="Customer Taxes">
                  <select value={String(tmpl.customerTaxRate)} onChange={e => setField('customerTaxRate', parseFloat(e.target.value))} className={fieldClass} style={focusStyle}>
                    {TAX_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Row>
                <Row label="Vendor Taxes">
                  <select value={String(tmpl.vendorTaxRate ?? '')} onChange={e => setField('vendorTaxRate', e.target.value ? parseFloat(e.target.value) : undefined)} className={fieldClass} style={focusStyle}>
                    <option value="">— None —</option>
                    {TAX_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Row>
                <Row label="Commission Price">
                  <PriceInput value={tmpl.commissionPrice ?? 0} onChange={v => setField('commissionPrice', v || undefined)} />
                </Row>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-12 gap-y-2 max-w-3xl">
                <ReadField label="Sales Price" value={`€${tmpl.listPrice.toFixed(2)}`} />
                <ReadField label="Cost" value={`€${tmpl.standardPrice.toFixed(2)}`} />
                <ReadField label="Customer Taxes" value={TAX_LABEL[String(tmpl.customerTaxRate)] ?? `${(tmpl.customerTaxRate * 100).toFixed(0)}%`} />
                <ReadField label="Vendor Taxes" value={tmpl.vendorTaxRate != null ? (TAX_LABEL[String(tmpl.vendorTaxRate)] ?? `${(tmpl.vendorTaxRate * 100).toFixed(0)}%`) : undefined} />
                <ReadField label="Commission Price" value={tmpl.commissionPrice != null ? `€${tmpl.commissionPrice.toFixed(2)}` : undefined} />
              </div>
            )}
          </Section>

          <Section title="Inventory & UoM">
            {!isNew && (
              <div className="mb-4 pb-4 border-b border-gray-100 flex items-center gap-3 flex-wrap">
                <button onClick={() => setShowAdjust(true)} className="px-3 py-1.5 rounded text-sm font-medium text-white" style={{ background: '#875A7B' }}>＋ 手动调整库存</button>
                <span className="text-xs text-gray-400">当前在手合计 {onHandQty.toFixed(2)}</span>
              </div>
            )}
            {editMode ? (
              <div className="grid grid-cols-2 gap-x-12 gap-y-3 max-w-3xl">
                <Row label="Unit of Measure">
                  <select value={tmpl.uomId ?? ''} onChange={e => setField('uomId', e.target.value || undefined)} className={fieldClass} style={focusStyle}>
                    <option value="">— 请选择 —</option>
                    {uoms.map(u => <option key={u.id} value={u.id}>{u.nameZh ?? u.name}</option>)}
                  </select>
                </Row>
                <Row label="Purchase UoM">
                  <select value={tmpl.purchaseUomId ?? ''} onChange={e => setField('purchaseUomId', e.target.value || undefined)} className={fieldClass} style={focusStyle}>
                    <option value="">— 请选择 —</option>
                    {uoms.map(u => <option key={u.id} value={u.id}>{u.nameZh ?? u.name}</option>)}
                  </select>
                </Row>
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
              <div className="grid grid-cols-2 gap-x-12 gap-y-2 max-w-3xl">
                <ReadField label="Unit of Measure" value={
                  tmpl.uomId
                    ? (uoms.find(u => u.id === tmpl.uomId)?.nameZh ?? uoms.find(u => u.id === tmpl.uomId)?.name)
                    : 'Unit(s)'
                } />
                <ReadField label="Purchase UoM" value={
                  tmpl.purchaseUomId
                    ? (uoms.find(u => u.id === tmpl.purchaseUomId)?.nameZh ?? uoms.find(u => u.id === tmpl.purchaseUomId)?.name)
                    : 'Unit(s)'
                } />
                <ReadField label="Weight (kg)" value={tmpl.weight != null ? `${tmpl.weight} kg` : undefined} />
                <ReadField label="Volume (L)" value={tmpl.volume != null ? `${tmpl.volume} L` : undefined} />
                <ReadField label="Tracking" value={
                  tmpl.tracking === 'lot' ? 'By Lot' :
                  tmpl.tracking === 'serial' ? 'By Serial Number' : 'No Tracking'
                } />
                {!isNew && <ReadField label="当前库存" value={onHandQty.toFixed(2)} />}
              </div>
            )}
          </Section>

          <Section title="Sale Description">
            {editMode ? (
              <textarea
                value={tmpl.saleDescription ?? ''}
                onChange={e => setField('saleDescription', e.target.value || undefined)}
                placeholder="This note will be printed on sales orders and invoices."
                rows={4}
                className="w-full max-w-3xl border border-gray-300 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1"
                style={focusStyle}
              />
            ) : (
              <p className="text-sm text-gray-700 whitespace-pre-wrap max-w-3xl">
                {tmpl.saleDescription || <span className="text-gray-300">—</span>}
              </p>
            )}
          </Section>

          <Section title="Internal Notes">
            {editMode ? (
              <textarea
                value={tmpl.description ?? ''}
                onChange={e => setField('description', e.target.value || undefined)}
                placeholder="This note is only for internal purposes."
                rows={3}
                className="w-full max-w-3xl border border-gray-300 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 bg-white"
                style={focusStyle}
              />
            ) : (
              <p className="text-sm text-gray-700 whitespace-pre-wrap max-w-3xl">
                {tmpl.description || <span className="text-gray-300">—</span>}
              </p>
            )}
          </Section>

        </div>
      </div>

      {/* ── Chatter ──────────────────────────────────────────────────────────── */}
      <div className="mx-4 mb-4 bg-white border border-gray-200 rounded p-4">
        <h3 className="text-sm font-semibold text-gray-700 pb-3 border-b border-gray-100">操作日志</h3>

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

      {showAdjust && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (!adjSubmitting) setShowAdjust(false) }}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h2 className="text-base font-semibold truncate" style={{ color: '#875A7B' }}>手动库存调整 · {tmpl?.name}</h2>
              <button onClick={() => setShowAdjust(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none shrink-0 ml-2">✕</button>
            </div>
            <div className="px-5 py-4 space-y-4">
              {variants.length > 1 ? (
                <div>
                  <label className="text-xs text-gray-500 block mb-1">库存单元 *</label>
                  <select value={adjVariantId} onChange={e => setAdjVariantId(e.target.value)} className="border border-gray-300 rounded px-3 py-2 text-sm w-full outline-none">
                    <option value="">— 选择库存单元 —</option>
                    {variants.map(v => <option key={v.id} value={v.id}>{v.name}（在手 {v.qtyOnHand}）</option>)}
                  </select>
                </div>
              ) : (
                <div className="text-xs text-gray-500">当前在手：{variants[0]?.qtyOnHand ?? onHandQty}{variants[0]?.uomName ? ' ' + variants[0].uomName : ''}</div>
              )}
              <div>
                <label className="text-xs text-gray-500 block mb-1">调整方向 *</label>
                <div className="flex gap-2">
                  <button onClick={() => setAdjDir('in')} className="flex-1 px-3 py-2 rounded text-sm font-medium border" style={adjDir === 'in' ? { background: '#dcfce7', borderColor: '#16a34a', color: '#15803d' } : { borderColor: '#d1d5db', color: '#6b7280' }}>盘盈（+ 增加）</button>
                  <button onClick={() => setAdjDir('out')} className="flex-1 px-3 py-2 rounded text-sm font-medium border" style={adjDir === 'out' ? { background: '#fee2e2', borderColor: '#dc2626', color: '#b91c1c' } : { borderColor: '#d1d5db', color: '#6b7280' }}>盘亏（− 减少）</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">调整数量 *</label>
                <input type="number" min="0" step="any" value={adjQty} onChange={e => setAdjQty(e.target.value)} placeholder="输入数量（正数）" className="border border-gray-300 rounded px-3 py-2 text-sm w-full outline-none" />
                {Number(adjQty) > 0 && (
                  <p className="text-xs text-gray-400 mt-1">
                    调整后在手：{(variants.find(v => v.id === (adjVariantId || variants[0]?.id))?.qtyOnHand ?? onHandQty)} → <span className="font-semibold" style={{ color: '#875A7B' }}>{(variants.find(v => v.id === (adjVariantId || variants[0]?.id))?.qtyOnHand ?? onHandQty) + (adjDir === 'in' ? 1 : -1) * Number(adjQty)}</span>
                  </p>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">调整原因 / 备注</label>
                <input value={adjNote} onChange={e => setAdjNote(e.target.value)} placeholder="如：盘点差异、损耗、期初录入…" className="border border-gray-300 rounded px-3 py-2 text-sm w-full outline-none" />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200">
              <button onClick={() => setShowAdjust(false)} className="px-4 py-2 text-sm rounded border border-gray-300 text-gray-600">取消</button>
              <button onClick={submitAdjust} disabled={adjSubmitting} className="px-4 py-2 text-sm rounded text-white font-medium disabled:opacity-50" style={{ background: '#875A7B' }}>{adjSubmitting ? '提交中…' : '确认调整'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
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
