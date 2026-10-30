'use client'
import { useState, useEffect, use, useRef, type ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut, apiPost, apiPatch } from '@/lib/api'
import type {
  OdooPricelist, OdooPricelistItem,
  PricelistApplyOn, PricelistComputeType, PricelistFormulaBase,
  Product, ProductCategory,
} from '@/lib/types'
import { resolvePrice, computeItemPrice, targetKeyOf } from '@/lib/pricing-engine'
import { priceOf, factorOf, type SaleUomPriceMode } from '@/lib/sale-uom'
import { categoryPathMap } from '@/lib/category-path'
import { NumericInput } from '@/components/ui/numeric-input'
import ActionLogPanel from '@/components/shared/action-log-panel'
import ProductSearchInput from '@/components/classic/ProductSearchInput'
import RowsPerPagePagination from '@/components/shared/rows-per-page-pagination'
import { DatePicker } from '@/components/ui/date-picker'
import BulkImportDialog from '@/components/shared/BulkImportDialog'
import { useCsvExport } from '@/hooks/use-csv-export'
import { PRICELIST_EXPORT_COLUMNS } from '@/lib/export/columns/pricelists'
import { pricelistImportColumns, PRICELIST_IMPORT_EXAMPLE_ROWS } from '../pricelist-import-columns'
import { getSession, type UserSession } from '@/lib/session'
import { useRefetchOnFocus } from '@/lib/hooks/use-refetch-on-focus'
import { useDraftAutosave } from '@/lib/hooks/use-draft-autosave'
import DraftRestoreBanner from '@/components/shared/DraftRestoreBanner'
import PricelistCustomersDialog from './PricelistCustomersDialog'

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
  /** 该单位的规格说明（如"500g/包"），存在 ProductSaleUom.spec，加订单行/打印价格表都读它 */
  spec: string | null
  /** 下面四个字段只为了喂 priceOf()，算"这个单位自己卖多少钱"（20261025 Public Price 换算修复） */
  priceMode: SaleUomPriceMode
  priceOverride: number | null
  priceDiscountPct: number
  priceSurcharge: number
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

/** Pricelist Items 表格可点击表头排序的列；点第三次回到默认的 sequence 顺序 */
type ItemSortKey = 'productNo' | 'applyOn' | 'minQty' | 'dateStart' | 'dateEnd' | 'category' | 'price' | 'priceDiscount' | 'cost'

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
    // products 传的是全部商品(含已归档)：归档商品以前也显示成「-」，看起来像无效规则(20261008)
    const p = products.find(p => p.id === scopedProductId(item))
    if (!p) return '-'
    // 20261014：很多商品同名，名字后面带规格(如 "10KG"/"20KG")才分得清是哪一款。
    // 20261025 改正：规格必须按这条规则自己限定的单位(item.uomId)取，不能恒用 purchaseUomSpec
    // (采购/箱规那个单位的规格)——否则规则选了 can，名字后面却接着写箱规"6*2950g"，
    // 看着像这一行卖的是一箱而不是一罐。没限定单位(item.uomId 为空)时才退回默认单位的规格，
    // 跟 /api/pricelists/print 的口径一致(该路由按 productId:uomId 精确匹配、否则落默认单位)。
    const scopedSpec = item.uomId
      ? p.saleUoms?.find(su => su.uomId === item.uomId)?.spec
        ?? p.saleUoms?.find(su => su.isDefault)?.spec
        ?? null
      : p.purchaseUomSpec
    const name = scopedSpec ? `${p.name} (${scopedSpec})` : p.name
    const archived = p.status?.toLowerCase() !== 'active' || p.active === false
    return archived ? `${name} ${isEn ? '(archived)' : '(已归档)'}` : name
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
 * 20261014：显示完整路径（"父类目 / 子类目"），与导出列（lib/export/loaders/pricelists.ts）
 * 口径保持一致，复用同一个 categoryPathMap。
 */
function productCategoryLabel(
  item: OdooPricelistItem,
  scopedProduct: Product | undefined,
  categories: ProductCategory[],
  isEn: boolean,
): string {
  const paths = categoryPathMap(categories, isEn ? 'name' : 'nameZh')
  if (item.applyOn === 'category') {
    return (item.categoryId && paths.get(item.categoryId)) || ''
  }
  if (!scopedProduct?.categoryId) return ''
  return paths.get(scopedProduct.categoryId) || ''
}

/**
 * 20261026：从 ItemDialog 抽出来给新的「阶梯价格」弹窗（TierPriceDialog）复用——
 * 两处都要"选定商品后查它有哪些可售单位"，口径必须是同一份代码。
 */
