'use client'
import { useState, useEffect, use, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut, apiPost } from '@/lib/api'
import type {
  OdooPricelist, OdooPricelistItem,
  PricelistApplyOn, PricelistComputeType, PricelistFormulaBase,
  Product, ProductCategory,
} from '@/lib/types'
import { resolvePrice, computeItemPrice } from '@/lib/pricing-engine'
import { NumericInput } from '@/components/ui/numeric-input'
import ActionLogPanel from '@/components/shared/action-log-panel'
import ProductSearchInput from '@/components/classic/ProductSearchInput'
import RowsPerPagePagination from '@/components/shared/rows-per-page-pagination'

const PURPLE = '#875A7B'
const PURPLE_LIGHT = '#f3eff5'
const ITEMS_PAGE_SIZE_DEFAULT = 40

interface Uom {
  id: string
  name: string
  nameZh?: string | null
}

interface SaleUomOption {
  uomId: string
  uomName: string
  isDefault: boolean
  /** 1 个此单位 = factor 个基础单位；换算 Cost 到该单位用，跟单价换算同一套系数 */
  factor: number
}

interface PriceReferenceEntry {
  date: string
  orderId: string
  orderNumber: string
  customerName: string | null
  quantity: number
  unitPrice: number
  uom: string | null
}

interface PriceReference {
  lastPrices: PriceReferenceEntry[]
  avgLastPrice: number | null
  customerCount: number
  lastPurchase: { unitCost: number; date: string; sourceRef: string | null } | null
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function emptyItem(): OdooPricelistItem {
  return {
    id: crypto.randomUUID(),
    applyOn: 'global',
    minQty: 0,
    computeType: 'formula',
    formulaBase: 'list_price',
    priceDiscount: 0,
    priceSurcharge: 0,
    roundingMethod: 0,
    sequence: 10,
  }
}

/**
 * 20260825 合表重构：ProductTemplate 已删，'product'/'variant' 两级 applyOn 在匹配逻辑上
 * 已完全等价（都锁定 product.id，见 lib/pricing-engine.ts）。选品 UI 合并成一个入口后
 * 新建规则只写 'variant'；'product' 只作为历史数据的只读兼容分支保留，这里统一按
 * "这条规则锁定的是哪个商品" 解出一个 id，两种 applyOn 都能查到同一张 Product 表。
 */
function scopedProductId(item: OdooPricelistItem): string | undefined {
  if (item.applyOn === 'variant') return item.productVariantId
  if (item.applyOn === 'product') return item.productTemplateId
  return undefined
}

function applyScopeTitle(
  item: OdooPricelistItem,
  products: Product[],
  categories: ProductCategory[],
  isEn: boolean,
): string {
  if (item.applyOn === 'global') return 'All Products'
  if (item.applyOn === 'product' || item.applyOn === 'variant') {
    const p = products.find(p => p.id === scopedProductId(item))
    return p ? p.name : 'Product'
  }
  if (item.applyOn === 'category') {
    const c = categories.find(c => c.id === item.categoryId)
    return c ? (isEn ? (c.name || c.nameZh || '') : (c.nameZh || c.name)) : 'Product Category'
  }
  return 'All Products'
}

/** 单位限定规则（决策#4：只对 product/variant 有意义）的单位名，供表格/弹窗醒目标出用 */
function uomScopeLabel(item: OdooPricelistItem, uoms: Uom[], isEn: boolean): string | null {
  if (!item.uomId) return null
  const u = uoms.find(u => u.id === item.uomId)
  if (!u) return null
  return isEn ? u.name : (u.nameZh ?? u.name)
}

function applyOnLabel(item: OdooPricelistItem, products: Product[], categories: ProductCategory[], isEn: boolean): string {
  if (item.applyOn === 'global') return 'All Products'
  if (item.applyOn === 'product' || item.applyOn === 'variant') {
    return products.find(p => p.id === scopedProductId(item))?.name ?? '-'
  }
  if (item.applyOn === 'category') {
    const c = categories.find(c => c.id === item.categoryId)
    return c ? (isEn ? (c.name || c.nameZh || '') : (c.nameZh || c.name)) : '-'
  }
  return '-'
}

/**
 * Product Category 列——规则本身锁定的是"分类"（applyOn=category）时显示那个分类；
 * 锁定的是具体商品（product/variant）时，Odoo 显示的是**那个商品自己所属的分类**，
 * 不是规则的 categoryId（这类规则压根没有 categoryId）。
 * ⛔ 我们的分类是平的，没有父子层级，做不出截图里 "All / Stockable / Vegetable" 那种
 * 面包屑，只能显示叶子分类名。
 */
function productCategoryLabel(
  item: OdooPricelistItem,
  scopedProduct: Product | undefined,
  categories: ProductCategory[],
  isEn: boolean,
): string {
  if (item.applyOn === 'category') {
    const c = categories.find(c => c.id === item.categoryId)
    return c ? (isEn ? (c.name || c.nameZh || '') : (c.nameZh || c.name)) : ''
  }
  if (!scopedProduct?.categoryId) return ''
  const c = categories.find(c => c.id === scopedProduct.categoryId)
  return c ? (isEn ? (c.name || c.nameZh || '') : (c.nameZh || c.name)) : ''
}

// ─── main page ────────────────────────────────────────────────────────────────

export default function ClassicPricelistDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const searchParams = useSearchParams()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale

