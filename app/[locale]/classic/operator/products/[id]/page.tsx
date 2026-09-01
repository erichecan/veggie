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
import { validateSaleUomItems, priceOf, type SaleUomPriceMode } from '@/lib/sale-uom'

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

// 多单位销售(20260714)：ProductSaleUom 行的前端形态
interface SaleUomRow {
  uomId: string
  isDefault: boolean
  /** 1 个此单位 = factor 个基础单位（基础单位自身恒为 1） */
  factor: number
  priceOverride: number | null
  active: boolean
  priceMode: SaleUomPriceMode
  priceDiscountPct: number
  priceSurcharge: number
}

export default function ClassicProductDetailPage() {
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
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
    status: 'active',
    createdAt: new Date().toISOString(),
    sequence: 0,
    commissionPrice: 0,
    weight: 0,
  } : null)
  const [original, setOriginal] = useState<ProductTemplate | null>(null)
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [uoms, setUoms] = useState<{ id: string; name: string; nameZh?: string | null; categoryId?: string; factor?: number; type?: string; category?: { name: string } }[]>([])
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

  // 多单位销售(20260714 试点)：可售单位配置，挂在该商品模板下唯一/主变体 Product 上
  const [primaryProductId, setPrimaryProductId] = useState<string | null>(null)
  const [saleUoms, setSaleUoms] = useState<SaleUomRow[]>([])
  const [saleUomsSaving, setSaleUomsSaving] = useState(false)

  async function load() {
    try {
      const [found, cats, orders, uomList] = await Promise.all([
        isNew ? Promise.resolve(null) : apiGet<ProductTemplate>(`/api/products/${id}`),
        apiGet<ProductCategory[]>('/api/product-categories'),
        apiGet<Order[]>('/api/orders?include_lines=false'),
        apiGet<{ id: string; name: string; nameZh?: string | null; categoryId?: string; factor?: number; type?: string; category?: { name: string } }[]>('/api/uoms').catch(() => [] as { id: string; name: string; nameZh?: string | null; categoryId?: string; factor?: number; type?: string; category?: { name: string } }[]),
      ])
      const HIDDEN_CATEGORIES = ['Length', 'Time']
      setUoms(uomList.filter(u => !HIDDEN_CATEGORIES.includes(u.category?.name ?? '')))
      if (!isNew) {
        if (!found) { router.push(`${prefix}/classic/operator/products`); return }
        const normalized = {
          ...found,
          status: found.status?.toLowerCase() as ProductTemplate['status'] ?? found.status,
          type: found.type?.toLowerCase() as ProductTemplate['type'] ?? found.type,
        }
        setTmpl(normalized)
        setOriginal({ ...normalized })
        let count = 0
        for (const order of orders) {
          const matching = (order.items ?? []).filter(item => item.productId === found.id)
          if (matching.length > 0) count++
        }
        setSoldCount(count)
        // 20260825 合表重构：Product 自己就是唯一的库存单元(不再有"模板下多个变体"这层)，
        // 在手库存/库存单元直接取这一条记录，不用再拉全量 /api/products 过滤。
        const qty = Number((found as unknown as { qtyOnHand?: number }).qtyOnHand ?? 0)
        setOnHandQty(qty)
        const uom = uomList.find(u => u.id === found.uomId)
        setVariants([{
          id: found.id, name: found.name, qtyOnHand: qty,
          uomName: (isEn ? (uom?.name ?? uom?.nameZh) : (uom?.nameZh ?? uom?.name)) ?? undefined,
        }])
        setAdjVariantId(found.id)
        setPrimaryProductId(found.id)
        try {
          const rows = await apiGet<Array<{ uomId: string; isDefault: boolean; factor: number | string | null; priceOverride: number | null; active: boolean; priceMode?: SaleUomPriceMode; priceDiscountPct?: number | string | null; priceSurcharge?: number | string | null }>>(`/api/products/${found.id}/sale-uoms`)
          const mapped = rows.map(r => ({
            uomId: r.uomId, isDefault: r.isDefault, factor: Number(r.factor ?? 1) || 1, priceOverride: r.priceOverride, active: r.active,
            priceMode: r.priceMode ?? 'AUTO',
            priceDiscountPct: Number(r.priceDiscountPct ?? 0) || 0,
            priceSurcharge: Number(r.priceSurcharge ?? 0) || 0,
          }))
          // 基础单位这一行只在「保存过一次可售单位」之后才会真的落库(见 PUT 路由注释里
          // "提交列表里没有基准单位时自动补一行")——从没保存过的商品，GET 回来的列表里
          // 压根没有它，「基础单位是否可下单」这个开关就没地方挂。这里前端补一份默认
          // active:true 的虚拟行，保证这个开关任何时候都在，不用逼用户先随便加一个
          // 额外单位、保存一次才能看到。
          if (found.uomId && !mapped.some(r => r.uomId === found.uomId)) {
            mapped.push({
              uomId: found.uomId, isDefault: true, factor: 1, priceOverride: null, active: true,
              priceMode: 'FORMULA', priceDiscountPct: 0, priceSurcharge: 0,
            })
          }
          setSaleUoms(mapped)
        } catch { setSaleUoms([]) }
      }
      setCategories(cats)
    } catch {
      if (!isNew) router.push(`${prefix}/classic/operator/products`)
    }
  }

  useEffect(() => { load() }, [id])

  async function submitAdjust() {
    const vid = adjVariantId || variants[0]?.id
    if (!vid) { toast.error(isEn ? 'This product has no inventory unit to adjust' : '该商品暂无可调整的库存单元'); return }
    const n = Number(adjQty)
    if (!Number.isFinite(n) || n <= 0) { toast.error(isEn ? 'Please enter an adjustment quantity greater than 0' : '请输入大于 0 的调整数量'); return }
    const qty = adjDir === 'in' ? n : -n
    const v = variants.find(x => x.id === vid)
    setAdjSubmitting(true)
    try {
      await apiPost('/api/stock-moves', {
        productId: vid,
        productName: v?.name ?? tmpl?.name ?? (isEn ? 'Product' : '商品'),
        qty,
        type: 'ADJUSTMENT',
        note: adjNote.trim() || (adjDir === 'in' ? (isEn ? 'Manual stock gain' : '手动盘盈') : (isEn ? 'Manual stock loss' : '手动盘亏')),
      })
      toast.success(isEn ? 'Inventory adjusted successfully' : '库存调整成功')
      setShowAdjust(false); setAdjQty(''); setAdjNote(''); setAdjDir('in')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Adjustment failed' : '调整失败'))
    } finally {
      setAdjSubmitting(false)
    }
  }

  function setField<K extends keyof ProductTemplate>(key: K, value: ProductTemplate[K]) {
    setTmpl(prev => prev ? { ...prev, [key]: value } : null)
  }

  // ── 可售单位(ProductSaleUom)本地编辑 ──────────────────────────────────────────
  // 基准单位单一入口(20260823)：谁是「基础」行不再由本区块的单选钮决定，
  // 纯派生自页头「Unit of Measure」——只有它能改基准单位。
  function isBaseUom(row: SaleUomRow) {
    return tmpl?.uomId ? row.uomId === tmpl.uomId : row.isDefault
  }
  function addSaleUomRow() {
    // 基准单位不能作为"额外可售单位"加进来——它已经隐式存在(见上面 isBaseUom 的
    // return null)。这里如果不排除 tmpl.uomId，候选一旦落到它头上，新行会被塞进
    // state 但因为 isBaseUom 判断永远不渲染，表现就是点了「+ 添加单位」界面上
    // 什么反应都没有，像按钮坏了(20260901 客户反馈"添加不了"实测复现)。
    const used = new Set(saleUoms.map(r => r.uomId))
    if (tmpl?.uomId) used.add(tmpl.uomId)
    const candidate = uoms.find(u => !used.has(u.id) && (!tmpl?.uomId || u.categoryId === uoms.find(x => x.id === tmpl.uomId)?.categoryId))
    if (!candidate) { toast.error(isEn ? 'No more units available in this category' : '该计量类别下已没有可选的单位了'); return }
    setSaleUoms(prev => [...prev, {
      uomId: candidate.id,
      isDefault: tmpl?.uomId ? candidate.id === tmpl.uomId : prev.length === 0,
      factor: 1, priceOverride: null, active: true,
      // 价格公式(20260823 改行内摊平后)不再有单独的"自动/固定/公式"模式选择，统一用 FORMULA，
      // 折扣/加价都是 0 时等价于"自动按系数折算"，行为跟以前的 AUTO 模式完全一致。
      priceMode: 'FORMULA', priceDiscountPct: 0, priceSurcharge: 0,
    }])
  }
  function updateSaleUomRow(index: number, patch: Partial<SaleUomRow>) {
    setSaleUoms(prev => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }
  function removeSaleUomRow(index: number) {
    setSaleUoms(prev => {
      const next = prev.filter((_, i) => i !== index)
      if (next.length > 0 && !next.some(r => r.isDefault) && !next.some(r => tmpl?.uomId && r.uomId === tmpl.uomId)) {
        next[0] = { ...next[0], isDefault: true }
      }
      return next
    })
  }
  async function saveSaleUoms() {
    if (!primaryProductId) return
    if (saleUoms.some(r => !r.uomId)) { toast.error(isEn ? 'Please select a unit for every row' : '请为每一行选择单位'); return }
    const dupes = new Set(saleUoms.map(r => r.uomId))
    if (dupes.size !== saleUoms.length) { toast.error(isEn ? 'Duplicate unit selected' : '同一单位不能重复配置'); return }
    // 基准单位固定用页头选的那个；提交行里没有匹配行时服务端会自动补一行，这里不用先挡
    if (!tmpl?.uomId && saleUoms.length > 0 && saleUoms.filter(r => r.isDefault).length !== 1) {
      toast.error(isEn ? 'Exactly one unit must be default' : '必须且只能有一个默认单位')
      return
    }
    setSaleUomsSaving(true)
    try {
      // 页头 Unit of Measure 是基准单位的唯一入口，但它和这里的保存是两个独立请求；
      // 若用户刚改了还没点主表单 Save，后端这时查到的 product.uomId 还是旧值，会导致
      // 提交的行里没有一行匹配基准单位而报"必须且只能有一个默认单位"。这里先把 uomId
      // 落库，保证后端拿到的基准单位跟页面上看到的一致。
      if (tmpl?.uomId && tmpl.uomId !== original?.uomId) {
        await apiPut(`/api/products/${primaryProductId}`, { uomId: tmpl.uomId })
        setOriginal(prev => (prev ? { ...prev, uomId: tmpl.uomId } : prev))
      }
      const payload = saleUoms.map(r => ({ ...r, isDefault: tmpl?.uomId ? r.uomId === tmpl.uomId : r.isDefault }))
      const rows = await apiPut<Array<{ uomId: string; isDefault: boolean; factor: number | string | null; priceOverride: number | null; active: boolean; priceMode?: SaleUomPriceMode; priceDiscountPct?: number | string | null; priceSurcharge?: number | string | null }>>(
        `/api/products/${primaryProductId}/sale-uoms`,
        { items: payload },
      )
      setSaleUoms(rows.map(r => ({
        uomId: r.uomId, isDefault: r.isDefault, factor: Number(r.factor ?? 1) || 1, priceOverride: r.priceOverride, active: r.active,
        priceMode: r.priceMode ?? 'AUTO',
        priceDiscountPct: Number(r.priceDiscountPct ?? 0) || 0,
        priceSurcharge: Number(r.priceSurcharge ?? 0) || 0,
      })))
      toast.success(isEn ? 'Sellable units saved' : '可售单位已保存')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
    } finally {
      setSaleUomsSaving(false)
    }
  }

  async function handleSave() {
    if (!tmpl || saving) return
    if (!tmpl.name.trim()) { toast.error(isEn ? 'Product name cannot be empty' : '商品名称不能为空'); return }
    if (isNew) {
      const saleUomsError = validateSaleUomItems(saleUoms)
      if (saleUomsError) { toast.error(saleUomsError); return }
    }
    setSaving(true)
    try {
      if (isNew) {
        const { id: _id, ...fields } = tmpl
        const created = await (await import('@/lib/api')).apiPost<ProductTemplate>('/api/products', {
          ...fields,
          createdAt: new Date().toISOString(),
        })
        // 20260825 合表重构：Product 自己就是唯一的库存单元，创建即是 primaryProductId，
        // 可售单位不再随创建事务一起落库，改成创建成功后单独调一次保存。
        if (saleUoms.length > 0) {
          try {
            await apiPut(`/api/products/${created.id}/sale-uoms`, { items: saleUoms })
          } catch (e) {
            toast.error(e instanceof Error ? e.message : (isEn ? 'Product created, but saving sellable units failed — please retry on the detail page' : '商品已创建，但可售单位保存失败——请到详情页重试'))
          }
        }
        toast.success(isEn ? `Created "${created.name}"` : `已创建「${created.name}」`)
        router.push(`${prefix}/classic/operator/products/${created.id}`)
      } else {
        const updated = { ...tmpl, updatedAt: new Date().toISOString() }
        await apiPut(`/api/products/${tmpl.id}`, updated)
        setOriginal({ ...updated })
        setTmpl({ ...updated })
        setEditMode(false)
        toast.success(isEn ? `Saved "${updated.name}"` : `已保存「${updated.name}」`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Save failed' : '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  function handleDiscard() {
    if (isNew) { router.push(`${prefix}/classic/operator/products`); return }
    if (original) { setTmpl({ ...original }) }
    setEditMode(false)
  }

  // 归档/恢复(20260821)：独立于 Save/Discard 流程，点击即生效，不进编辑态、不需二次确认
  const [archiveToggling, setArchiveToggling] = useState(false)
  async function toggleActive() {
    if (!tmpl || isNew || archiveToggling) return
    const nextStatus: ProductTemplate['status'] = tmpl.status === 'active' ? 'archived' : 'active'
    setArchiveToggling(true)
    try {
      await apiPut(`/api/products/${tmpl.id}`, { status: nextStatus })
      setTmpl(prev => prev ? { ...prev, status: nextStatus } : prev)
      setOriginal(prev => prev ? { ...prev, status: nextStatus } : prev)
      toast.success(
        nextStatus === 'active'
          ? (isEn ? 'Product restored to Active' : '商品已恢复为 Active')
          : (isEn ? 'Product archived' : '商品已归档')
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to update status' : '状态更新失败'))
    } finally {
      setArchiveToggling(false)
    }
  }

  if (!tmpl) return <div className="p-8 text-gray-400 text-sm">{isEn ? 'Loading...' : '加载中...'}</div>

  // ⛔ 20260819 曾把这里限成"只给纯计量单位选(kg/L/g/mL/件…)"，箱/袋/CASE/BAG
  // 这类容器单位(type=BIGGER)被挡在 Unit of Measure/Purchase UoM 下拉之外。
  // 20260825 查生产库发现这个限制跟实际数据完全脱节：229 个商品名里带"CASE/箱/kg"
  // 这种箱规写法的商品里，227 个的基准单位本来就是 BIGGER 型(CASE/BAG 等)，只有 2 个
  // (含 Broccoli 6KG CASE)例外卡在 KG——容器单位当基准早就是主流用法，不是要挡的例外，
  // 挡新选反而是挡在了正确用法上。改回给全部 uoms，不再按 type 过滤。
  const baseUoms = uoms
  const fieldClass = "w-full h-8 px-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 bg-white"
  const focusStyle = { '--tw-ring-color': '#875A7B' } as React.CSSProperties
  const btnBase = "h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
  const selectedCategory = categories.find(c => c.id === tmpl.categoryId)
  const catName = selectedCategory ? (isEn ? (selectedCategory.name || selectedCategory.nameZh) : (selectedCategory.nameZh ?? selectedCategory.name)) : undefined
  const isActive = tmpl.status === 'active'
  // Active 开关（20260821）：与 Edit/Create、Save/Discard 并排，点击立即生效，不需二次确认
  const activeToggle = !isNew && (
    <button
      type="button"
      onClick={toggleActive}
      disabled={archiveToggling}
      role="switch"
      aria-checked={isActive}
      title={isEn ? (isActive ? 'Click to archive this product' : 'Click to restore this product to Active') : (isActive ? '点击归档该商品' : '点击恢复该商品为 Active')}
      className="h-8 px-2 flex items-center gap-2 text-sm rounded border border-gray-300 bg-white disabled:opacity-50 transition-colors"
    >
      <span className={isActive ? 'text-gray-700' : 'text-gray-400'}>{isEn ? 'Active' : 'Active'}</span>
      <span
        className="relative inline-block w-8 h-4 rounded-full transition-colors"
        style={{ background: isActive ? '#875A7B' : '#d1d5db' }}
      >
        <span
          className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
          style={{ left: isActive ? '18px' : '2px' }}
        />
      </span>
    </button>
  )

  return (
    <div className="min-h-screen bg-gray-50">
      {/*
        归档警示条（20260819）。
        客户在一个已归档商品上配了半天可售单位，回到报价页却怎么都搜不到它 ——
        下单/报价的选品只取 `status=ACTIVE`，而这个页面照常让人编辑保存，
        全程没有任何提示。事后再解释"它是归档的"，那半天已经白花了。
      */}
      {!isNew && tmpl.status === 'archived' && (
        <div className="px-4 py-2.5 text-sm flex items-center gap-2" style={{ background: '#fdecea', color: '#a33a2a' }}>
          <span>⚠</span>
          <span>
            {isEn
              ? 'This product is ARCHIVED — it will NOT appear when picking products on order / quotation pages. Set the status back to Active to sell it again.'
              : '该商品已归档 —— 下单 / 报价页的选品中不会出现它。要重新销售，请把状态改回 Active。'}
          </span>
        </div>
      )}
      {/* ── 顶部控制栏 ───────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-4">
        {/* 面包屑 */}
        <div className="py-2 text-sm flex items-center gap-1 text-gray-500">
          <button onClick={() => router.push(`${prefix}/classic/operator/products`)} className="hover:underline" style={{ color: '#875A7B' }}>
            Product Variants
          </button>
          <span className="text-gray-300 mx-1">›</span>
          <span className="text-gray-800 font-medium">{isNew ? 'New' : (tmpl.name || (isEn ? '(Unnamed)' : '（未命名）'))}</span>
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
              {activeToggle}
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
              {activeToggle}

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
                title={editMode ? (isEn ? 'Click to upload image' : '点击上传图片') : undefined}
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
                  <h1 className="text-xl font-semibold text-gray-900 mb-2">{tmpl.name || (isEn ? '(Unnamed)' : '（未命名）')}</h1>
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
                    {categories.map(c => <option key={c.id} value={c.id}>{isEn ? (c.name || c.nameZh) : (c.nameZh ?? c.name)}</option>)}
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
                <button onClick={() => setShowAdjust(true)} className="px-3 py-1.5 rounded text-sm font-medium text-white" style={{ background: '#875A7B' }}>{isEn ? '+ Manual Stock Adjustment' : '＋ 手动调整库存'}</button>
                <span className="text-xs text-gray-400">{isEn ? `Total on hand ${onHandQty.toFixed(2)}` : `当前在手合计 ${onHandQty.toFixed(2)}`}</span>
              </div>
            )}
            {editMode ? (
              <div className="grid grid-cols-2 gap-x-12 gap-y-3 max-w-3xl">
                <Row label="Unit of Measure">
                  <div>
                    <select value={tmpl.uomId ?? ''} onChange={e => setField('uomId', e.target.value || undefined)} className={fieldClass} style={focusStyle}>
                      <option value="">{isEn ? '— Select —' : '— 请选择 —'}</option>
                      {baseUoms.map(u => <option key={u.id} value={u.id}>{isEn ? (u.name || u.nameZh) : (u.nameZh ?? u.name)}</option>)}
                    </select>
                    {saleUoms.length > 0 && (
                      <p className="text-xs text-amber-600 mt-1">
                        {isEn
                          ? 'This is the only place to change the base unit. Existing sellable-unit factors below are relative to the OLD base and will not auto-convert — please recheck them after changing.'
                          : '这是唯一能改基准单位的地方。下面「可售单位」各行的系数是相对旧基准算的，不会自动换算，改完请重新核对。'}
                      </p>
                    )}
                  </div>
                </Row>
                <Row label="Purchase UoM">
                  <select value={tmpl.purchaseUomId ?? ''} onChange={e => setField('purchaseUomId', e.target.value || undefined)} className={fieldClass} style={focusStyle}>
                    <option value="">{isEn ? '— Select —' : '— 请选择 —'}</option>
                    {baseUoms.map(u => <option key={u.id} value={u.id}>{isEn ? (u.name || u.nameZh) : (u.nameZh ?? u.name)}</option>)}
                  </select>
                </Row>
                <Row label={isEn ? 'Gross Weight (kg)' : '毛重 Gross Weight (kg)'}>
                  <NumericInput step="0.001" min={0} value={tmpl.weight ?? 0} onChange={e => setField('weight', parseFloat(e.target.value) || undefined)} className={fieldClass} style={focusStyle} />
                </Row>
                {/* 净重与上面的"毛重"（仍是同一个 weight 字段，只是改了名字）是两个独立字段，
                    供物流、报关、称重使用。独立的 grossWeight 字段 20260825 已删除——跟这个
                    字段重复,生产 5482 个商品无一个填过；20260828 客户要求把 weight 的显示名
                    从"默认重量"改成"毛重"，字段本身没变。 */}
                <Row label={isEn ? 'Net Weight (kg)' : '净重 Net Weight (kg)'}>
                  <NumericInput step="0.001" min={0} value={tmpl.netWeight ?? 0} onChange={e => setField('netWeight', parseFloat(e.target.value) || undefined)} className={fieldClass} style={focusStyle} />
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
                    ? (() => { const u = uoms.find(u => u.id === tmpl.uomId); return isEn ? (u?.name || u?.nameZh) : (u?.nameZh ?? u?.name) })()
                    : 'Unit(s)'
                } />
                <ReadField label="Purchase UoM" value={
                  tmpl.purchaseUomId
                    ? (() => { const u = uoms.find(u => u.id === tmpl.purchaseUomId); return isEn ? (u?.name || u?.nameZh) : (u?.nameZh ?? u?.name) })()
                    : 'Unit(s)'
                } />
                <ReadField label={isEn ? 'Gross Weight (kg)' : '毛重 Gross Weight (kg)'} value={tmpl.weight != null ? `${tmpl.weight} kg` : undefined} />
                <ReadField label={isEn ? 'Net Weight (kg)' : '净重 Net Weight (kg)'} value={tmpl.netWeight != null ? `${tmpl.netWeight} kg` : undefined} />
                <ReadField label="Volume (L)" value={tmpl.volume != null ? `${tmpl.volume} L` : undefined} />
                <ReadField label="Tracking" value={
                  tmpl.tracking === 'lot' ? 'By Lot' :
                  tmpl.tracking === 'serial' ? 'By Serial Number' : 'No Tracking'
                } />
                {!isNew && <ReadField label={isEn ? 'Current Stock' : '当前库存'} value={onHandQty.toFixed(2)} />}
              </div>
            )}
          </Section>

          {(isNew || primaryProductId) && (
            <Section title={isEn ? 'Sellable Units (multi-UoM pilot)' : '可售单位（多单位销售试点）'}>
              <p className="text-xs text-gray-400 mb-3 max-w-3xl">
                {isEn
                  ? 'Configure the units this product can be sold in. The unit marked "Base" is what stock is counted in — set each other unit\'s factor to how many base units it contains (e.g. a case of 10 packets → 10). Leave the price blank to auto-scale from the base price by that factor.'
                  : '配置这个商品能按哪些单位卖。标为「基础」的那个单位就是库存的计数单位 —— 其余每个单位填「1 个它等于多少个基础单位」（如一箱装 10 包就填 10）。独立售价留空则按系数自动折算。'}
              </p>
              <div className="max-w-3xl space-y-2">
                {saleUoms.map((row, i) => {
                  // ⛔ 单位不再按类目限制：`10*700g CASE` 的基础单位是 PKT（Unit 类目），
                  //    而它也按 KG 卖（Weight 类目）—— 跨类目在真实业务里就是常态，
                  //    因为换算系数现在是这个商品自己的，不依赖全局类目体系。
                  const isBase = isBaseUom(row)
                  // 非基础行的下拉里不能选基准单位本身——选了会因为上面 isBaseUom 判断
                  // 变成新的「基础行」，把当前这行的换算/价格配置全部作废。基础行本身的
                  // 下拉锁死不可改（唯一入口是页头「Unit of Measure」），但选项列表必须
                  // 包含它自己的值，否则 <select> 找不到匹配项会显示空白。
                  const options = isBase ? uoms : (tmpl?.uomId ? uoms.filter(u => u.id !== tmpl.uomId) : uoms)
                  // 具体数量有两种真实场景，同一个数字含义相反，必须让用户自己选×/÷，不能瞎猜：
                  // 整箱/大包装(case of 10 packets)是"放大" → factor=数量本身；
                  // 半份/拆零(拆成 1/10)是"缩小" → factor=1/数量，更常见，默认就是这个方向。
                  // factor<=1 时按"缩小"展示(含新行默认的 factor=1，边界给÷不给×)，这样刷新页面
                  // 读旧数据也能还原出正确的×/÷，不用额外存一个 mode 字段。
                  const rowFactor = isBase ? 1 : (row.factor ?? 1)
                  const isDivideMode = rowFactor > 0 && rowFactor <= 1
                  const displayQty = isDivideMode ? Math.round((1 / rowFactor) * 1e6) / 1e6 : rowFactor
                  // "基准 × 系数"这一步的结果，与折扣/加价无关——借道 FORMULA(折扣/加减都是 0) 拿到这个干净的数，
                  // 公式行要展示"从这个数出发再调整"，不能直接用 finalPrice(已经算完调整)。
                  const stepPrice = priceOf([{ ...row, priceMode: 'FORMULA', priceDiscountPct: 0, priceSurcharge: 0 }], row.uomId, tmpl.listPrice)
                  const finalPrice = priceOf([row], row.uomId, tmpl.listPrice)
                  return (
                    <div key={i}>
                      <div className="flex items-center gap-2">
                        <select
                          value={row.uomId}
                          onChange={e => {
                            const nextUomId = e.target.value
                            // 换成基准单位的那一行系数要归 1 —— 否则携带着换基准单位前的旧系数去保存会被后端拦下
                            const nextIsBase = tmpl?.uomId ? nextUomId === tmpl.uomId : row.isDefault
                            updateSaleUomRow(i, { uomId: nextUomId, factor: nextIsBase ? 1 : row.factor })
                          }}
                          disabled={!editMode || isBase}
                          title={isBase ? (isEn ? 'Change the base unit from "Unit of Measure" above' : '基准单位只能在上面「Unit of Measure」改') : undefined}
                          className={fieldClass}
                          style={{ ...focusStyle, maxWidth: 180 }}
                        >
                          {options.map(u => <option key={u.id} value={u.id}>{isEn ? (u.name || u.nameZh) : (u.nameZh ?? u.name)}</option>)}
                        </select>
                        {isBase ? (
                          <span className="px-2 py-1 text-xs rounded font-medium whitespace-nowrap" style={{ background: '#f3e8f5', color: '#875A7B' }}>
                            {isEn ? 'Base' : '基础'}
                          </span>
                        ) : (
                          <span className="w-0" />
                        )}
                        {/* 具体数量：纯数字，不带方向——方向(×/÷)由后面「= base」那个开关决定。
                            基础单位恒为 1 且不可改 —— 它是库存的计数尺子。 */}
                        <NumericInput
                          step="0.000001" min={0}
                          value={isBase ? 1 : displayQty}
                          onChange={e => {
                            const n = e.target.value === '' ? 1 : Number(e.target.value)
                            const nextFactor = isDivideMode ? (n > 0 ? 1 / n : 1) : n
                            updateSaleUomRow(i, { factor: nextFactor })
                          }}
                          disabled={!editMode || isBase}
                          title={isEn
                            ? 'How many — pick × or ÷ on the right for the direction'
                            : '具体数量——方向(×放大/÷缩小)用右边的开关选'}
                          className="h-8 px-2 border border-gray-300 rounded text-sm text-center outline-none disabled:bg-gray-50 disabled:text-gray-400"
                          style={{ width: 90 }}
                        />
                        {/* 跟基础单位的关系：= base [×/÷开关] 数量。开关点一下就在放大/缩小间切换，
                            默认缩小(÷)更常见(拆零比整箱常见)；符号字号调大，纯展示+开关，不带计算器。 */}
                        {isBase ? (
                          <span className="w-0" />
                        ) : (
                          <div className="flex items-center gap-1.5 h-8 px-2 border border-gray-300 rounded text-xs bg-gray-50 whitespace-nowrap">
                            <span className="text-gray-500">{isEn ? '= base' : '= 基础'}</span>
                            <button
                              type="button"
                              disabled={!editMode}
                              onClick={() => {
                                const nextFactor = isDivideMode ? displayQty : (displayQty > 0 ? 1 / displayQty : 1)
                                updateSaleUomRow(i, { factor: nextFactor })
                              }}
                              title={isEn ? 'Toggle between "× multiply base" and "÷ split base"' : '在"×放大 base"和"÷拆分 base"之间切换'}
                              className="text-base leading-none font-bold px-0.5 disabled:cursor-not-allowed"
                              style={{ color: '#875A7B' }}
                            >
                              {isDivideMode ? '÷' : '×'}
                            </button>
                            <span className="font-medium" style={{ color: '#875A7B' }}>{displayQty}</span>
                          </div>
                        )}
                        {/* 价格：基础行价格恒等于 Sales Price，不再单独可编辑；其余行公式直接摊平在行内，
                            不用再点开才看到——price = base price + 一个百分比(可负=加价) + 一个绝对值(可负) */}
                        {isBase ? (
                          <div className="flex items-center h-8 px-2 text-sm text-gray-500 whitespace-nowrap">
                            €{tmpl.listPrice.toFixed(2)}
                          </div>
                        ) : editMode ? (
                          <div className="flex items-center gap-1 border border-gray-300 rounded h-8 px-2 bg-white text-xs whitespace-nowrap">
                            <span className="text-gray-400">€{stepPrice.toFixed(2)} +</span>
                            <NumericInput
                              step="0.01"
                              value={row.priceDiscountPct ?? 0}
                              onChange={e => updateSaleUomRow(i, { priceMode: 'FORMULA', priceDiscountPct: e.target.value === '' ? 0 : Number(e.target.value) })}
                              title={isEn ? 'Percentage adjustment, negative = discount' : '百分比调整，填负数就是打折'}
                              className="w-14 h-6 px-1 border border-gray-200 rounded text-xs no-spinner"
                            />
                            <span className="text-gray-400">% +</span>
                            <NumericInput
                              step="0.01"
                              value={row.priceSurcharge ?? 0}
                              onChange={e => updateSaleUomRow(i, { priceMode: 'FORMULA', priceSurcharge: e.target.value === '' ? 0 : Number(e.target.value) })}
                              title={isEn ? 'Flat amount, can be negative' : '绝对值，可以是负数'}
                              className="w-16 h-6 px-1 border border-gray-200 rounded text-xs no-spinner"
                            />
                            <span className="text-gray-400">=</span>
                            <span className="font-medium" style={{ color: '#875A7B' }}>€{finalPrice.toFixed(2)}</span>
                          </div>
                        ) : (
                          <div className="flex items-center h-8 px-2 text-sm text-gray-500 whitespace-nowrap">
                            €{finalPrice.toFixed(2)}
                          </div>
                        )}
                        {editMode && (
                          <button
                            type="button"
                            onClick={() => updateSaleUomRow(i, { active: !row.active })}
                            role="switch"
                            aria-checked={row.active}
                            title={isBase
                              ? (isEn
                                ? (row.active ? 'Click to disable selling in the base unit itself — the product can still be ordered in the other units configured below' : 'Click to enable')
                                : (row.active ? '点击停用「按基础单位本身售卖」——其余已配置的单位不受影响，仍可下单' : '点击启用'))
                              : (isEn
                                ? (row.active ? 'Click to disable — hidden when placing orders/quotations; factor & price relationships still apply if re-enabled' : 'Click to enable')
                                : (row.active ? '点击停用 —— 下单/报价时不再出现；换算与价格关系仍保留，重新启用即可用' : '点击启用'))}
                            className="h-8 px-2 flex items-center gap-1.5 text-xs rounded border border-gray-300 bg-white transition-colors whitespace-nowrap"
                          >
                            <span className={row.active ? 'text-gray-700' : 'text-gray-400'}>{isEn ? 'Sellable' : '可下单'}</span>
                            <span className="relative inline-block w-7 h-3.5 rounded-full transition-colors" style={{ background: row.active ? '#875A7B' : '#d1d5db' }}>
                              <span className="absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform" style={{ left: row.active ? '15px' : '2px' }} />
                            </span>
                          </button>
                        )}
                        {!editMode && !row.active && (
                          <span className="px-2 py-1 text-xs rounded bg-gray-100 text-gray-400 whitespace-nowrap">{isEn ? 'Disabled' : '已停用'}</span>
                        )}
                        {editMode && !isBase && (
                          <button onClick={() => removeSaleUomRow(i)} className="text-gray-400 hover:text-red-500 text-sm px-1">✕</button>
                        )}
                      </div>
                    </div>
                  )
                })}
                {saleUoms.filter(r => !isBaseUom(r)).length === 0 && (
                  <p className="text-xs text-gray-300">{isEn ? 'No additional sellable units configured yet.' : '尚未配置额外可售单位。'}</p>
                )}
                {editMode && (
                  <div className="flex items-center gap-2 pt-1">
                    <button onClick={addSaleUomRow} className={btnBase}>{isEn ? '+ Add Unit' : '＋ 添加单位'}</button>
                    {isNew ? (
                      <span className="text-xs text-gray-400">
                        {isEn ? 'Saved together with the product below' : '随下方"保存"按钮一起创建'}
                      </span>
                    ) : (
                      <button
                        onClick={saveSaleUoms}
                        disabled={saleUomsSaving}
                        className="h-8 px-4 text-sm font-medium text-white rounded transition-colors disabled:opacity-50"
                        style={{ background: '#875A7B' }}
                      >
                        {saleUomsSaving ? (isEn ? 'Saving...' : '保存中...') : (isEn ? 'Save Sellable Units' : '保存可售单位')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </Section>
          )}

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
        <h3 className="text-sm font-semibold text-gray-700 pb-3 border-b border-gray-100">{isEn ? 'Activity Log' : '操作日志'}</h3>

        <div className="pt-4">
          <ChatterFeed
            resource="product"
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
              <h2 className="text-base font-semibold truncate" style={{ color: '#875A7B' }}>{isEn ? `Manual Stock Adjustment · ${tmpl?.name}` : `手动库存调整 · ${tmpl?.name}`}</h2>
              <button onClick={() => setShowAdjust(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none shrink-0 ml-2">✕</button>
            </div>
            <div className="px-5 py-4 space-y-4">
              {variants.length > 1 ? (
                <div>
                  <label className="text-xs text-gray-500 block mb-1">{isEn ? 'Inventory Unit *' : '库存单元 *'}</label>
                  <select value={adjVariantId} onChange={e => setAdjVariantId(e.target.value)} className="border border-gray-300 rounded px-3 py-2 text-sm w-full outline-none">
                    <option value="">{isEn ? '— Select Inventory Unit —' : '— 选择库存单元 —'}</option>
                    {variants.map(v => <option key={v.id} value={v.id}>{isEn ? `${v.name} (on hand ${v.qtyOnHand})` : `${v.name}（在手 ${v.qtyOnHand}）`}</option>)}
                  </select>
                </div>
              ) : (
                <div className="text-xs text-gray-500">{isEn ? 'Current on hand: ' : '当前在手：'}{variants[0]?.qtyOnHand ?? onHandQty}{variants[0]?.uomName ? ' ' + variants[0].uomName : ''}</div>
              )}
              <div>
                <label className="text-xs text-gray-500 block mb-1">{isEn ? 'Adjustment Direction *' : '调整方向 *'}</label>
                <div className="flex gap-2">
                  <button onClick={() => setAdjDir('in')} className="flex-1 px-3 py-2 rounded text-sm font-medium border" style={adjDir === 'in' ? { background: '#dcfce7', borderColor: '#16a34a', color: '#15803d' } : { borderColor: '#d1d5db', color: '#6b7280' }}>{isEn ? 'Gain (+ Increase)' : '盘盈（+ 增加）'}</button>
                  <button onClick={() => setAdjDir('out')} className="flex-1 px-3 py-2 rounded text-sm font-medium border" style={adjDir === 'out' ? { background: '#fee2e2', borderColor: '#dc2626', color: '#b91c1c' } : { borderColor: '#d1d5db', color: '#6b7280' }}>{isEn ? 'Loss (− Decrease)' : '盘亏（− 减少）'}</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">{isEn ? 'Adjustment Quantity *' : '调整数量 *'}</label>
                <input type="number" min="0" step="any" value={adjQty} onChange={e => setAdjQty(e.target.value)} placeholder={isEn ? 'Enter quantity (positive number)' : '输入数量（正数）'} className="border border-gray-300 rounded px-3 py-2 text-sm w-full outline-none" />
                {Number(adjQty) > 0 && (
                  <p className="text-xs text-gray-400 mt-1">
                    {isEn ? 'On hand after adjustment: ' : '调整后在手：'}{(variants.find(v => v.id === (adjVariantId || variants[0]?.id))?.qtyOnHand ?? onHandQty)} → <span className="font-semibold" style={{ color: '#875A7B' }}>{(variants.find(v => v.id === (adjVariantId || variants[0]?.id))?.qtyOnHand ?? onHandQty) + (adjDir === 'in' ? 1 : -1) * Number(adjQty)}</span>
                  </p>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">{isEn ? 'Reason / Note' : '调整原因 / 备注'}</label>
                <input value={adjNote} onChange={e => setAdjNote(e.target.value)} placeholder={isEn ? 'e.g. count discrepancy, spoilage, opening entry…' : '如：盘点差异、损耗、期初录入…'} className="border border-gray-300 rounded px-3 py-2 text-sm w-full outline-none" />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200">
              <button onClick={() => setShowAdjust(false)} className="px-4 py-2 text-sm rounded border border-gray-300 text-gray-600">{isEn ? 'Cancel' : '取消'}</button>
              <button onClick={submitAdjust} disabled={adjSubmitting} className="px-4 py-2 text-sm rounded text-white font-medium disabled:opacity-50" style={{ background: '#875A7B' }}>{adjSubmitting ? (isEn ? 'Submitting…' : '提交中…') : (isEn ? 'Confirm Adjustment' : '确认调整')}</button>
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