function useSaleUomOptions(
  productId: string | undefined, isEn: boolean,
): [SaleUomOption[], React.Dispatch<React.SetStateAction<SaleUomOption[]>>] {
  const [options, setOptions] = useState<SaleUomOption[]>([])
  useEffect(() => {
    if (!productId) { setOptions([]); return }
    let cancelled = false
    apiGet<Array<{
      uomId: string; isDefault: boolean; active: boolean; factor: number; spec: string | null
      priceMode?: SaleUomPriceMode; priceOverride?: number | null
      priceDiscountPct?: number | string | null; priceSurcharge?: number | string | null
      uom: { name: string; nameZh?: string | null }
    }>>(
      `/api/products/${productId}/sale-uoms`,
    )
      .then(rows => {
        if (cancelled) return
        setOptions(
          rows.filter(r => r.active).map(r => ({
            uomId: r.uomId, isDefault: r.isDefault, factor: Number(r.factor) || 1, spec: r.spec,
            uomName: isEn ? r.uom.name : (r.uom.nameZh ?? r.uom.name),
            priceMode: r.priceMode ?? 'AUTO',
            priceOverride: r.priceOverride ?? null,
            priceDiscountPct: r.priceDiscountPct != null ? Number(r.priceDiscountPct) : 0,
            priceSurcharge: r.priceSurcharge != null ? Number(r.priceSurcharge) : 0,
          })),
        )
      })
      .catch(() => { if (!cancelled) setOptions([]) })
    return () => { cancelled = true }
  }, [productId, isEn])
  return [options, setOptions]
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
  /** 全部商品(含已归档)，只用来显示规则锁定的商品名；选品下拉仍只用启用中的 products */
  const [allProductsForLabels, setAllProductsForLabels] = useState<Product[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [uoms, setUoms] = useState<Uom[]>([])

  const [session, setSession] = useState<UserSession | null>(null)
  useEffect(() => { setSession(getSession()) }, [])

  // 新建页没有真实 id（路由参数固定是 'new'），草稿要靠一个稳定 key 跨刷新认出
  // "是不是同一次没填完的单"——第一次渲染生成一个写进 URL 查询串，刷新页面时从 URL 读回。
  const [draftId] = useState(() => searchParams.get('draftId') || `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  useEffect(() => {
    if (id !== 'new') return
    if (searchParams.get('draftId') === draftId) return
    const next = new URLSearchParams(searchParams.toString())
    next.set('draftId', draftId)
    router.replace(`?${next.toString()}`, { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [editMode, setEditMode] = useState(id === 'new' || searchParams.get('new') === '1')
  const [itemPage, setItemPage] = useState(1)
  const [itemPageSize, setItemPageSize] = useState(ITEMS_PAGE_SIZE_DEFAULT)
  const [itemSort, setItemSort] = useState<{ key: ItemSortKey; dir: 'asc' | 'desc' } | null>(null)
  // 规则搜索(20261008)：按商品名/商品编号/分类名过滤明细行，规则多时不用翻页找
  const [itemQuery, setItemQuery] = useState('')
  // 拖拽排序状态（与 OrderLineEditor 同一套：拖拽手柄按下才让 <tr draggable> 生效，
  // 不然整行文字选取/点击都会被 HTML5 drag 劫持）
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [handleActive, setHandleActive] = useState(false)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<OdooPricelistItem | null>(null)
  const [isNewItem, setIsNewItem] = useState(false)

  // 阶梯价格弹窗(20261026)：同一个商品+单位的多档 minQty/价格一次性编辑，不用再逐条加规则。
  const [tierDialogOpen, setTierDialogOpen] = useState(false)
  // 打开时这个目标下已有的全部阶梯条目（新开一组时为空数组）
  const [tierSeedItems, setTierSeedItems] = useState<OdooPricelistItem[]>([])

  // Print/Action dropdown
  const [printOpen, setPrintOpen] = useState(false)
  const [actionOpen, setActionOpen] = useState(false)
  // 详情页的导出/导入(20261007)：导出只导这一个价格表；导入跟列表页同一个接口，关掉弹窗后重新加载
  const [importOpen, setImportOpen] = useState(false)
  const importedRef = useRef(false)
  // 归档 / 批量替换客户弹窗(20261030)：归档必须先处理挂着这张表的客户，见 PricelistCustomersDialog
  const [customersDialog, setCustomersDialog] = useState<'archive' | 'replace' | null>(null)
  const exportAction = useCsvExport({
    entity: 'pricelists',
    params: () => new URLSearchParams({ pricelistId: id }),
    fallbackFilename: 'pricelist.csv',
    columns: PRICELIST_EXPORT_COLUMNS,
  })
  const printRef = useRef<HTMLDivElement>(null)
  const actionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (printRef.current && !printRef.current.contains(e.target as Node)) setPrintOpen(false)
      if (actionRef.current && !actionRef.current.contains(e.target as Node)) setActionOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // 商品/分类/价格表列表/单位是"另一个 tab 可能改了"的参考数据，拆成独立函数
  // 既供初始加载复用，也供下面 useRefetchOnFocus 在回到这个 tab 时单独刷新——
  // 不碰 pl/originalPl，不会在用户编辑中途把表单内容冲掉。
  async function fetchReferenceData() {
    try {
      const [allProducts, allCategories, allPricelists, allUoms] = await Promise.all([
        apiGet<Product[]>('/api/products'),
        apiGet<ProductCategory[]>('/api/product-categories'),
        apiGet<OdooPricelist[]>('/api/pricelists'),
        apiGet<Uom[]>('/api/uoms').catch(() => [] as Uom[]),
      ])
      setProducts(allProducts.filter(p => p.status?.toLowerCase() === 'active' && p.active !== false))
      setAllProductsForLabels(allProducts)
      setCategories(allCategories)
      setUoms(allUoms)
      setAllLists([...allPricelists].sort((a, b) => a.sequence - b.sequence))
    } catch {
      // 参考数据刷新失败静默忽略，不打断正在编辑的内容
    }
  }

  useEffect(() => {
    async function loadRecord() {
      await fetchReferenceData()

      // "new" 是本地草稿态，不落库——真正创建推迟到用户点 Save（见 handleSave），
      // 避免"点了新建但没填名字就退出"在库里留下永久空名孤儿记录。
      if (id === 'new') {
        setPl({
          id: 'new', name: '', currency: 'EUR', items: [], sequence: 99,
          selectable: true, active: true, updatedAt: new Date().toISOString(), countryGroups: [],
        })
        setOriginalPl(null)
        setEditMode(true)
        return
      }

      try {
        const found = await apiGet<OdooPricelist>(`/api/pricelists/${id}`)
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
      } catch {
        toast.error(isEn ? 'Pricelist not found' : '价格表不存在')
        router.push(`${prefix}/classic/operator/pricelists`)
      }
    }
    loadRecord()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // 商品/分类/价格表管理在别的 tab 改了数据后，切回这个已打开的页面希望看到最新结果
  useRefetchOnFocus([fetchReferenceData])

  // 编辑态内容防抖存本地：切去别的 tab 改引用数据被上面的 hook 自动刷新回来时，
  // 不至于把正在填的内容也一起冲掉——保存成功/退出编辑后清掉，不是永久草稿。
  type PricelistDraft = {
    name: string; currency: string; selectable: boolean; active: boolean
    items: OdooPricelistItem[]; countryGroups: string[]
  }
  const draft = useDraftAutosave<PricelistDraft>({
    userId: session?.userId,
    entity: 'pricelist',
    recordKey: id === 'new' ? draftId : id,
    enabled: editMode,
    data: pl ? {
      name: pl.name, currency: pl.currency, selectable: pl.selectable, active: pl.active,
      items: pl.items, countryGroups: pl.countryGroups ?? [],
    } : { name: '', currency: 'EUR', selectable: true, active: true, items: [], countryGroups: [] },
  })
  function restoreDraft() {
    const d = draft.restore()
    if (!d) return
    setPl(p => p ? { ...p, ...d } : p)
  }

  function update<K extends keyof OdooPricelist>(key: K, val: OdooPricelist[K]) {
    setPl(p => p ? { ...p, [key]: val } : p)
  }

  /** 复制：名称加 (copy)，规则整份复制并换新的规则 id；不带 externalId(唯一)和客户挂靠，与列表页批量复制同一套规则 */
  async function handleDuplicate() {
    if (!pl) return
    try {
      const created = await apiPost<OdooPricelist>('/api/pricelists', {
        name: `${pl.name} (copy)`,
        currency: pl.currency,
        sequence: pl.sequence,
        selectable: pl.selectable,
        active: true,
        notes: pl.notes ?? null,
        items: (pl.items ?? []).map(({ id: _id, ...it }) => it),
      })
      toast.success(isEn ? 'Duplicated' : '已复制')
      router.push(`${prefix}/classic/operator/pricelists/${created.id}`)
    } catch {
      toast.error(isEn ? 'Duplicate failed' : '复制失败')
    }
  }

  async function handleSave(overrides?: Partial<OdooPricelist>) {
    if (!pl) return
    const next = overrides ? { ...pl, ...overrides } : pl
    if (!next.name.trim()) {
      toast.error(isEn ? 'Pricelist name is required' : '价格表名称不能为空')
      return
    }
    try {
      if (id === 'new') {
        const { id: _draftId, ...rest } = next
        const created = await apiPost<OdooPricelist>('/api/pricelists', { ...rest, updatedAt: new Date().toISOString() })
        toast.success(isEn ? 'Created' : '已创建')
        draft.clearDraft()
        router.replace(`${prefix}/classic/operator/pricelists/${created.id}?new=1`)
        return
      }
      const payload = { ...next, updatedAt: new Date().toISOString() }
      const saved = await apiPut<OdooPricelist>(`/api/pricelists/${pl.id}`, payload)
      const updated = saved ?? pl
      setPl({ ...updated })
      setOriginalPl({ ...updated })
      setEditMode(false)
      draft.clearDraft()
      toast.success(isEn ? 'Saved' : '已保存')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Save failed' : '保存失败'))
    }
  }

  async function handleRestore() {
    if (!pl) return
    if (!confirm(isEn ? `Restore pricelist "${pl.name}" to active?` : `确认恢复价格表「${pl.name}」为启用状态？`)) return
    await handleSave({ active: true })
  }

  async function handleDiscard() {
    if (id === 'new') {
      // 新建场景：还没落库，直接退出回列表，不留垃圾数据
      draft.clearDraft()
      router.push(`${prefix}/classic/operator/pricelists`)
      return
    }
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
    draft.clearDraft()
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

  function openNewTierGroup() {
    setTierSeedItems([])
    setTierDialogOpen(true)
  }

  /** 把"这条规则所在的整组阶梯"都找出来喂给弹窗——分组标准必须跟算价引擎（targetKeyOf）一致 */
  function openEditTierGroup(item: OdooPricelistItem) {
    if (!pl) return
    const key = targetKeyOf(item)
    setTierSeedItems(pl.items.filter(i => i.computeType === 'fixed' && targetKeyOf(i) === key))
    setTierDialogOpen(true)
  }

  /**
   * 阶梯弹窗保存：先按 targetKeyOf 删掉这个目标下原有的全部 fixed 阶梯条目，再整组换成
   * 弹窗交回来的最终列表——弹窗内部已经把"沿用旧行"（保留原 id/dateStart/dateEnd/
   * badgeLabel/selectable）和"新增档位"（emptyItem 式默认值）都处理好了，这里不用再判断。
   */
  async function saveTierGroup(nextTierItems: OdooPricelistItem[]) {
    if (!pl) return
    if (nextTierItems.length === 0) return
    const key = targetKeyOf(nextTierItems[0])
    const rest = pl.items.filter(i => !(i.computeType === 'fixed' && targetKeyOf(i) === key))
    const ok = await persistItems([...rest, ...nextTierItems])
    if (ok) {
      toast.success(isEn ? 'Tiers saved' : '阶梯价格已保存')
      setTierDialogOpen(false)
    }
  }

  /**
   * 价格表还没落库（id==='new'，草稿态）时，明细行只能改本地 state——
   * 跟这条一样的字段（Country Groups）等页面顶部 Save 一起提交；
   * 已落库的价格表则维持原有"点一下明细就立即调 API"的行为。
   */
  async function persistItems(nextItems: OdooPricelistItem[]): Promise<boolean> {
    if (!pl) return false
    const updated = { ...pl, items: nextItems, updatedAt: new Date().toISOString() }
    if (pl.id === 'new') {
      setPl(updated)
      return true
    }
    try {
      await apiPut(`/api/pricelists/${pl.id}`, updated)
      setPl(updated)
      setOriginalPl(updated)
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Save failed' : '保存失败'))
      return false
    }
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
    const ok = await persistItems(updatedItems)
    if (ok) toast.success(isNewItem ? (isEn ? 'Item added' : '条目已添加') : (isEn ? 'Item updated' : '条目已更新'))
    return ok
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
    const ok = await persistItems(pl.items.filter(i => i.id !== itemId))
    if (ok) toast.success(isEn ? 'Deleted' : '已删除')
  }

  /**
   * 条目没有独立的排序表，`sequence` 就是唯一的顺序依据；新建条目一律给固定的
   * `sequence: 10`（见 emptyItem），多条目挤在同一个值上时挪一条不足以稳定改变
   * 显示顺序。所以每次拖拽都按"当前显示顺序"整体重新编号（10/20/30…），跟 Odoo
   * 里拖拽排序后重新分配 sequence 是同一个思路。
   *
   * 20260907 客户反馈：不要 ▲▼ 箭头，要跟报价单/订单/采购单行编辑
   * （components/classic/OrderLineEditor.tsx）一样鼠标拖拽——那边是「拖拽手柄+
   * onDragStart/onDragOver/onDrop」三件套换序，这里换成同一套交互，
   * 只是这边条目多，直接挪任意两行之间（fromIdx→toIdx），不再局限于相邻交换。
   */
  async function reorderItems(fromIdx: number, toIdx: number) {
    if (!pl || fromIdx === toIdx) return
    const ordered = [...pl.items].sort((a, b) => a.sequence - b.sequence)
    if (fromIdx < 0 || fromIdx >= ordered.length || toIdx < 0 || toIdx >= ordered.length) return
    const [moved] = ordered.splice(fromIdx, 1)
    ordered.splice(toIdx, 0, moved)
    const renumbered = ordered.map((it, i) => ({ ...it, sequence: (i + 1) * 10 }))
    await persistItems(renumbered)
  }

  /** 点表头：第一次升序、第二次降序、第三次回到 sequence 默认顺序（也让拖拽排序重新生效） */
  function toggleItemSort(key: ItemSortKey) {
    setItemSort(prev => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null
    })
    setItemPage(1)
  }

  if (!pl) {
    return <div className="py-12 text-center text-gray-400 text-sm">{isEn ? 'Loading...' : '加载中...'}</div>
  }

  // 归档的价格表只读(20261030)：不能进编辑态、不能改规则/导入，只能「恢复」。
  // 以落库状态(originalPl)为准，服务端 PUT 同样拦着(app/api/pricelists/[id]/route.ts)
  const readOnly = id !== 'new' && originalPl?.active === false

  const sortedLists = allLists
  const currentIdx = sortedLists.findIndex(l => l.id === id)
  const totalLists = sortedLists.length
  const currentPos = currentIdx >= 0 ? currentIdx + 1 : 1

  const itemsBySequence = [...pl.items].sort((a, b) => a.sequence - b.sequence)

  // 排序要用到的派生值（Cost/Price 等）跟渲染那份是同一套算法，这里先算一遍供 sort 用，
  // 渲染时把结果原样传给 ItemRow，不重复计算。
  const enrichedItems = itemsBySequence.map(item => {
    const scopedProduct = allProductsForLabels.find(p => p.id === scopedProductId(item))
    const baseCost = scopedProduct?.standardPrice
    const basePublicPrice = scopedProduct?.listPrice
    // computeItemPrice 必须吃未换算的牌价（决策#6：formula/percentage 规则永远拿基础单位
    // 牌价算折扣）；成本参考值再按规则限定的单位换算。
    const estimatedPrice = scopedProduct
      ? computeItemPrice(item, scopedProduct, basePublicPrice ?? 0, allLists, item.minQty || 1, undefined, 0, item.uomId) ?? undefined
      : undefined
    // 20261025 客户反馈：成本参考值需与编辑弹窗一致，按所选销售单位换算。
    const saleUomRows = scopedProduct?.saleUoms
    const cost = item.uomId && saleUomRows && baseCost != null
      ? baseCost * factorOf(saleUomRows, item.uomId)
      : baseCost
    return {
      item,
      productNo: scopedProduct?.productNo,
      cost,
      estimatedPrice,
      applyLabel: applyOnLabel(item, allProductsForLabels, categories, isEn),
      categoryLabel: productCategoryLabel(item, scopedProduct, categories, isEn),
      priceValue: estimatedPrice ?? item.fixedPrice ?? 0,
      priceDiscountValue: item.computeType === 'formula'
        ? item.priceDiscount ?? 0
        : item.computeType === 'percentage'
          ? item.percentDiscount ?? 0
          : 0,
    }
  })

  const q = itemQuery.trim().toLowerCase()
  const filteredItems = q
    ? enrichedItems.filter(r =>
        r.applyLabel.toLowerCase().includes(q)
        || r.categoryLabel.toLowerCase().includes(q)
        || (r.productNo != null && String(r.productNo) === q.replace(/^#/, '')))
    : enrichedItems

  const sortedItems = itemSort
    ? [...filteredItems].sort((a, b) => {
        const dir = itemSort.dir === 'asc' ? 1 : -1
        switch (itemSort.key) {
          case 'productNo': return ((a.productNo ?? Number.MAX_SAFE_INTEGER) - (b.productNo ?? Number.MAX_SAFE_INTEGER)) * dir
          case 'applyOn': return a.applyLabel.localeCompare(b.applyLabel) * dir
          case 'minQty': return (a.item.minQty - b.item.minQty) * dir
          case 'dateStart': return (a.item.dateStart ?? '').localeCompare(b.item.dateStart ?? '') * dir
          case 'dateEnd': return (a.item.dateEnd ?? '').localeCompare(b.item.dateEnd ?? '') * dir
          case 'category': return a.categoryLabel.localeCompare(b.categoryLabel) * dir
          case 'price': return (a.priceValue - b.priceValue) * dir
          case 'priceDiscount': return (a.priceDiscountValue - b.priceDiscountValue) * dir
          case 'cost': return ((a.cost ?? 0) - (b.cost ?? 0)) * dir
          default: return 0
        }
      })
    : filteredItems

  const totalItems = sortedItems.length
  const pagedItems = sortedItems.slice((itemPage - 1) * itemPageSize, itemPage * itemPageSize)

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
              onClick={() => handleSave()}
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
            {readOnly ? (
              <button
                onClick={handleRestore}
                className="h-8 px-4 text-sm font-medium text-white rounded"
                style={{ background: PURPLE }}
              >
                {isEn ? 'Restore' : '恢复'}
              </button>
            ) : (
              <button
                onClick={() => setEditMode(true)}
                className="h-8 px-4 text-sm font-medium text-white rounded"
                style={{ background: PURPLE }}
              >
                Edit
              </button>
            )}
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
                  <button onClick={() => { window.open(`${prefix}/classic/print/pricelist?ids=${pl.id}`, '_blank'); setPrintOpen(false) }} className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50">
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
                  <button onClick={() => { setActionOpen(false); exportAction.onClick() }} className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50">
                    {isEn ? 'Export' : '导出'}
                  </button>
                  {!readOnly && (
                    <button onClick={() => { setActionOpen(false); importedRef.current = false; setImportOpen(true) }} className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50">
                      {isEn ? 'Import' : '导入'}
                    </button>
                  )}
                  <button onClick={() => { setActionOpen(false); handleDuplicate() }} className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50">
                    {isEn ? 'Duplicate' : '复制'}
                  </button>
                  <button onClick={() => { setActionOpen(false); setCustomersDialog('replace') }} className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50">
                    {isEn ? 'Replace on customers' : '批量替换客户'}
                  </button>
                  {readOnly ? (
                    <button onClick={() => { setActionOpen(false); handleRestore() }} className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50">
                      {isEn ? 'Restore' : '恢复'}
                    </button>
                  ) : (
                    <button onClick={() => { setActionOpen(false); setCustomersDialog('archive') }} className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50">
                      Archive
                    </button>
                  )}
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
      <div className="p-6">
        {editMode && draft.pendingDraft && (
          <DraftRestoreBanner onRestore={restoreDraft} onDiscard={draft.discard} />
        )}
        {readOnly && (
          <div className="mb-3 px-4 py-2 rounded border text-sm flex items-center gap-3" style={{ borderColor: '#adb5bd', background: '#f8f9fa', color: '#495057' }}>
            <span className="flex-1">
              {isEn
                ? 'This pricelist is archived and read-only. Restore it to make changes.'
                : '此价格表已归档，只读不可修改。如需修改请先恢复。'}
            </span>
            <button onClick={handleRestore} className="text-sm font-medium hover:underline" style={{ color: PURPLE }}>
              {isEn ? 'Restore' : '恢复'}
            </button>
          </div>
        )}
        <div className="bg-white border border-gray-200 rounded-sm shadow-sm">

          {/* Name + Active toggle */}
          <div className="flex items-start justify-between px-5 pt-5 pb-3">
            <div className="flex-1 mr-4">
              {editMode ? (
                <OdooField label="Name">
                  <input
                    type="text"
                    value={pl.name}
                    onChange={e => update('name', e.target.value)}
                    placeholder="e.g. USD Retailers"
                    className="odoo-input flex-1"
                  />
                </OdooField>
              ) : (
                <h2 className="text-lg font-semibold text-gray-800">{pl.name || <span className="text-gray-400 italic">{isEn ? '(Unnamed)' : '（未命名）'}</span>}</h2>
              )}
            </div>
            {/* 编辑态不再能直接切归档：归档要先处理挂着的客户，只能在查看态走弹窗 */}
            {editMode ? (
              <span
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
              </span>
            ) : (
              <button
                onClick={() => { if (pl.active) setCustomersDialog('archive'); else handleRestore() }}
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
            )}
          </div>

          {/* Form fields */}
          <div className="px-5 pb-4" style={{ borderBottom: '1px solid #e9e9e9' }}>
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
          </div>

          {/* ── Pricelist Items ── */}
          <div>
            <div className="flex items-center justify-between px-5 py-2">
              <div className="flex items-center gap-3">
                <span className="text-base font-semibold" style={{ color: PURPLE }}>
                  Pricelist Items
                </span>
                <input
                  type="search"
                  value={itemQuery}
                  onChange={e => { setItemQuery(e.target.value); setItemPage(1) }}
                  placeholder={isEn ? 'Search product / No. / category…' : '搜索商品 / 编号 / 分类…'}
                  className="border border-gray-300 rounded px-2 py-1 text-xs w-56 focus:outline-none focus:border-[#875A7B]"
                />
                {q && <span className="text-xs text-gray-400">{isEn ? `${totalItems} of ${enrichedItems.length}` : `${totalItems} / ${enrichedItems.length} 条`}</span>}
              </div>
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
                    {/* 上/下移+删除紧跟在 Applicable On 前面，方便在宽表中找到。 */}
                    {editMode && <th className="w-16 px-2 py-2" />}
                    <SortableTh sortKey="productNo" itemSort={itemSort} onSort={toggleItemSort} className="text-right px-3 py-2 w-16">{isEn ? 'Product No' : '商品编号'}</SortableTh>
                    <SortableTh sortKey="applyOn" itemSort={itemSort} onSort={toggleItemSort} className="text-left px-4 py-2 min-w-[220px]">Applicable On</SortableTh>
                    <SortableTh sortKey="minQty" itemSort={itemSort} onSort={toggleItemSort} className="text-right px-3 py-2">Min. Quantity</SortableTh>
                    <SortableTh sortKey="dateStart" itemSort={itemSort} onSort={toggleItemSort} className="text-left px-3 py-2">Start Date</SortableTh>
                    <SortableTh sortKey="dateEnd" itemSort={itemSort} onSort={toggleItemSort} className="text-left px-3 py-2">End Date</SortableTh>
                    <SortableTh sortKey="category" itemSort={itemSort} onSort={toggleItemSort} className="text-left px-3 py-2">Product Category</SortableTh>
                    <SortableTh sortKey="price" itemSort={itemSort} onSort={toggleItemSort} className="text-left px-3 py-2 min-w-[160px]">Public Price</SortableTh>
                    <SortableTh sortKey="priceDiscount" itemSort={itemSort} onSort={toggleItemSort} className="text-right px-3 py-2">Price Discount</SortableTh>
                    <SortableTh sortKey="cost" itemSort={itemSort} onSort={toggleItemSort} className="text-right px-3 py-2">Public Cost Price</SortableTh>
                    <th className="text-center px-3 py-2">{isEn ? 'Selectable' : '可售'}</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedItems.length === 0 && (
                    <tr>
                      <td colSpan={editMode ? 12 : 11} className="px-4 py-3 text-gray-400 italic text-xs">{q ? (isEn ? 'No matching items' : '没有匹配的条目') : (isEn ? 'No items yet' : '暂无条目')}</td>
                    </tr>
                  )}
                  {pagedItems.map(row => {
                    const { item } = row
                    const globalIdx = sortedItems.findIndex(r => r.item.id === item.id)
                    // 拖拽排序只在默认 sequence 顺序下有意义——按某一列排序时，行的显示位置
                    // 跟 sequence 已经脱节，拖拽换的是"看起来的顺序"而不是真实存储顺序，
                    // 跟点表头第三次回到默认顺序才重新生效是同一个理由（原 ▲▼ 就是这个约束）。
                    // 搜索过滤时同理：看到的只是一部分行，拖拽位置对不上真实顺序
                    const canDrag = !itemSort && !q
                    return (
                      <ItemRow
                        key={item.id}
                        item={item}
                        productNo={row.productNo}
                        inlineEdit={editMode}
                        onInlineChange={patch => persistItems(pl.items.map(i => i.id === item.id ? { ...i, ...patch } : i))
                          .then(ok => { if (ok) toast.success(isEn ? 'Price updated' : '价格已更新') })}
                        products={allProductsForLabels}
                        categories={categories}
                        uoms={uoms}
                        cost={row.cost}
                        estimatedPrice={row.estimatedPrice}
                        productCategoryLabel={row.categoryLabel}
                        showDelete={editMode}
                        onEdit={readOnly ? undefined : () => openEditItem(item)}
                        onDelete={() => handleDeleteItem(item.id)}
                        onEditTiers={
                          item.computeType === 'fixed' && (item.applyOn === 'variant' || item.applyOn === 'product')
                            ? () => openEditTierGroup(item)
                            : undefined
                        }
                        canDrag={canDrag}
                        isDragging={dragIndex === globalIdx}
                        isOver={canDrag && overIndex === globalIdx && dragIndex !== null && dragIndex !== globalIdx}
                        handleActive={handleActive}
                        onHandleDown={() => setHandleActive(true)}
                        onHandleUp={() => setHandleActive(false)}
                        onDragStartRow={() => setDragIndex(globalIdx)}
                        onDragOverRow={() => { if (overIndex !== globalIdx) setOverIndex(globalIdx) }}
                        onDropRow={() => {
                          if (dragIndex !== null) reorderItems(dragIndex, globalIdx)
                          setDragIndex(null)
                          setOverIndex(null)
                          setHandleActive(false)
                        }}
                        onDragEndRow={() => {
                          setDragIndex(null)
                          setOverIndex(null)
                          setHandleActive(false)
                        }}
                        isEn={isEn}
                      />
                    )
                  })}
                </tbody>
              </table>
            </div>
            {editMode && (
              <div className="px-4 py-2 flex items-center gap-4">
                <button
                  onClick={openNewItem}
                  className="text-xs hover:underline"
                  style={{ color: PURPLE }}
                >
                  Add a line
                </button>
                <button
                  onClick={openNewTierGroup}
                  className="text-xs hover:underline"
                  style={{ color: PURPLE }}
                >
                  {isEn ? '+ Tiered pricing' : '+ 阶梯价格'}
                </button>
              </div>
            )}
          </div>
        </div>

        {id !== 'new' && (
          <div className="mt-4">
            <ActionLogPanel resource="pricelist" resourceId={id} />
          </div>
        )}
      </div>

      {exportAction.dialog}
      {customersDialog && (
        <PricelistCustomersDialog
          mode={customersDialog}
          pricelist={pl}
          allLists={allLists}
          onClose={() => setCustomersDialog(null)}
          onDone={archived => {
            setCustomersDialog(null)
            if (archived) {
              setPl(p => p ? { ...p, active: false } : p)
              setOriginalPl(p => p ? { ...p, active: false } : p)
              setEditMode(false)
            }
            fetchReferenceData()
          }}
          isEn={isEn}
        />
      )}
      <BulkImportDialog
        open={importOpen}
        onClose={() => { setImportOpen(false); if (importedRef.current) window.location.reload() }}
        onDone={() => { importedRef.current = true }}
        templateFileName="pricelist-import-template"
        endpoint="/api/pricelists/bulk" historyResource="pricelist"
        title={{ zh: '导入价格表规则(CSV)', en: 'Import Pricelist Rules (CSV)' }}
        hint={{
          zh: '列名与价格表导出完全一致：先用 Action → 导出 拿到这个价格表的 CSV，改完直接导回来。每一行都要填「价格表名称」。',
          en: 'Columns match the pricelist export: use Action → Export to get this pricelist as CSV, edit it and import it back. Fill Pricelist Name on every row.',
        }}
        extraHint={{
          zh: <>商品优先按<b>商品编号</b>匹配，没填再按商品名称。<b>规则 ID</b>(Item ID)是每条定价规则的内部编号，用来定位要改的那一条，请原样保留;留空 = 新增一条规则。导入只会新增/更新规则，不会删除。</>,
          en: <>Products are matched by <b>Product No</b> first, then by name. <b>Item ID</b> is the internal id of each pricing rule and tells the import which rule to update — keep it as exported; leave it blank to add a new rule. Import only adds/updates rules, never deletes.</>,
        }}
        columns={pricelistImportColumns(isEn)}
        exampleRows={PRICELIST_IMPORT_EXAMPLE_ROWS}
      />

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
          currentCurrency={pl.currency}
          products={products}
          categories={categories}
          uoms={uoms}
          allLists={allLists.filter(l => l.id !== pl.id)}
          isNew={isNewItem}
          scopeTitle={applyScopeTitle(editingItem, products, categories, isEn)}
          isEn={isEn}
        />
      )}

      {/* ── Tiered pricing dialog ── */}
      {tierDialogOpen && (
        <TierPriceDialog
          seedItems={tierSeedItems}
          onSave={saveTierGroup}
          onDiscard={() => setTierDialogOpen(false)}
          products={products}
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

// ─── SortableTh ───────────────────────────────────────────────────────────────

function SortableTh({ sortKey, itemSort, onSort, className, children }: {
  sortKey: ItemSortKey
  itemSort: { key: ItemSortKey; dir: 'asc' | 'desc' } | null
  onSort: (key: ItemSortKey) => void
  className: string
  children: ReactNode
}) {
  const active = itemSort?.key === sortKey
  return (
    <th
      className={`font-medium text-gray-600 cursor-pointer select-none hover:text-gray-900 ${className}`}
      onClick={() => onSort(sortKey)}
    >
      {children}
      <span className="ml-1 text-[9px] inline-block w-2" style={{ color: active ? PURPLE : '#c9c9c9' }}>
        {active ? (itemSort!.dir === 'asc' ? '▲' : '▼') : '▲'}
      </span>
    </th>
  )
}

// ─── ItemRow ──────────────────────────────────────────────────────────────────

function ItemRow({ item, productNo, inlineEdit, onInlineChange, products, categories, uoms, cost, estimatedPrice, productCategoryLabel, showDelete, onEdit, onDelete, onEditTiers, canDrag, isDragging, isOver, handleActive, onHandleDown, onHandleUp, onDragStartRow, onDragOverRow, onDropRow, onDragEndRow, isEn }: {
  item: OdooPricelistItem
  productNo: number | undefined
  inlineEdit: boolean
  onInlineChange: (patch: Partial<OdooPricelistItem>) => void
  products: Product[]
  categories: ProductCategory[]
  uoms: Uom[]
  cost: number | undefined
  estimatedPrice: number | undefined
  productCategoryLabel: string
  showDelete: boolean
  onEdit?: () => void
  onDelete: () => void
  /** 只对"单商品+固定价"的规则有意义——点开阶梯价格弹窗编辑这一整组 minQty 档位 */
  onEditTiers?: () => void
  /** 20260907 客户反馈改用拖拽排序，不要 ▲▼ 箭头——与
      components/classic/OrderLineEditor.tsx（报价单/订单/采购单行编辑）同一套交互 */
  canDrag: boolean
  isDragging: boolean
  isOver: boolean
  handleActive: boolean
  onHandleDown: () => void
  onHandleUp: () => void
  onDragStartRow: () => void
  onDragOverRow: () => void
  onDropRow: () => void
  onDragEndRow: () => void
  isEn: boolean
}) {
  const [hover, setHover] = useState(false)
  const scopedUom = uomScopeLabel(item, uoms, isEn)
  // Edit 模式下固定价/百分比折扣可以直接在表格里改(20261008)，不用每条都点开弹窗
  const inlineField: 'fixedPrice' | 'percentDiscount' | null = inlineEdit
    ? (item.computeType === 'fixed' ? 'fixedPrice' : item.computeType === 'percentage' ? 'percentDiscount' : null)
    : null

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
      draggable={canDrag && handleActive}
      onDragStart={canDrag ? onDragStartRow : undefined}
      onDragOver={canDrag ? e => { e.preventDefault(); onDragOverRow() } : undefined}
      onDrop={canDrag ? e => { e.preventDefault(); onDropRow() } : undefined}
      onDragEnd={onDragEndRow}
      style={{
        background: isDragging ? '#f3f4f6' : (hover ? PURPLE_LIGHT : undefined),
        cursor: onEdit ? 'pointer' : 'default',
        borderBottom: '1px solid #f0f0f0',
        borderTop: isOver ? '2px solid #875A7B' : undefined,
        opacity: isDragging ? 0.4 : 1,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onEdit}
    >
      {showDelete && (
        <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-center gap-1.5">
            {canDrag && (
              <span
                title={isEn ? 'Drag to reorder' : '拖动以调整顺序'}
                onMouseDown={onHandleDown}
                onMouseUp={onHandleUp}
                className="cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-600 select-none leading-none"
              >☰</span>
            )}
            {onEditTiers && (
              <span
                onClick={onEditTiers}
                title={isEn ? 'Edit quantity tiers' : '编辑阶梯价格'}
                className="text-gray-300 hover:text-[#875A7B] text-base leading-none cursor-pointer select-none"
              >☷</span>
            )}
            <span
              onClick={onDelete}
              title={isEn ? 'Delete' : '删除'}
              className="text-gray-300 hover:text-red-400 text-base leading-none cursor-pointer select-none"
            >🗑</span>
          </div>
        </td>
      )}
      <td className="px-3 py-1.5 text-right text-gray-500 tabular-nums">{productNo ?? ''}</td>
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
        {inlineField ? (
          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            {inlineField === 'fixedPrice' && <span className="text-gray-400">€</span>}
            <InlineNumber
              value={Number(item[inlineField] ?? 0)}
              min={inlineField === 'fixedPrice' ? 0 : -100}
              max={inlineField === 'fixedPrice' ? 1_000_000 : 100}
              onCommit={v => onInlineChange({ [inlineField]: v })}
              isEn={isEn}
            />
            {inlineField === 'percentDiscount' && (
              <span className="text-gray-400 whitespace-nowrap">
                % {isEn ? 'off' : '折扣'}{estimatedPrice != null ? ` → €${estimatedPrice.toFixed(2)}` : ''}
              </span>
            )}
          </div>
        ) : item.computeType !== 'fixed' && estimatedPrice != null ? (
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
      <td className="px-3 py-1.5 text-center" onClick={e => e.stopPropagation()}>
        {inlineEdit ? (
          <input
            type="checkbox"
            checked={item.selectable !== false}
            onChange={e => onInlineChange({ selectable: e.target.checked })}
            className="w-4 h-4 cursor-pointer"
            style={{ accentColor: PURPLE }}
          />
        ) : item.selectable !== false ? (
          <span className="inline-flex w-4 h-4 items-center justify-center rounded-sm text-white text-xs" style={{ background: PURPLE }}>✓</span>
        ) : (
          <span className="inline-block w-4 h-4 border border-gray-300 rounded-sm" />
        )}
      </td>
    </tr>
  )
}

/** 表格内的数字输入：失焦或回车才提交，Esc 还原；没改动/非法值不提交 */
function InlineNumber({ value, min, max, onCommit, isEn }: {
  value: number
  min: number
  max: number
  onCommit: (v: number) => void
  isEn: boolean
}) {
  const [draft, setDraft] = useState(String(value))
  const [prevValue, setPrevValue] = useState(value)
  if (prevValue !== value) { setPrevValue(value); setDraft(String(value)) }
  function commit() {
    const v = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(v) || v < min || v > max) {
      toast.error(isEn ? `Enter a number between ${min} and ${max}` : `请输入 ${min} ~ ${max} 之间的数字`)
      setDraft(String(value))
      return
    }
    if (v !== value) onCommit(v)
  }
  return (
    <input
      type="number"
      step="0.01"
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') { setDraft(String(value)); (e.target as HTMLInputElement).blur() }
      }}
      className="w-20 border border-gray-300 rounded px-1.5 py-0.5 text-xs text-right focus:outline-none focus:border-[#875A7B]"
    />
  )
}

// ─── ItemDialog ───────────────────────────────────────────────────────────────

function ItemDialog({
  item, onChange, onSaveClose, onSaveNew, onDiscard, onRemove,
  pricelistId, currentCurrency, products, categories, uoms, allLists, isNew, scopeTitle, isEn,
}: {
  item: OdooPricelistItem
  onChange: (item: OdooPricelistItem) => void
  onSaveClose: (item: OdooPricelistItem) => void
  onSaveNew: (item: OdooPricelistItem) => void
  onDiscard: () => void
  onRemove?: () => void
  pricelistId: string
  currentCurrency: string
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

  const [saleUomOptions, setSaleUomOptions] = useSaleUomOptions(saleUomProductId, isEn)

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

  // 20261024：产品规格（ProductSaleUom.spec）inline 编辑——没限定单位（item.uomId 为空）时
  // 编这条规则实际对应的基准单位的规格，跟这条规则限定了某单位时编那个单位的规格是同一个输入框。
  // 改了直接 PATCH 回商品的可售单位配置，不随价格表这条规则一起保存/撤销。
  const targetSpecUom = item.uomId
    ? saleUomOptions.find(o => o.uomId === item.uomId)
    : saleUomOptions.find(o => o.isDefault)
  const [specDraft, setSpecDraft] = useState('')
  const [specSaving, setSpecSaving] = useState(false)
  useEffect(() => {
    setSpecDraft(targetSpecUom?.spec ?? '')
  }, [targetSpecUom?.uomId, targetSpecUom?.spec])

  async function saveSpec() {
    if (!saleUomProductId || !targetSpecUom) return
    const trimmed = specDraft.trim()
    if (trimmed === (targetSpecUom.spec ?? '')) return
    setSpecSaving(true)
    try {
      const updated = await apiPatch<{ spec: string | null }>(
        `/api/products/${saleUomProductId}/sale-uoms/${targetSpecUom.uomId}`,
        { spec: trimmed },
      )
      setSaleUomOptions(prev => prev.map(o => o.uomId === targetSpecUom.uomId ? { ...o, spec: updated.spec } : o))
      toast.success(isEn ? 'Saved' : '已保存')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
      setSpecDraft(targetSpecUom.spec ?? '')
    } finally {
      setSpecSaving(false)
    }
  }

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
  const [showAllOtherPricelists, setShowAllOtherPricelists] = useState(false)
  const [otherPricelistQuery, setOtherPricelistQuery] = useState('')

  const scopedProduct = products.find(p => p.id === scopedProductId(item))
  const templateCostVal = scopedProduct?.standardPrice ?? 0
  const templatePublicPriceVal = scopedProduct?.listPrice ?? 0
  const costLabel = 'Cost'

  // ── 定价参考(20260902)：成本换算到规则限定的单位 + 预估毛利 + 该商品在其他价格表的价 ──
  // 这条规则如果限定了某个可售单位(item.uomId)，成本也要跟着换算，否则毛利率会用
  // "基准单位成本 ÷ 这个单位的价"算出一个没有意义的数字（同类问题在订单侧 20260827 修过）。
  const uomFactor = item.uomId ? (saleUomOptions.find(o => o.uomId === item.uomId)?.factor ?? 1) : 1
  const scopedCostVal = templateCostVal * uomFactor
  // 商品主档 Public Price 作为公式基准；按所选单位单独换算，仅用于定价参考展示。
  const scopedPublicPriceVal = item.uomId ? priceOf(saleUomOptions, item.uomId, templatePublicPriceVal) : templatePublicPriceVal
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
  const samePriceLists = otherPricelistPrices.filter(p =>
    estimatedPrice != null && p.currency === currentCurrency && p.price.toFixed(2) === estimatedPrice.toFixed(2),
  )
  const differentPriceLists = otherPricelistPrices.filter(p => !samePriceLists.includes(p))
  const visibleOtherPricelistPrices = (showAllOtherPricelists ? otherPricelistPrices : differentPriceLists)
    .filter(p => p.name.toLowerCase().includes(otherPricelistQuery.trim().toLowerCase()))
    .sort((a, b) => {
      const aComparable = estimatedPrice != null && a.currency === currentCurrency
      const bComparable = estimatedPrice != null && b.currency === currentCurrency
      if (aComparable !== bComparable) return aComparable ? -1 : 1
      const difference = aComparable && bComparable
        ? Math.abs(b.price - estimatedPrice!) - Math.abs(a.price - estimatedPrice!)
        : 0
      return difference || a.name.localeCompare(b.name, isEn ? 'en' : 'zh')
    })

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
                  <label
                    key={opt}
                    onClick={() => setApplyOn(opt)}
                    className="flex min-h-8 items-center gap-2 rounded px-2 -mx-2 cursor-pointer text-sm hover:bg-purple-50"
                  >
                    <OdooRadio
                      checked={item.applyOn === opt || (opt === 'variant' && item.applyOn === 'product')}
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
                <span className="text-gray-800">{scopedPublicPriceVal.toFixed(2)}</span>
                {item.uomId && (
                  <span className="text-[11px] text-gray-400">
                    {isEn ? '(scaled to selected unit)' : '（已按选定单位换算）'}
                  </span>
                )}
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

                  <div className="mt-3">
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      {targetSpecUom
                        ? (isEn ? `Product Spec (${targetSpecUom.uomName})` : `产品规格（${targetSpecUom.uomName}）`)
                        : (isEn ? 'Product Spec' : '产品规格')}
                    </label>
                    <input
                      type="text"
                      value={specDraft}
                      onChange={e => setSpecDraft(e.target.value)}
                      onBlur={saveSpec}
                      disabled={!targetSpecUom || specSaving}
                      placeholder={isEn ? 'e.g. 500g/pack, 10 packs per case' : '例如：500g/包，一箱10包'}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B] disabled:bg-gray-50 disabled:text-gray-400"
                    />
                    <p className="text-[11px] text-gray-400 mt-1">
                      {isEn
                        ? "Shown on order lines and the printed pricelist for this unit. Saves directly to the product's sale-unit setup — not part of this rule, and not tied to this pricelist's own Save."
                        : '会显示在订单行和打印版价格表上。直接存回该商品的可售单位配置，不属于这条规则本身，也不需要点这张价格表的保存。'}
                    </p>
                  </div>
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
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={item.selectable !== false}
                    onChange={e => set('selectable', e.target.checked)}
                    className="w-4 h-4 cursor-pointer"
                    style={{ accentColor: PURPLE }}
                  />
                  <span className="text-xs font-medium text-gray-600">{isEn ? 'Selectable' : '可售'}</span>
                </label>
                <p className="text-[11px] text-gray-400 mt-1">
                  {isEn
                    ? 'Uncheck to pause this rule (e.g. seasonal/transport shortage) without deleting it — ordering falls back to the next matching rule, and this row is hidden from printed/exported pricelists.'
                    : '取消勾选＝暂停这条规则（如季节性/运输缺货），不用删掉；下单会回退到下一条匹配规则，打印/导出价格表也不再显示这一行。'}
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Start Date</label>
                <DatePicker
                  value={item.dateStart ?? ''}
                  onChange={v => set('dateStart', v || undefined)}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">End Date</label>
                <DatePicker
                  value={item.dateEnd ?? ''}
                  onChange={v => set('dateEnd', v || undefined)}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  {isEn ? 'Promo Badge Label (customer portal)' : '促销角标文案（客户门户展示）'}
                </label>
                <input
                  type="text"
                  value={item.badgeLabel ?? ''}
                  onChange={e => set('badgeLabel', e.target.value || undefined)}
                  placeholder={isEn ? 'e.g. 20% off this week' : '例如：限时8折'}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
                />
                {!item.dateStart && !item.dateEnd && item.badgeLabel && (
                  <p className="text-[11px] text-amber-600 mt-1">
                    {isEn
                      ? 'No Start/End Date set — this will show as a permanent promo badge. Consider adding a date range for a real "limited-time" offer.'
                      : '未设置起止日期——角标会一直显示。真正的"限时"促销建议配合起止日期一起填。'}
                  </p>
                )}
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
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <span className="text-gray-600">
                        {isEn ? 'This Product on Other Pricelists' : '该商品在其他价格表'}
                      </span>
                      <span className="text-xs text-gray-500">
                        {isEn
                          ? `${otherPricelistPrices.length} lists · ${samePriceLists.length} same · ${differentPriceLists.length} different`
                          : `${otherPricelistPrices.length} 张 · ${samePriceLists.length} 张同价 · ${differentPriceLists.length} 张异价`}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <button
                        type="button"
                        onClick={() => setShowAllOtherPricelists(false)}
                        className={`text-xs px-2 py-1 rounded border ${!showAllOtherPricelists ? 'border-[#875A7B] text-[#875A7B] bg-purple-50' : 'border-gray-200 text-gray-500'}`}
                      >
                        {isEn ? `Different (${differentPriceLists.length})` : `只看异价 (${differentPriceLists.length})`}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowAllOtherPricelists(true)}
                        className={`text-xs px-2 py-1 rounded border ${showAllOtherPricelists ? 'border-[#875A7B] text-[#875A7B] bg-purple-50' : 'border-gray-200 text-gray-500'}`}
                      >
                        {isEn ? `All (${otherPricelistPrices.length})` : `显示全部 (${otherPricelistPrices.length})`}
                      </button>
                      <input
                        type="search"
                        value={otherPricelistQuery}
                        onChange={e => setOtherPricelistQuery(e.target.value)}
                        placeholder={isEn ? 'Search pricelists…' : '搜索价格表…'}
                        aria-label={isEn ? 'Search other pricelists' : '搜索其他价格表'}
                        className="ml-auto min-w-0 flex-1 max-w-48 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-[#875A7B]"
                      />
                    </div>
                    <div className="border border-gray-100 rounded max-h-36 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-gray-50 text-gray-500">
                          <tr>
                            <th className="text-left font-medium px-2 py-1.5">{isEn ? 'Pricelist' : '价格表'}</th>
                            <th className="text-right font-medium px-2 py-1.5">{isEn ? 'Price' : '价格'}</th>
                            <th className="text-right font-medium px-2 py-1.5">{isEn ? 'Source' : '来源'}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleOtherPricelistPrices.map(p => {
                            const samePrice = samePriceLists.includes(p)
                            return (
                              <tr key={p.id} className={`border-t border-gray-50 ${!samePrice ? 'bg-amber-50' : ''}`}>
                                <td className="px-2 py-1.5 text-gray-700">{p.name}</td>
                                <td className={`px-2 py-1.5 text-right tabular-nums ${samePrice ? 'text-gray-600' : 'font-semibold text-amber-800'}`}>
                                  {p.currency} {p.price.toFixed(2)}
                                </td>
                                <td className="px-2 py-1.5 text-right text-gray-400">
                                  {p.isFallback
                                    ? (isEn ? 'Public price' : '牌价回退')
                                    : (isEn ? 'Rule price' : '规则价')}
                                </td>
                              </tr>
                            )
                          })}
                          {visibleOtherPricelistPrices.length === 0 && (
                            <tr><td colSpan={3} className="px-2 py-3 text-center text-gray-400">
                              {otherPricelistQuery
                                ? (isEn ? 'No matching pricelists' : '没有匹配的价格表')
                                : (isEn ? 'No different prices' : '没有异价价格表')}
                            </td></tr>
                          )}
                        </tbody>
                      </table>
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
                  <label
                    key={opt}
                    onClick={() => set('computeType', opt)}
                    className="flex min-h-8 items-center gap-2 rounded px-2 -mx-2 cursor-pointer text-sm hover:bg-purple-50"
                  >
                    <OdooRadio checked={item.computeType === opt} />
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

// ─── TierPriceDialog ────────────────────────────────────────────────────────────
// 20261026：单商品阶梯卡——选一个商品（+可选限定单位），把它的多档 minQty/价格放在
// 一个表格里一次编完一起保存，不用再逐条进 ItemDialog 各加一条规则（见客户反馈）。
// 只处理 computeType==='fixed' 的阶梯（本来就是"买够量用这个固定价"场景的唯一形态）。

interface TierRow {
  key: string
  minQty: number
  price: number
  /** 这档沿用的原有规则——保存时要保留它的 id/dateStart/dateEnd/badgeLabel/selectable/sequence */
  existing?: OdooPricelistItem
}

function TierPriceDialog({ seedItems, onSave, onDiscard, products, isEn }: {
  seedItems: OdooPricelistItem[]
  onSave: (items: OdooPricelistItem[]) => void
  onDiscard: () => void
  products: Product[]
  isEn: boolean
}) {
  const seedProductId = seedItems[0] ? scopedProductId(seedItems[0]) : undefined
  const [productId, setProductId] = useState<string | undefined>(seedProductId)
  const [productQuery, setProductQuery] = useState(
    () => products.find(p => p.id === seedProductId)?.name ?? '',
  )
  const [uomId, setUomId] = useState<string | undefined>(seedItems[0]?.uomId)
  const [rows, setRows] = useState<TierRow[]>(() =>
    seedItems.length > 0
      ? [...seedItems]
          .sort((a, b) => a.minQty - b.minQty)
          .map(it => ({ key: it.id, minQty: it.minQty, price: it.fixedPrice ?? 0, existing: it }))
      : [{ key: crypto.randomUUID(), minQty: 1, price: 0 }],
  )

  const [saleUomOptions] = useSaleUomOptions(productId, isEn)
  const isEditingExistingGroup = seedItems.length > 0

  function addRow() {
    setRows(prev => [...prev, { key: crypto.randomUUID(), minQty: 0, price: 0 }])
  }
  function removeRow(key: string) {
    setRows(prev => prev.filter(r => r.key !== key))
  }
  function updateRow(key: string, patch: Partial<Pick<TierRow, 'minQty' | 'price'>>) {
    setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)))
  }

  function handleSave() {
    if (!productId) {
      toast.error(isEn ? 'Please select a product first' : '请先选择一个产品')
      return
    }
    if (rows.length === 0) {
      toast.error(isEn ? 'Add at least one tier' : '请至少添加一档')
      return
    }
    const minQtys = rows.map(r => r.minQty)
    if (new Set(minQtys).size !== minQtys.length) {
      toast.error(isEn ? 'Minimum quantities must be unique' : '起订量不能重复')
      return
    }
    if (rows.some(r => !Number.isFinite(r.minQty) || r.minQty < 0 || !Number.isFinite(r.price) || r.price < 0)) {
      toast.error(isEn ? 'Please fill in a valid quantity and price for every tier' : '请为每一档填写有效的起订量与价格')
      return
    }
    const items: OdooPricelistItem[] = rows.map(r => r.existing
      ? { ...r.existing, applyOn: 'variant', productVariantId: productId, productTemplateId: undefined, uomId, minQty: r.minQty, fixedPrice: r.price }
      : { ...emptyItem(), applyOn: 'variant', productVariantId: productId, uomId, minQty: r.minQty, computeType: 'fixed', fixedPrice: r.price })
    onSave(items)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onDiscard} />
      <div className="relative bg-white rounded shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto" style={{ border: '1px solid #ddd' }}>
        <div className="flex items-center justify-between px-6 py-3" style={{ borderBottom: '1px solid #e5e5e5' }}>
          <h2 className="text-sm font-medium text-gray-700">
            {isEn ? 'Tiered Pricing' : '阶梯价格'}
          </h2>
          <button onClick={onDiscard} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{isEn ? 'Product' : '商品'}</label>
            <ProductSearchInput<Product>
              value={productQuery}
              onChange={v => {
                setProductQuery(v)
                if (!v.trim()) { setProductId(undefined); setUomId(undefined) }
              }}
              onSelect={p => { setProductQuery(p.name); setProductId(p.id); setUomId(undefined) }}
              products={products}
              placeholder={isEn ? 'Type to search a product…' : '输入关键词搜索商品…'}
              inputClassName="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
              portalDropdown
              maxResults={30}
            />
            {isEditingExistingGroup && (
              <p className="text-[11px] text-gray-400 mt-1">
                {isEn ? 'Changing the product starts a new tier group; it won’t merge with the one you opened.' : '换了商品会另起一组阶梯，不会跟原来打开的这组合并。'}
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{isEn ? 'Sellable Unit (optional)' : '限定可售单位（可选）'}</label>
            <select
              value={uomId ?? ''}
              onChange={e => setUomId(e.target.value || undefined)}
              disabled={!productId}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B] disabled:bg-gray-50 disabled:text-gray-400"
            >
              <option value="">{isEn ? '(all units — follows the base unit price)' : '（不限定 — 所有可售单位跟随基准价联动）'}</option>
              {saleUomOptions.map(o => (
                <option key={o.uomId} value={o.uomId}>
                  {o.uomName}{o.isDefault ? (isEn ? ' (base unit)' : '（基准单位）') : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-2">{isEn ? 'Quantity tiers' : '阶梯价格'}</label>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500">
                  <th className="text-left pb-1.5 font-medium">{isEn ? 'Min. Quantity (≥)' : '起订量(≥)'}</th>
                  <th className="text-left pb-1.5 font-medium">{isEn ? 'Price (€)' : '价格(€)'}</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.key}>
                    <td className="pr-2 py-1">
                      <NumericInput
                        min={0}
                        step="any"
                        value={row.minQty}
                        onChange={e => updateRow(row.key, { minQty: e.target.value === '' ? 0 : Math.max(0, Number(e.target.value)) })}
                        className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-[#875A7B]"
                      />
                    </td>
                    <td className="pr-2 py-1">
                      <NumericInput
                        min={0}
                        step="0.01"
                        value={row.price}
                        onChange={e => updateRow(row.key, { price: e.target.value === '' ? 0 : Math.max(0, Number(e.target.value)) })}
                        className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-[#875A7B]"
                      />
                    </td>
                    <td className="py-1 text-center">
                      <span
                        onClick={() => removeRow(row.key)}
                        title={isEn ? 'Remove tier' : '删除此档'}
                        className="text-gray-300 hover:text-red-400 cursor-pointer select-none"
                      >🗑</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              onClick={addRow}
              className="mt-2 text-xs hover:underline"
              style={{ color: PURPLE }}
            >
              {isEn ? '+ Add a tier' : '+ 添加一档'}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 px-6 py-3" style={{ borderTop: '1px solid #e5e5e5' }}>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 text-white text-sm rounded font-medium hover:opacity-90"
            style={{ background: PURPLE }}
          >
            {isEn ? 'Save all tiers' : '保存全部档位'}
          </button>
          <button
            onClick={onDiscard}
            className="px-4 py-1.5 text-gray-600 text-sm border border-gray-300 rounded hover:bg-gray-50"
          >
            {isEn ? 'Cancel' : '取消'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── OdooRadio ────────────────────────────────────────────────────────────────

function OdooRadio({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center"
      style={checked
        ? { borderColor: PURPLE, background: PURPLE }
        : { borderColor: '#d1d5db', background: '#fff' }}
    >
      {checked && <span className="w-2 h-2 rounded-full bg-white block" />}
    </span>
  )
}