  const [pl, setPl] = useState<OdooPricelist | null>(null)
  const [originalPl, setOriginalPl] = useState<OdooPricelist | null>(null)
  const [allLists, setAllLists] = useState<OdooPricelist[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [uoms, setUoms] = useState<Uom[]>([])

  const [editMode, setEditMode] = useState(searchParams.get('new') === '1')
  const [itemPage, setItemPage] = useState(1)
  const [itemPageSize, setItemPageSize] = useState(ITEMS_PAGE_SIZE_DEFAULT)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<OdooPricelistItem | null>(null)
  const [isNewItem, setIsNewItem] = useState(false)

  // Print/Action dropdown
  const [printOpen, setPrintOpen] = useState(false)
  const [actionOpen, setActionOpen] = useState(false)
  const printRef = useRef<HTMLDivElement>(null)
  const actionRef = useRef<HTMLDivElement>(null)

  // Country groups inline edit state
  const [cgInput, setCgInput] = useState('')
  const [cgEditing, setCgEditing] = useState<number | null>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (printRef.current && !printRef.current.contains(e.target as Node)) setPrintOpen(false)
      if (actionRef.current && !actionRef.current.contains(e.target as Node)) setActionOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    async function loadAll() {
      try {
        // Handle "new" — create a blank pricelist and redirect to its real ID
        if (id === 'new') {
          const created = await apiPost<OdooPricelist>('/api/pricelists', {
            name: '', currency: 'EUR', items: [], sequence: 99,
            selectable: true, active: true, updatedAt: new Date().toISOString(),
          })
          router.replace(`${prefix}/classic/operator/pricelists/${created.id}?new=1`)
          return
        }

        const [found, allProducts, allCategories, allPricelists, allUoms] = await Promise.all([
          apiGet<OdooPricelist>(`/api/pricelists/${id}`),
          apiGet<Product[]>('/api/products'),
          apiGet<ProductCategory[]>('/api/product-categories'),
          apiGet<OdooPricelist[]>('/api/pricelists'),
          apiGet<Uom[]>('/api/uoms').catch(() => [] as Uom[]),
        ])
        if (!found) {
          toast.error(isEn ? 'Pricelist not found' : '价格表不存在')
          router.push(`${prefix}/classic/operator/pricelists`)
          return
        }
        const loaded = {
          ...found,
          countryGroups: Array.isArray(found.countryGroups) ? found.countryGroups : [],
        }
        setPl(loaded)
        setOriginalPl(loaded)
        setProducts(allProducts.filter(p => p.status?.toLowerCase() === 'active' && p.active !== false))
        setCategories(allCategories)
        setUoms(allUoms)
        setAllLists([...allPricelists].sort((a, b) => a.sequence - b.sequence))
      } catch {
        toast.error(isEn ? 'Pricelist not found' : '价格表不存在')
        router.push(`${prefix}/classic/operator/pricelists`)
      }
    }
    loadAll()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  function update<K extends keyof OdooPricelist>(key: K, val: OdooPricelist[K]) {
    setPl(p => p ? { ...p, [key]: val } : p)
  }

  async function handleSave() {
    if (!pl) return
    try {
      const payload = { ...pl, updatedAt: new Date().toISOString() }
      const saved = await apiPut<OdooPricelist>(`/api/pricelists/${pl.id}`, payload)
      const updated = saved ?? pl
      setPl({ ...updated })
      setOriginalPl({ ...updated })
      setEditMode(false)
      toast.success(isEn ? 'Saved' : '已保存')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Save failed' : '保存失败'))
    }
  }

  async function handleDiscard() {
    try {
      const found = await apiGet<OdooPricelist>(`/api/pricelists/${id}`)
      if (found) {
        const loaded = { ...found, countryGroups: Array.isArray(found.countryGroups) ? found.countryGroups : [] }
        setPl(loaded)
        setOriginalPl(loaded)
      }
    } catch {
      if (originalPl) setPl({ ...originalPl })
    }
    setEditMode(false)
  }

  function openNewItem() {
    setEditingItem(emptyItem())
    setIsNewItem(true)
    setDialogOpen(true)
  }

  function openEditItem(item: OdooPricelistItem) {
    setEditingItem({ ...item })
    setIsNewItem(false)
    setDialogOpen(true)
  }

  async function saveItem(item: OdooPricelistItem): Promise<boolean> {
    if (!pl) return false
    if (item.applyOn === 'product' && !item.productTemplateId) {
      toast.error(isEn ? 'Please select a product first' : '请先选择一个产品')
      return false
    }
    if (item.applyOn === 'variant' && !item.productVariantId) {
      toast.error(isEn ? 'Please select a product variant first' : '请先选择一个产品变体')
      return false
    }
    if (item.applyOn === 'category' && !item.categoryId) {
      toast.error(isEn ? 'Please select a product category first' : '请先选择一个产品分类')
      return false
    }
    const updatedItems = isNewItem
      ? [...pl.items, item]
      : pl.items.map(i => i.id === item.id ? item : i)
    const updated = { ...pl, items: updatedItems, updatedAt: new Date().toISOString() }
    try {
      await apiPut(`/api/pricelists/${pl.id}`, updated)
      setPl(updated)
      setOriginalPl(updated)
      toast.success(isNewItem ? (isEn ? 'Item added' : '条目已添加') : (isEn ? 'Item updated' : '条目已更新'))
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Save failed' : '保存失败'))
      return false
    }
  }

  async function saveAndNew(item: OdooPricelistItem) {
    const ok = await saveItem(item)
    if (ok) {
      setEditingItem(emptyItem())
      setIsNewItem(true)
    }
  }

  async function handleDeleteItem(itemId: string) {
    if (!pl) return
    if (!confirm(isEn ? 'Delete this item?' : '确认删除此条目？')) return
    const updated = { ...pl, items: pl.items.filter(i => i.id !== itemId), updatedAt: new Date().toISOString() }
    try {
      await apiPut(`/api/pricelists/${pl.id}`, updated)
      setPl(updated)
      setOriginalPl(updated)
      toast.success(isEn ? 'Deleted' : '已删除')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Delete failed' : '删除失败'))
    }
  }

  /**
   * 条目没有独立的排序表，`sequence` 就是唯一的顺序依据；新建条目一律给固定的
   * `sequence: 10`（见 emptyItem），多条目挤在同一个值上时上/下移单纯交换两条的
   * sequence 不足以稳定改变显示顺序。所以每次移动都按"当前显示顺序"整体重新
   * 编号（10/20/30…），跟 Odoo 里拖拽排序后重新分配 sequence 是同一个思路。
   */
  async function moveItem(itemId: string, direction: 'up' | 'down') {
    if (!pl) return
    const ordered = [...pl.items].sort((a, b) => a.sequence - b.sequence)
    const idx = ordered.findIndex(i => i.id === itemId)
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (idx === -1 || targetIdx < 0 || targetIdx >= ordered.length) return
    ;[ordered[idx], ordered[targetIdx]] = [ordered[targetIdx], ordered[idx]]
    const renumbered = ordered.map((it, i) => ({ ...it, sequence: (i + 1) * 10 }))
    const updated = { ...pl, items: renumbered, updatedAt: new Date().toISOString() }
    try {
      await apiPut(`/api/pricelists/${pl.id}`, updated)
      setPl(updated)
      setOriginalPl(updated)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Reorder failed' : '排序失败'))
    }
  }

  function addCountryGroup() {
    const name = cgInput.trim()
    if (!name) return
    update('countryGroups', [...(pl?.countryGroups ?? []), name])
    setCgInput('')
  }

  function removeCountryGroup(idx: number) {
    update('countryGroups', (pl?.countryGroups ?? []).filter((_, i) => i !== idx))
  }

  function updateCountryGroup(idx: number, val: string) {
    update('countryGroups', (pl?.countryGroups ?? []).map((g, i) => i === idx ? val : g))
  }

  if (!pl) {
    return <div className="py-12 text-center text-gray-400 text-sm">{isEn ? 'Loading...' : '加载中...'}</div>
  }

  const sortedLists = allLists
  const currentIdx = sortedLists.findIndex(l => l.id === id)
  const totalLists = sortedLists.length
  const currentPos = currentIdx >= 0 ? currentIdx + 1 : 1

  const sortedItems = [...pl.items].sort((a, b) => a.sequence - b.sequence)
  const totalItems = sortedItems.length
  const pagedItems = sortedItems.slice((itemPage - 1) * itemPageSize, itemPage * itemPageSize)

  const countryGroups: string[] = Array.isArray(pl.countryGroups) ? pl.countryGroups as string[] : []

  const navigateTo = (pos: number) => {
    const target = sortedLists[pos - 1]
    if (target) router.push(`${prefix}/classic/operator/pricelists/${target.id}`)
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f0eeee' }}>
      {/* ── Top action bar ── */}
      <div className="bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-2">
        {editMode ? (
          <>
            <button
              onClick={handleSave}
              className="h-8 px-4 text-sm font-medium text-white rounded"
              style={{ background: PURPLE }}
            >
              Save
            </button>
            <button
              onClick={handleDiscard}
              className="h-8 px-4 text-sm rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
            >
              Discard
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setEditMode(true)}
              className="h-8 px-4 text-sm font-medium text-white rounded"
              style={{ background: PURPLE }}
            >
              Edit
            </button>
            <button
              onClick={() => router.push(`${prefix}/classic/operator/pricelists/new`)}
              className="h-8 px-4 text-sm rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
            >
              Create
            </button>
            {/* Print dropdown */}
            <div className="relative" ref={printRef}>
              <button
                onClick={() => { setPrintOpen(v => !v); setActionOpen(false) }}
                className="h-8 px-3 text-sm rounded border border-gray-300 text-gray-600 hover:bg-gray-50 flex items-center gap-1"
              >
                Print <Chevron />
              </button>
              {printOpen && (
                <div className="absolute left-0 top-full mt-1 w-44 bg-white rounded border border-gray-200 shadow-lg py-1 z-30 text-sm">
                  <button onClick={() => { toast.info(isEn ? 'Print feature coming soon' : '打印功能即将推出'); setPrintOpen(false) }} className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50">
                    {isEn ? 'Print Pricelist' : '打印价格表'}
                  </button>
                </div>
              )}
            </div>
            {/* Action dropdown */}
            <div className="relative" ref={actionRef}>
              <button
                onClick={() => { setActionOpen(v => !v); setPrintOpen(false) }}
                className="h-8 px-3 text-sm rounded border border-gray-300 text-gray-600 hover:bg-gray-50 flex items-center gap-1"
              >
                Action <Chevron />
              </button>
              {actionOpen && (
                <div className="absolute left-0 top-full mt-1 w-44 bg-white rounded border border-gray-200 shadow-lg py-1 z-30 text-sm">
                  <button onClick={() => { toast.info(isEn ? 'Export feature coming soon' : '导出功能即将推出'); setActionOpen(false) }} className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50">
                    Export
                  </button>
                  <button onClick={() => { if (confirm(isEn ? `Archive pricelist "${pl.name}"?` : `确认归档价格表「${pl.name}」？`)) { update('active', false); handleSave() } setActionOpen(false) }} className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50">
                    Archive
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        <div className="flex-1" />

        {/* Breadcrumb */}
        <div className="flex items-center gap-1 text-sm mr-2">
          <button
            onClick={() => router.push(`${prefix}/classic/operator/pricelists`)}
            className="font-medium hover:underline"
            style={{ color: PURPLE }}
          >
            Pricelists
          </button>
          <span className="text-gray-400">/</span>
          <span className="text-gray-600 text-xs">{pl.name || 'New'}</span>
        </div>

        {/* 1 / N navigation */}
        {totalLists > 0 && (
          <div className="flex items-center gap-1 text-xs text-gray-500 border-l border-gray-200 pl-3">
            <span>{currentPos} / {totalLists}</span>
            <button
              onClick={() => navigateTo(currentPos - 1)}
              disabled={currentPos <= 1}
              className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 disabled:opacity-40 hover:bg-gray-50"
            >‹</button>
            <button
              onClick={() => navigateTo(currentPos + 1)}
              disabled={currentPos >= totalLists}
              className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 disabled:opacity-40 hover:bg-gray-50"
            >›</button>
          </div>
        )}
      </div>

      {/* ── Main card (centered on gray bg) ── */}
      <div className="p-6 max-w-4xl mx-auto">
        <div className="bg-white border border-gray-200 rounded-sm shadow-sm">

          {/* Name + Active toggle */}
          <div className="flex items-start justify-between px-5 pt-5 pb-3">
            <div className="flex-1 mr-4">
              {editMode ? (
                <input
                  type="text"
                  value={pl.name}
                  onChange={e => update('name', e.target.value)}
                  placeholder="e.g. USD Retailers"
                  className="w-full max-w-sm text-base font-normal text-gray-800 rounded px-3 py-1.5 outline-none focus:border-[#875A7B] placeholder-gray-400"
                  style={{ background: '#e8e5f3', border: '1px solid transparent' }}
                />
              ) : (
                <h2 className="text-lg font-semibold text-gray-800">{pl.name || <span className="text-gray-400 italic">{isEn ? '(Unnamed)' : '（未命名）'}</span>}</h2>
              )}
            </div>
            {editMode ? (
              <button
                onClick={() => update('active', !pl.active)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border text-sm font-medium"
                style={pl.active
                  ? { borderColor: '#00a09d', color: '#00a09d', background: '#f0fafa' }
                  : { borderColor: '#adb5bd', color: '#6c757d', background: '#f8f9fa' }}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <rect x="2" y="3" width="20" height="14" rx="2" strokeWidth={1.5} />
                  <path d="M8 21h8M12 17v4" strokeWidth={1.5} strokeLinecap="round" />
                </svg>
                {pl.active ? 'Active' : 'Archived'}
              </button>
            ) : (
              <span
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border text-sm font-medium"
                style={pl.active
                  ? { borderColor: '#00a09d', color: '#00a09d', background: '#f0fafa' }
                  : { borderColor: '#adb5bd', color: '#6c757d', background: '#f8f9fa' }}
              >
                {pl.active ? 'Active' : 'Archived'}
              </span>
            )}
          </div>

          {/* Form fields */}
          <div className="px-5 pb-4" style={{ borderBottom: '1px solid #e9e9e9' }}>
            <OdooField label={<>E-commerce<br />Promotional Code</>}>
              {editMode ? (
                <input
                  type="text"
                  value={pl.promotionalCode ?? ''}
                  onChange={e => update('promotionalCode', e.target.value || undefined)}
                  className="odoo-input"
                />
              ) : (
                <ReadValue>{pl.promotionalCode || <span className="text-gray-300">—</span>}</ReadValue>
              )}
            </OdooField>

            <OdooField label="Currency">
              {editMode ? (
                <div className="flex items-center gap-1 flex-1">
                  <input
                    type="text"
                    value={pl.currency}
                    onChange={e => update('currency', e.target.value)}
                    className="odoo-input flex-1"
                    style={{ background: '#e8e5f3' }}
                  />
                  <ExternalLinkIcon />
                </div>
              ) : (
                <ReadValue>
                  <span style={{ color: PURPLE }} className="font-medium">{pl.currency}</span>
                  <ExternalLinkIcon />
                </ReadValue>
              )}
            </OdooField>

            <OdooField label="Selectable">
              {editMode ? (
                <input
                  type="checkbox"
                  checked={pl.selectable}
                  onChange={e => update('selectable', e.target.checked)}
                  className="w-4 h-4 mt-0.5 cursor-pointer"
                  style={{ accentColor: PURPLE }}
                />
              ) : (
                <ReadValue>
                  {pl.selectable
                    ? <span className="inline-flex w-4 h-4 items-center justify-center rounded-sm text-white text-xs" style={{ background: PURPLE }}>✓</span>
                    : <span className="inline-block w-4 h-4 border border-gray-300 rounded-sm" />
                  }
                </ReadValue>
              )}
            </OdooField>

            <OdooField label="Website">
              {editMode ? (
                <div className="flex items-center gap-1 flex-1">
                  <input
                    type="text"
                    value={pl.website ?? ''}
                    onChange={e => update('website', e.target.value || undefined)}
                    placeholder="—"
                    className="odoo-input flex-1"
                  />
                  <ExternalLinkIcon />
                </div>
              ) : (
                <ReadValue>
                  {pl.website
                    ? <><span style={{ color: PURPLE }}>{pl.website}</span><ExternalLinkIcon /></>
                    : <span className="text-gray-300">—</span>
                  }
                </ReadValue>
              )}
            </OdooField>

            {/* Country Groups inline table */}
            <OdooField label="Country Groups" alignTop>
              <div className="flex-1 border border-gray-200 rounded-sm overflow-hidden" style={{ minWidth: 0 }}>
                <div className="px-3 py-1.5 text-xs font-semibold text-gray-600" style={{ background: '#f5f5f5', borderBottom: '1px solid #e5e5e5' }}>
                  Name
                </div>
                {countryGroups.map((g, idx) => (
                  <div key={idx} className="flex items-center group" style={{ borderBottom: '1px solid #f0f0f0' }}>
                    {editMode && cgEditing === idx ? (
                      <input
                        autoFocus
                        type="text"
                        value={g}
                        onChange={e => updateCountryGroup(idx, e.target.value)}
                        onBlur={() => setCgEditing(null)}
                        onKeyDown={e => e.key === 'Enter' && setCgEditing(null)}
                        className="flex-1 px-3 py-1.5 text-sm outline-none border-0"
                      />
                    ) : (
                      <span
                        className="flex-1 px-3 py-1.5 text-sm text-gray-700"
                        style={{ cursor: editMode ? 'text' : 'default' }}
                        onClick={() => editMode && setCgEditing(idx)}
                      >
                        {g}
                      </span>
                    )}
                    {editMode && (
                      <button
                        onClick={() => removeCountryGroup(idx)}
                        className="px-2 py-1 text-gray-300 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {editMode && (
                  <div className="flex items-center px-3 py-1.5 gap-2">
                    <input
                      type="text"
                      value={cgInput}
                      onChange={e => setCgInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && addCountryGroup()}
                      className="flex-1 text-sm outline-none border-0 bg-transparent"
                    />
                    <button
                      onClick={addCountryGroup}
                      className="text-xs hover:underline"
                      style={{ color: PURPLE }}
                    >
                      Add a line
                    </button>
                  </div>
                )}
                {countryGroups.length === 0 && (
                  <>
                    <div style={{ height: 32, borderBottom: '1px solid #f5f5f5' }} />
                    <div style={{ height: 32, borderBottom: '1px solid #f5f5f5' }} />
                    <div style={{ height: 32 }} />
                  </>
                )}
              </div>
            </OdooField>
          </div>

          {/* ── Pricelist Items ── */}
          <div>
            <div className="flex items-center justify-between px-5 py-2">
              <span className="text-base font-semibold" style={{ color: PURPLE }}>
                Pricelist Items
              </span>
              {totalItems > 0 && (
                <RowsPerPagePagination
                  total={totalItems}
                  page={itemPage}
                  pageSize={itemPageSize}
                  onPageChange={setItemPage}
                  onPageSizeChange={ps => { setItemPageSize(ps); setItemPage(1) }}
                />
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs" style={{ borderTop: '1px solid #e9e9e9' }}>
                <thead style={{ background: '#f5f5f5', borderBottom: '1px solid #ddd' }}>
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-gray-600">Applicable On</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Min. Quantity</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Start Date</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">End Date</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Product Category</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 min-w-[160px]">Price</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Price Discount</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Variant Cost</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Template Cost</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Public Cost Price</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Sale Price</th>
                    {editMode && <th className="w-20 px-3 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {pagedItems.length === 0 && (
                    <tr>
                      <td colSpan={editMode ? 12 : 11} className="px-4 py-3 text-gray-400 italic text-xs">{isEn ? 'No items yet' : '暂无条目'}</td>
                    </tr>
                  )}
                  {pagedItems.map(item => {
                    const globalIdx = sortedItems.findIndex(i => i.id === item.id)
                    const scopedProduct = products.find(p => p.id === scopedProductId(item))
                    // 20260828 客户拍板：合表重构后 template/variant 已经是同一份数据，
                    // Variant Cost / Template Cost / Public Cost Price 三列都取同一个
                    // Product.standardPrice——数字会重复，是为了跟客户参照的 Odoo 截图列名对齐，
                    // 不是算错了。锁定分类(applyOn=category)时没有具体商品，三列都留空。
                    const cost = scopedProduct?.standardPrice
                    const publicPrice = scopedProduct?.listPrice
                    // formula 模式的条目此前只显示"X% discount and Y surcharge"公式文字，
                    // 看不出实际卖多少钱——这里用跟真实下单同一份 computeItemPrice 算出来，
                    // 拿不到商品(比如已归档/删除)时就不算，交给下面公式文字兜底。
                    const estimatedPrice = scopedProduct
                      ? computeItemPrice(item, scopedProduct, publicPrice ?? 0, allLists, item.minQty || 1, undefined, 0, item.uomId) ?? undefined
                      : undefined
                    return (
                      <ItemRow
                        key={item.id}
                        item={item}
                        products={products}
                        categories={categories}
                        uoms={uoms}
                        cost={cost}
                        publicPrice={publicPrice}
                        estimatedPrice={estimatedPrice}
                        productCategoryLabel={productCategoryLabel(item, scopedProduct, categories, isEn)}
                        showDelete={editMode}
                        onEdit={() => openEditItem(item)}
                        onDelete={() => handleDeleteItem(item.id)}
                        canMoveUp={globalIdx > 0}
                        canMoveDown={globalIdx < totalItems - 1}
                        onMoveUp={() => moveItem(item.id, 'up')}
                        onMoveDown={() => moveItem(item.id, 'down')}
                        isEn={isEn}
                      />
                    )
                  })}
                </tbody>
              </table>
            </div>
            {editMode && (
              <div className="px-4 py-2">
                <button
                  onClick={openNewItem}
                  className="text-xs hover:underline"
                  style={{ color: PURPLE }}
                >
                  Add a line
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="mt-4">
          <ActionLogPanel resource="pricelist" resourceId={id} />
        </div>
      </div>

      {/* ── Item dialog ── */}
      {dialogOpen && editingItem && (
        <ItemDialog
          key={editingItem.id}
          item={editingItem}
          onChange={setEditingItem}
          onSaveClose={async item => { const ok = await saveItem(item); if (ok) setDialogOpen(false) }}
          onSaveNew={item => { saveAndNew(item) }}
          onDiscard={() => setDialogOpen(false)}
          onRemove={isNewItem ? undefined : () => { handleDeleteItem(editingItem.id); setDialogOpen(false) }}
          pricelistId={id}
          products={products}
          categories={categories}
          uoms={uoms}
          allLists={allLists.filter(l => l.id !== pl.id)}
          isNew={isNewItem}
          scopeTitle={applyScopeTitle(editingItem, products, categories, isEn)}
          isEn={isEn}
        />
      )}

      <style>{`
        .odoo-input {
          border: 1px solid #e5e5e5;
          border-radius: 2px;
          padding: 4px 8px;
          font-size: 13px;
          color: #333;
          outline: none;
          width: 100%;
        }
        .odoo-input:focus {
          border-color: ${PURPLE};
        }
      `}</style>
    </div>
  )
}

// ─── Chevron icon ─────────────────────────────────────────────────────────────

function Chevron() {
  return (
    <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
      <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// ─── OdooField helper ─────────────────────────────────────────────────────────

function OdooField({ label, children, alignTop = false }: {
  label: React.ReactNode
  children: React.ReactNode
  alignTop?: boolean
}) {
  return (
    <div className={`flex ${alignTop ? 'items-start' : 'items-center'} gap-0 mb-0`} style={{ padding: '3px 0' }}>
      <div
        className="flex-shrink-0 text-right pr-4 text-gray-700 font-medium text-xs leading-snug"
        style={{ width: 200, paddingTop: alignTop ? 6 : undefined }}
      >
        {label}
      </div>
      <div className="flex items-center gap-1" style={{ flex: 1 }}>
        {children}
      </div>
    </div>
  )
}

// ─── ReadValue — plain text display in read mode ──────────────────────────────

function ReadValue({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 text-sm text-gray-800 px-2 py-1">
      {children}
    </div>
  )
}

// ─── External link icon ───────────────────────────────────────────────────────

function ExternalLinkIcon() {
  return (
    <span className="text-gray-400 hover:text-gray-600 cursor-pointer flex-shrink-0" title="Open">
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>
    </span>
  )
}

// ─── ItemRow ──────────────────────────────────────────────────────────────────

function ItemRow({ item, products, categories, uoms, cost, publicPrice, estimatedPrice, productCategoryLabel, showDelete, onEdit, onDelete, canMoveUp, canMoveDown, onMoveUp, onMoveDown, isEn }: {
  item: OdooPricelistItem
  products: Product[]
  categories: ProductCategory[]
  uoms: Uom[]
  cost: number | undefined
  publicPrice: number | undefined
  estimatedPrice: number | undefined
  productCategoryLabel: string
  showDelete: boolean
  onEdit: () => void
  onDelete: () => void
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  isEn: boolean
}) {
  const [hover, setHover] = useState(false)
  const scopedUom = uomScopeLabel(item, uoms, isEn)

  // ⛔ 20260903 客户反馈：percentage/formula 模式下 Price 列只放公式文字（"5% 折扣"），
  // 实际卖多少钱藏在很靠右的 Preview Price 列——手机上要横向滚很远才看得到，
  // 等于"没显示"。现在两列合一：能算出具体金额（scopedProduct 存在）就把金额放前面、
  // 公式文字降级成下面一行小字说明；算不出来（分类/全场规则，没有单一商品可套算）
  // 才继续显示公式文字兜底，因为这类规则本来就没有"唯一一个真实价格"可给。
  const priceText = item.computeType === 'fixed'
    ? `€${(item.fixedPrice ?? 0).toFixed(2)}`
    : item.computeType === 'percentage'
      ? `${(item.percentDiscount ?? 0).toFixed(1)} % discount`
      : `${(item.priceDiscount ?? 0).toFixed(1)} % discount and ${(item.priceSurcharge ?? 0).toFixed(1)} surcharge`

  // Price Discount：formula 模式下就是 item.priceDiscount 本身（不是"整条公式文字"）；
  // percentage 模式下是 item.percentDiscount；fixed 模式没有折扣概念，留空。
  const priceDiscountValue = item.computeType === 'formula'
    ? item.priceDiscount ?? 0
    : item.computeType === 'percentage'
      ? item.percentDiscount ?? 0
      : null

  return (
    <tr
      style={{ background: hover ? PURPLE_LIGHT : undefined, cursor: 'pointer', borderBottom: '1px solid #f0f0f0' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onEdit}
    >
      <td className="px-4 py-1.5 text-gray-800">
        {applyOnLabel(item, products, categories, isEn)}
        {scopedUom && (
          <span
            className="ml-1.5 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium"
            style={{ background: PURPLE_LIGHT, color: PURPLE }}
            title={isEn ? `Only applies to unit: ${scopedUom}` : `仅对可售单位「${scopedUom}」生效`}
          >
            {scopedUom}
          </span>
        )}
      </td>
      <td className="px-3 py-1.5 text-right text-gray-600">{item.minQty}</td>
      <td className="px-3 py-1.5 text-gray-500">{item.dateStart ?? ''}</td>
      <td className="px-3 py-1.5 text-gray-500">{item.dateEnd ?? ''}</td>
      <td className="px-3 py-1.5 text-gray-500">{productCategoryLabel}</td>
      <td className="px-3 py-1.5 text-gray-800">
        {item.computeType !== 'fixed' && estimatedPrice != null ? (
          <>
            <div className="font-medium text-gray-900">€{estimatedPrice.toFixed(2)}</div>
            <div className="text-[10px] text-gray-400">{priceText}</div>
          </>
        ) : priceText}
      </td>
      <td className="px-3 py-1.5 text-right text-gray-500">
        {priceDiscountValue != null ? priceDiscountValue.toFixed(2) : ''}
      </td>
      <td className="px-3 py-1.5 text-right text-gray-500">
        {cost != null ? cost.toFixed(2) : ''}
      </td>
      <td className="px-3 py-1.5 text-right text-gray-500">
        {cost != null ? cost.toFixed(2) : ''}
      </td>
      <td className="px-3 py-1.5 text-right text-gray-500">
        {cost != null ? cost.toFixed(2) : ''}
      </td>
      <td className="px-3 py-1.5 text-right text-gray-500">
        {publicPrice != null ? publicPrice.toFixed(2) : ''}
      </td>
      {showDelete && (
        <td className="px-3 py-1.5" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-center gap-1.5">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={!canMoveUp}
              title={isEn ? 'Move up' : '上移'}
              className="text-gray-300 hover:text-gray-600 disabled:opacity-30 disabled:hover:text-gray-300 text-xs leading-none cursor-pointer disabled:cursor-default"
            >▲</button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={!canMoveDown}
              title={isEn ? 'Move down' : '下移'}
              className="text-gray-300 hover:text-gray-600 disabled:opacity-30 disabled:hover:text-gray-300 text-xs leading-none cursor-pointer disabled:cursor-default"
            >▼</button>
            <span
              onClick={onDelete}
              title={isEn ? 'Delete' : '删除'}
              className="text-gray-300 hover:text-red-400 text-base leading-none cursor-pointer select-none"
            >🗑</span>
          </div>
        </td>
      )}
    </tr>
  )
}

// ─── ItemDialog ───────────────────────────────────────────────────────────────

function ItemDialog({
  item, onChange, onSaveClose, onSaveNew, onDiscard, onRemove,
  pricelistId, products, categories, uoms, allLists, isNew, scopeTitle, isEn,
}: {
  item: OdooPricelistItem
  onChange: (item: OdooPricelistItem) => void
  onSaveClose: (item: OdooPricelistItem) => void
  onSaveNew: (item: OdooPricelistItem) => void
  onDiscard: () => void
  onRemove?: () => void
  pricelistId: string
  products: Product[]
  categories: ProductCategory[]
  uoms: Uom[]
  allLists: OdooPricelist[]
  isNew: boolean
  scopeTitle: string
  isEn: boolean
}) {
  function set<K extends keyof OdooPricelistItem>(key: K, val: OdooPricelistItem[K]) {
    onChange({ ...item, [key]: val })
  }

  // 20260823（决策#4）：uomId 只对 applyOn ∈ {product, variant} 有意义。切到 global/category，
  // 或换了另一个商品，旧选的单位十有八九对不上新商品的可售单位配置了，直接清掉，
  // 不要让用户带着一个已经不适用的隐藏值去保存。
  function setApplyOn(next: PricelistApplyOn) {
    onChange({ ...item, applyOn: next, uomId: (next === 'product' || next === 'variant') ? item.uomId : undefined })
  }
  // 20260825 合表重构：选品只有一个入口了，新建/改选一律写 applyOn:'variant'（历史 'product'
  // 数据只读兼容，见 scopedProductId；一旦在这个弹窗里改过选品，就顺势升级成 'variant'）。
  function setScopedProductId(next: string | undefined) {
    onChange({ ...item, applyOn: 'variant', productVariantId: next, productTemplateId: undefined, uomId: undefined })
  }

  const saleUomProductId = scopedProductId(item)

  const [saleUomOptions, setSaleUomOptions] = useState<SaleUomOption[]>([])
  useEffect(() => {
    if (!saleUomProductId) { setSaleUomOptions([]); return }
    let cancelled = false
    apiGet<Array<{ uomId: string; isDefault: boolean; active: boolean; factor: number; uom: { name: string; nameZh?: string | null } }>>(
      `/api/products/${saleUomProductId}/sale-uoms`,
    )
      .then(rows => {
        if (cancelled) return
        setSaleUomOptions(
          rows.filter(r => r.active).map(r => ({
            uomId: r.uomId, isDefault: r.isDefault, factor: Number(r.factor) || 1,
            uomName: isEn ? r.uom.name : (r.uom.nameZh ?? r.uom.name),
          })),
        )
      })
      .catch(() => { if (!cancelled) setSaleUomOptions([]) })
    return () => { cancelled = true }
  }, [saleUomProductId, isEn])

  // 定价参考数据(20260902)：用这条价格表的客户们最近的真实成交价 + 该商品最近一次采购成本。
  // 只在弹窗打开、选好商品之后拉——不是列表页每行都查，避免价格表条目一多就 N+1。
  const [priceRef, setPriceRef] = useState<PriceReference | null>(null)
  const [priceRefLoading, setPriceRefLoading] = useState(false)
  useEffect(() => {
    if (!saleUomProductId || pricelistId === 'new') { setPriceRef(null); return }
    let cancelled = false
    setPriceRefLoading(true)
    apiGet<PriceReference>(`/api/pricelists/${pricelistId}/reference?productId=${saleUomProductId}`)
      .then(r => { if (!cancelled) setPriceRef(r) })
      .catch(() => { if (!cancelled) setPriceRef(null) })
      .finally(() => { if (!cancelled) setPriceRefLoading(false) })
    return () => { cancelled = true }
  }, [saleUomProductId, pricelistId])

  // 优先用刚加载的该商品可售单位列表（更准确、也是同一份数据源），全局 uoms 只是兜底
  // （比如商品还没加载出可售单位列表、但 item.uomId 已经存在于历史数据里的情况）
  const scopedUomLabel = saleUomOptions.find(o => o.uomId === item.uomId)?.uomName ?? uomScopeLabel(item, uoms, isEn)

  // 20260823：这个价改了，商品配置的其他可售单位（AUTO/FORMULA 两种模式）会自动跟着联动——
  // 这已经是事实（priceOf() 每次都拿"当下"的基准价现算，不是存快照），这里只是把它说清楚，
  // 不是新写的计算逻辑。FIXED 模式的可售单位是例外，不受基准价变化影响。
  // ⚠️ 命中单位限定规则（item.uomId 有值）时这句话不成立——这条规则算出的就是那个单位自己的
  // 最终价，不再是"基准价"，risk#3：必须换一句话把选中的单位名字醒目标出来，不能只在小字里带过。
  const saleUomAutoUpdateHint = scopedUomLabel ? (
    <p className="text-xs px-2 py-1.5 rounded mt-1" style={{ background: PURPLE_LIGHT, color: PURPLE }}>
      {isEn
        ? <>This rule computes the final price for unit <strong>{scopedUomLabel}</strong> only — it is NOT the base unit price, and will not be multiplied by that unit&apos;s conversion factor.</>
        : <>这条规则算出的是【<strong>{scopedUomLabel}</strong>】这一个单位自己的最终价 —— 不是基准价，不会再乘该单位的换算系数。</>}
    </p>
  ) : (
    <p className="text-xs text-gray-400 mt-1">
      {isEn
        ? 'This is the base unit price. Other sellable units configured for this product (e.g. CASE, PKT) will automatically follow it — except any unit set to a fixed price, or a unit with its own unit-specific rule below.'
        : '这是基准单位的价格。该商品配置的其他可售单位（如箱/袋）会自动跟着这个价联动 —— 除了单独设了固定价的单位，或者下面为该单位单独设了限定规则的情况。'}
    </p>
  )

  // 选品改成「输入即筛选」：原来是把全部商品塞进 <select>，几千行只能靠肉眼翻。
  // 20260825 合表重构：products 父页面已全量加载（不再分页），本地筛就能覆盖全部商品，
  // 不需要再对第 200 名以后的商品单独发请求。
  const [productQuery, setProductQuery] = useState(
    () => products.find(p => p.id === scopedProductId(item))?.name ?? '',
  )

  const scopedProduct = products.find(p => p.id === scopedProductId(item))
  const templateCostVal = scopedProduct?.standardPrice ?? 0
  const templatePublicPriceVal = scopedProduct?.listPrice ?? 0
  const costLabel = 'Cost'

  // ── 定价参考(20260902)：成本换算到规则限定的单位 + 预估毛利 + 该商品在其他价格表的价 ──
  // 这条规则如果限定了某个可售单位(item.uomId)，成本也要跟着换算，否则毛利率会用
  // "基准单位成本 ÷ 这个单位的价"算出一个没有意义的数字（同类问题在订单侧 20260827 修过）。
  const uomFactor = item.uomId ? (saleUomOptions.find(o => o.uomId === item.uomId)?.factor ?? 1) : 1
  const scopedCostVal = templateCostVal * uomFactor
  const estimatedPrice = scopedProduct
    ? computeItemPrice(item, scopedProduct, templatePublicPriceVal, allLists, item.minQty || 1, undefined, 0, item.uomId) ?? undefined
    : undefined
  const marginAmount = estimatedPrice != null ? estimatedPrice - scopedCostVal : null
  const marginPct = estimatedPrice != null && estimatedPrice > 0 && marginAmount != null
    ? (marginAmount / estimatedPrice) * 100
    : null
  // 同商品在别的价格表里按同样的数量/单位会算出多少钱——防止不同表之间定价倒挂。
  // allLists 这里已经是父页面过滤掉"当前这张表自己"之后传进来的（见调用处），不用再排除一次。
  const otherPricelistPrices = scopedProduct
    ? allLists.map(otherPl => {
        const r = resolvePrice(scopedProduct, otherPl, allLists, item.minQty || 1, undefined, item.uomId)
        return { id: otherPl.id, name: otherPl.name, currency: otherPl.currency, price: r.price, isFallback: r.isFallback }
      })
    : []

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onDiscard} />
      <div className="relative bg-white rounded shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto" style={{ border: '1px solid #ddd' }}>

        <div className="flex items-center justify-between px-6 py-3" style={{ borderBottom: '1px solid #e5e5e5' }}>
          <h2 className="text-sm font-medium text-gray-700">
            {isNew ? 'Create Pricelist Items' : 'Edit Pricelist Items'}
          </h2>
          <button onClick={onDiscard} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
        </div>

        <div className="px-6 py-5">
          <h3 className="text-xl font-semibold text-gray-800 mb-6">{scopeTitle}</h3>

          <div className="grid grid-cols-2 gap-8 mb-6">
            {/* Left: Apply On */}
            <div>
              <div className="text-xs font-medium text-gray-600 mb-2">Apply On</div>
              <div className="space-y-2 mb-4">
                {([
                  ['global', 'Global'],
                  ['category', 'Product Category'],
                  ['variant', 'Product'],
                ] as [PricelistApplyOn, string][]).map(([opt, label]) => (
                  <label key={opt} className="flex items-center gap-2 cursor-pointer text-sm">
                    <OdooRadio
                      checked={item.applyOn === opt || (opt === 'variant' && item.applyOn === 'product')}
                      onChange={() => setApplyOn(opt)}
                    />
                    <span className="text-gray-700">{label}</span>
                  </label>
                ))}
              </div>

              {(item.applyOn === 'product' || item.applyOn === 'variant') && (
                <div className="mb-3">
                  <ProductSearchInput<Product>
                    value={productQuery}
                    onChange={v => {
                      setProductQuery(v)
                      if (!v.trim()) setScopedProductId(undefined)
                    }}
                    onSelect={p => { setProductQuery(p.name); setScopedProductId(p.id) }}
                    products={products}
                    placeholder={isEn ? 'Type to search a product…' : '输入关键词搜索商品…'}
                    inputClassName="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
                    portalDropdown
                    maxResults={30}
                  />
                </div>
              )}
              {item.applyOn === 'category' && (
                <select
                  value={item.categoryId ?? ''}
                  onChange={e => set('categoryId', e.target.value || undefined)}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B] mb-3"
                >
                  <option value="">Select a category…</option>
                  {categories.map(c => (
                    <option key={c.id} value={c.id}>{isEn ? (c.name || c.nameZh) : (c.nameZh || c.name)}</option>
                  ))}
                </select>
              )}

              <div className="flex items-center gap-4 text-sm">
                <span className="text-gray-600">{costLabel}</span>
                <span className="text-gray-800">{scopedCostVal.toFixed(2)}</span>
                {item.uomId && (
                  <span className="text-[11px] text-gray-400">
                    {isEn ? '(scaled to selected unit)' : '（已按选定单位换算）'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4 text-sm mt-1">
                <span className="text-gray-600">Public Price</span>
                <span className="text-gray-800">{templatePublicPriceVal.toFixed(2)}</span>
              </div>

              {(item.applyOn === 'product' || item.applyOn === 'variant') && (
                <div className="mt-4">
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    {isEn ? 'Sellable Unit (optional)' : '限定可售单位（可选）'}
                  </label>
                  <select
                    value={item.uomId ?? ''}
                    onChange={e => set('uomId', e.target.value || undefined)}
                    disabled={!saleUomProductId}
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B] disabled:bg-gray-50 disabled:text-gray-400"
                  >
                    <option value="">{isEn ? '(all units — follows the base unit price)' : '（不限定 — 所有可售单位跟随基准价联动）'}</option>
                    {saleUomOptions.map(o => (
                      <option key={o.uomId} value={o.uomId}>
                        {o.uomName}{o.isDefault ? (isEn ? ' (base unit)' : '（基准单位）') : ''}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-gray-400 mt-1">
                    {isEn
                      ? 'Pick a unit only if this product/variant needs a different price than its base-unit price × conversion factor.'
                      : '只有当这个商品/变体需要"这个单位单独定价"而不是"基准价 × 换算系数"时才需要选。'}
                  </p>
                </div>
              )}
            </div>

            {/* Right: Qty + Dates */}
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Min. Quantity</label>
                <NumericInput
                  min={0}
                  step="any"
                  value={item.minQty ?? 0}
                  onChange={e => set('minQty', e.target.value === '' ? 0 : Math.max(0, Number(e.target.value)))}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Start Date</label>
                <input
                  type="date"
                  value={item.dateStart ?? ''}
                  onChange={e => set('dateStart', e.target.value || undefined)}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">End Date</label>
                <input
                  type="date"
                  value={item.dateEnd ?? ''}
                  onChange={e => set('dateEnd', e.target.value || undefined)}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
                />
              </div>
            </div>
          </div>

          {/* ── Pricing Reference(20260902)：定价时手边就能看到的参考数据，避免瞎猜 ── */}
          {scopedProduct && (
            <div className="mb-6 border border-gray-200 rounded-sm overflow-hidden">
              <div className="px-3 py-1.5 text-xs font-semibold text-gray-600" style={{ background: '#f5f5f5', borderBottom: '1px solid #e5e5e5' }}>
                {isEn ? 'Pricing Reference' : '定价参考'}
              </div>
              <div className="p-3 space-y-3 text-sm">
                {/* 预估毛利：拿这条规则算出来的 Preview Price 减掉(已按单位换算的)成本 */}
                <div className="flex items-center gap-4">
                  <span className="text-gray-600 w-32 flex-shrink-0">{isEn ? 'Est. Margin' : '预估毛利'}</span>
                  {estimatedPrice != null && marginAmount != null && marginPct != null ? (
                    <span className={marginAmount < 0 ? 'text-red-600 font-medium' : 'text-gray-800 font-medium'}>
                      {estimatedPrice.toFixed(2)} − {scopedCostVal.toFixed(2)} = {marginAmount.toFixed(2)}
                      <span className="text-gray-500 font-normal"> （{marginPct.toFixed(1)}%）</span>
                    </span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </div>

                {/* 最近一次采购成本：Lot.unitCost，不是移动平均，专治"均价还没反映最新涨价" */}
                <div className="flex items-center gap-4">
                  <span className="text-gray-600 w-32 flex-shrink-0">{isEn ? 'Last Purchase Cost' : '最近采购成本'}</span>
                  {priceRefLoading ? (
                    <span className="text-gray-300 text-xs">{isEn ? 'Loading…' : '加载中…'}</span>
                  ) : priceRef?.lastPurchase ? (
                    <span className="text-gray-800">
                      {priceRef.lastPurchase.unitCost.toFixed(2)}
                      <span className="text-gray-400 text-xs ml-1">
                        ({new Date(priceRef.lastPurchase.date).toLocaleDateString('en-CA')}
                        {priceRef.lastPurchase.sourceRef ? ` · ${priceRef.lastPurchase.sourceRef}` : ''})
                      </span>
                    </span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </div>

                {/* 历史成交价：只看用这条价格表的客户，不是全平台——见接口注释 */}
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-gray-600">
                      {isEn ? 'Recent Sales' : '最近成交'}
                      {priceRef && priceRef.customerCount > 0 && (
                        <span className="text-gray-400 text-xs ml-1">
                          {isEn
                            ? `(customers on this pricelist, ${priceRef.customerCount})`
                            : `（用这条价格表的 ${priceRef.customerCount} 个客户）`}
                        </span>
                      )}
                    </span>
                    {priceRef?.avgLastPrice != null && (
                      <span className="text-xs text-gray-500">
                        {isEn ? `avg €${priceRef.avgLastPrice.toFixed(2)}` : `均价 €${priceRef.avgLastPrice.toFixed(2)}`}
                      </span>
                    )}
                  </div>
                  {priceRefLoading ? (
                    <p className="text-gray-300 text-xs">{isEn ? 'Loading…' : '加载中…'}</p>
                  ) : !priceRef || priceRef.lastPrices.length === 0 ? (
                    <p className="text-gray-300 text-xs">
                      {priceRef && priceRef.customerCount === 0
                        ? (isEn ? 'No customer uses this pricelist yet' : '还没有客户在用这条价格表')
                        : (isEn ? 'No sales history yet' : '暂无历史成交记录')}
                    </p>
                  ) : (
                    <div className="border border-gray-100 rounded max-h-32 overflow-y-auto">
                      <table className="w-full text-xs">
                        <tbody>
                          {priceRef.lastPrices.map((h, i) => (
                            <tr key={h.orderId + i} className="border-b border-gray-50 last:border-0">
                              <td className="py-1 px-2 text-gray-500 whitespace-nowrap">
                                {new Date(h.date).toLocaleDateString('en-CA')}
                              </td>
                              <td className="py-1 px-2 text-gray-600 truncate max-w-[120px]">{h.customerName ?? '—'}</td>
                              <td className="py-1 px-2 text-right text-gray-500">{h.quantity.toFixed(2)} {h.uom ?? ''}</td>
                              <td className="py-1 px-2 text-right text-gray-800 font-medium">€{h.unitPrice.toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* 同商品在别的价格表里的价，防止不同表之间倒挂 */}
                {otherPricelistPrices.length > 0 && (
                  <div>
                    <span className="text-gray-600 block mb-1">
                      {isEn ? 'This Product on Other Pricelists' : '该商品在其他价格表'}
                    </span>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {otherPricelistPrices.map(p => (
                        <span key={p.id} className="text-xs" title={p.isFallback ? (isEn ? 'No rule for this product — falls back to public price' : '没有对应规则，回退到牌价') : undefined}>
                          <span className="text-gray-500">{p.name}:</span>{' '}
                          <span className={p.isFallback ? 'text-gray-400' : 'text-gray-800 font-medium'}>
                            {p.currency} {p.price.toFixed(2)}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Price Computation */}
          <div style={{ borderTop: '1px solid #e5e5e5', paddingTop: 16 }}>
            <h4 className="text-base font-semibold mb-4" style={{ color: PURPLE }}>
              Price Computation
            </h4>

            <div className="mb-4">
              <div className="text-xs font-medium text-gray-600 mb-2">Compute Price</div>
              <div className="space-y-2">
                {([
                  ['fixed', 'Fix Price'],
                  ['percentage', 'Percentage (discount)'],
                  ['formula', 'Formula'],
                ] as [PricelistComputeType, string][]).map(([opt, label]) => (
                  <label key={opt} className="flex items-center gap-2 cursor-pointer text-sm">
                    <OdooRadio checked={item.computeType === opt} onChange={() => set('computeType', opt)} />
                    <span className="text-gray-700">{label}</span>
                  </label>
                ))}
              </div>
            </div>

            {item.computeType === 'fixed' && (
              <div className="mb-3">
                <NumericInput
                  step="any" min={0} placeholder="0.00"
                  value={item.fixedPrice ?? ''}
                  onChange={e => set('fixedPrice', e.target.value ? Number(e.target.value) : undefined)}
                  className="w-44 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
                />
                <p className="text-xs text-gray-400 mt-2">
                  The computed price is expressed in the default Unit of Measure of the product.
                </p>
                {saleUomAutoUpdateHint}
              </div>
            )}

            {item.computeType === 'percentage' && (
              <div className="mb-3">
                <div className="flex items-center gap-2">
                  <NumericInput
                    step="any" min={0} max={100} placeholder="0.00"
                    value={item.percentDiscount ?? ''}
                    onChange={e => set('percentDiscount', e.target.value ? Number(e.target.value) : 0)}
                    className="w-32 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
                  />
                  <span className="text-sm text-gray-500">%</span>
                  <span className="text-xs text-gray-400 ml-2">
                    {isEn
                      ? `(List Price × ${(1 - (item.percentDiscount ?? 0) / 100).toFixed(4)})`
                      : `(牌价 × ${(1 - (item.percentDiscount ?? 0) / 100).toFixed(4)})`}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  The computed price is expressed in the default Unit of Measure of the product.
                </p>
                {saleUomAutoUpdateHint}
              </div>
            )}

            {item.computeType === 'formula' && (
              <div className="space-y-3">
                <p className="text-xs text-gray-400">
                  The computed price is expressed in the default Unit of Measure of the product.
                </p>
                {saleUomAutoUpdateHint}
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-600 w-28 flex-shrink-0">Based on</span>
                  <select
                    value={item.formulaBase ?? 'list_price'}
                    onChange={e => set('formulaBase', e.target.value as PricelistFormulaBase)}
                    className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
                    style={{ background: '#e8e5f3' }}
                  >
                    <option value="list_price">Public Price</option>
                    <option value="standard_price">Cost</option>
                    <option value="pricelist">Other Pricelist</option>
                  </select>
                </div>
                <div className="flex items-center gap-2 text-sm flex-wrap">
                  <span className="text-gray-600 w-28 flex-shrink-0">New Price =</span>
                  <span className="text-gray-500 text-xs">
                    {item.formulaBase === 'standard_price' ? 'Cost' : item.formulaBase === 'pricelist' ? 'Other Pricelist' : 'Public Price'} -
                  </span>
                  <span className="text-xs text-gray-500">Price Discount</span>
                  <NumericInput
                    step="any" min={0} placeholder="0.00"
                    value={item.priceDiscount ?? ''}
                    onChange={e => set('priceDiscount', e.target.value ? Number(e.target.value) : 0)}
                    className="w-20 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-[#875A7B]"
                  />
                  <span className="text-gray-500">%  +</span>
                  <NumericInput
                    step="any" placeholder="0.00"
                    value={item.priceSurcharge ?? ''}
                    onChange={e => set('priceSurcharge', e.target.value ? Number(e.target.value) : 0)}
                    className="w-20 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-[#875A7B]"
                  />
                </div>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">
                      {isEn ? 'Rounding Method' : '舍入精度'}
                    </label>
                    <NumericInput
                      step="any" min={0} placeholder={isEn ? '0 = none' : '0 = 不舍入'}
                      value={item.roundingMethod ?? ''}
                      onChange={e => set('roundingMethod', e.target.value ? Number(e.target.value) : 0)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
                    />
                    <p className="text-[11px] text-gray-400 mt-1">
                      {isEn ? 'e.g. 0.05 rounds to the nearest 5 cents' : '如填 0.05，价格取整到最近的 5 分'}
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">
                      {isEn ? 'Min. Margin' : '最低利润'}
                    </label>
                    <NumericInput
                      step="any" min={0} placeholder={isEn ? 'blank = no limit' : '留空 = 不设限'}
                      value={item.priceMinMargin ?? ''}
                      onChange={e => set('priceMinMargin', e.target.value ? Number(e.target.value) : undefined)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">
                      {isEn ? 'Max. Margin' : '最高利润'}
                    </label>
                    <NumericInput
                      step="any" min={0} placeholder={isEn ? 'blank = no limit' : '留空 = 不设限'}
                      value={item.priceMaxMargin ?? ''}
                      onChange={e => set('priceMaxMargin', e.target.value ? Number(e.target.value) : undefined)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
                    />
                  </div>
                </div>
                {/*
                  20260808：客户实测「嵌套价格表跳出 COST PRICE」，根因就是这两个字段被填了 0。
                  0 与留空在 Odoo 里是同一个意思（不设限），但填 0 的人往往以为自己设了个约束，
                  所以这里把话说明白，而不是指望他去猜。
                */}
                <p className="text-[11px] text-gray-500 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                  {isEn
                    ? 'Min./Max. Margin: leave blank or enter 0 for no limit. Both are measured against the base price above (not the cost price).'
                    : '最低 / 最高利润：留空或填 0 都表示「不设限」。两者都是相对上面的「基准价」计算，不是相对进价。'}
                </p>
                {item.formulaBase === 'pricelist' && (
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-600 w-28 flex-shrink-0">Other Pricelist</span>
                    <select
                      value={item.basedOnPricelistId ?? ''}
                      onChange={e => set('basedOnPricelistId', e.target.value || undefined)}
                      className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
                    >
                      <option value="">Select a pricelist…</option>
                      {allLists.map(l => (
                        <option key={l.id} value={l.id}>{l.name} ({l.currency})</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 px-6 py-3" style={{ borderTop: '1px solid #e5e5e5', background: '#fafafa' }}>
          <button
            onClick={() => onSaveClose(item)}
            className="px-4 py-1.5 text-white text-sm rounded font-medium hover:opacity-90"
            style={{ background: PURPLE }}
          >
            Save &amp; Close
          </button>
          <button
            onClick={() => onSaveNew(item)}
            className="px-4 py-1.5 text-white text-sm rounded font-medium hover:opacity-90"
            style={{ background: PURPLE }}
          >
            Save &amp; New
          </button>
          <button
            onClick={onDiscard}
            className="px-4 py-1.5 text-gray-600 text-sm border border-gray-300 rounded hover:bg-gray-50"
          >
            Discard
          </button>
          {onRemove && (
            <button
              onClick={onRemove}
              className="ml-auto px-4 py-1.5 text-gray-600 text-sm border border-gray-300 rounded hover:bg-red-50 hover:text-red-600"
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── OdooRadio ────────────────────────────────────────────────────────────────

function OdooRadio({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <span
      onClick={onChange}
      className="w-4 h-4 rounded-full border-2 flex-shrink-0 cursor-pointer flex items-center justify-center"
      style={checked
        ? { borderColor: PURPLE, background: PURPLE }
        : { borderColor: '#d1d5db', background: '#fff' }}
    >
      {checked && <span className="w-1.5 h-1.5 rounded-full bg-white block" />}
    </span>
  )
}
