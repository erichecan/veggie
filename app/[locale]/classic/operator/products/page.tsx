'use client'
import { useState, useEffect, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut, apiPatch, apiPost, apiDelete } from '@/lib/api'
import type { ProductTemplate, ProductCategory, ProductSaleUomSummary } from '@/lib/types'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'
import BulkImportDialog from '@/components/shared/BulkImportDialog'
import {
  PRODUCT_IMPORT_COLUMNS, PRODUCT_IMPORT_EXAMPLE_ROWS, PRODUCT_IMPORT_HINT, PRODUCT_IMPORT_EXTRA_HINT,
} from './product-import-columns'
import { PRODUCT_TEMPLATE_EXPORT_COLUMNS } from '@/lib/export/columns/product-templates'
import SaleUomsDialog, { type SaleUomsDialogProduct } from '@/components/classic/SaleUomsDialog'
import { type SortDir } from '@/components/shared/sort-th'
import { applyFacets, groupFacets, localizeFacetFields, PRODUCT_FACET_FIELDS, type Facet } from '@/lib/list-filters'
import { Pagination } from '@/components/ui/pagination'
import { useCsvExport } from '@/hooks/use-csv-export'
import { BUSINESS_TIMEZONE } from '@/lib/analytics/metrics'
import type { SaleUomFormRow } from '@/lib/sale-uom'
import { writeProductNavList } from '@/lib/product-nav-list'

const PAGE_SIZE = 50
const LOW_STOCK_THRESHOLD = 10

const TYPE_LABEL: Record<string, string> = {
  product: 'Storable Product',
  consu: 'Consumable',
  service: 'Service',
}

const TAX_LABEL: Record<string, string> = {
  '0': '0%',
  '0.135': '13.5%',
  '0.23': '23%',
}

const TAX_OPTIONS = [
  { value: '0', label: '0%' },
  { value: '0.135', label: '13.5%' },
  { value: '0.23', label: '23%' },
]

type StockAlertFilter = 'all' | 'negative' | 'low'

// 筛选/排序/分页状态持久化（20261001 客户反馈："进入单个产品后再回列表，刚输入的
// 过滤条件都没了"）——详情页是整页路由跳转（router.push），这个列表组件会被卸载，
// 纯 useState 挡不住状态丢失。用 sessionStorage 记一份，回到列表时原样恢复；
// 关标签页/开新标签页不带，只解决"进详情页再返回"这一种场景，足够且不会让筛选
// 意外地跨会话长期粘住。
const PRODUCTS_FILTER_STORAGE_KEY = 'products-list-filters-v1'

interface SavedProductsListState {
  searchInput: string
  columnFilters: Record<string, string>
  columnMultiFilters: Record<string, string[]>
  canBeSoldFilter: boolean
  productTypeFilter: string
  stockAlertFilter: StockAlertFilter
  showArchived: boolean
  archivedOnlyFilter: boolean
  sortKey: string
  sortDir: SortDir
  facets: Facet[]
  page: number
  pageSize: number
}

function readSavedProductsListState(): Partial<SavedProductsListState> | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(PRODUCTS_FILTER_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeSavedProductsListState(state: SavedProductsListState) {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(PRODUCTS_FILTER_STORAGE_KEY, JSON.stringify(state))
  } catch { /* 隐私模式/存储禁用/已满——丢了就丢了，不是关键功能 */ }
}

export default function ClassicProductsPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale
  const emptyLabel = isEn ? '(empty)' : '（空）'
  const [templates, setTemplates] = useState<ProductTemplate[]>([])
  // Forecast Quantity 实时值：Product.forecastQty 是导入时定格的死字段，不会随收货/出货变化
  // （20260904 客户反馈"收货后 forecast 不变"）。改走 /api/products/forecast 现算，
  // 与订单/报价单详情页用的是同一个接口、同一套口径。
  const [forecastMap, setForecastMap] = useState<Map<string, { forecast: number; qtyOnHand: number }>>(new Map())
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [multiSelectOptions, setMultiSelectOptions] = useState<{ uomName: string[]; updatedBy: string[] }>({ uomName: [], updatedBy: [] })
  // 可售单位弹窗（20260908）：uoms 是弹窗里单位下拉的候选列表，跟商品详情页共用同一个 /api/uoms
  const [uoms, setUoms] = useState<{ id: string; name: string; nameZh?: string | null; categoryId?: string }[]>([])
  const [uomDialogProduct, setUomDialogProduct] = useState<SaleUomsDialogProduct | null>(null)
  const [savedFilterState] = useState(readSavedProductsListState)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [page, setPage] = useState(savedFilterState?.page ?? 1)
  const [pageSize, setPageSize] = useState(savedFilterState?.pageSize ?? PAGE_SIZE)
  const [alertCounts, setAlertCounts] = useState({ negative: 0, low: 0 })
  const [searchInput, setSearchInput] = useState(savedFilterState?.searchInput ?? '')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>(savedFilterState?.columnFilters ?? {})
  const [columnMultiFilters, setColumnMultiFilters] = useState<Record<string, string[]>>(savedFilterState?.columnMultiFilters ?? {})
  const [canBeSoldFilter, setCanBeSoldFilter] = useState(savedFilterState?.canBeSoldFilter ?? false)
  const [productTypeFilter, setProductTypeFilter] = useState(savedFilterState?.productTypeFilter ?? '')
  const [stockAlertFilter, setStockAlertFilter] = useState<StockAlertFilter>(savedFilterState?.stockAlertFilter ?? 'all')
  // 归档商品默认不显示（20260819）：客户曾在归档商品上配了半天规格，
  // 回到报价页却搜不到 —— 下单选品只取 ACTIVE，而这里过去把归档的一起列出来。
  const [showArchived, setShowArchived] = useState(savedFilterState?.showArchived ?? false)
  // "仅已归档"(20261001 客户反馈)：跟上面"含已归档"是同一个 status 筛选参数的两档不同取值
  // (不传=只要在售, all=在售+归档都要, archived=只要归档)，互斥——开一个要把另一个关掉。
  const [archivedOnlyFilter, setArchivedOnlyFilter] = useState(savedFilterState?.archivedOnlyFilter ?? false)
  // Read / Edit 是整个列表页唯一的模式真相：顶部 Mode 按钮与下方「快速编辑」按钮共用它，
  // 表格的行内编辑也由它开关。此前两者各持一个 state，导致顶部显示 Edit 但单元格仍改不了。
  const [isReadMode, setIsReadMode] = useState(true)
  const editMode = !isReadMode
  const [groupBy, setGroupBy] = useState('')
  const [sortKey, setSortKey] = useState(savedFilterState?.sortKey ?? 'name')
  const [sortDir, setSortDir] = useState<SortDir>(savedFilterState?.sortDir ?? 'asc')
  const [alertDismissed, setAlertDismissed] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // Odoo 式分面：同一维度可累积多个关键词(OR)，不同维度之间 AND(后端 buildFacetWhere 保证)
  const [facets, setFacets] = useState<Facet[]>(savedFilterState?.facets ?? [])

  function addFacet(key: string, value: string) {
    const field = PRODUCT_FACET_FIELDS.find(f => f.key === key)
    if (!field) return
    setFacets(prev => [...prev, { key, label: isEn ? field.labelEn : field.label, value }])
  }
  function removeFacetGroup(key: string) {
    setFacets(prev => prev.filter(f => f.key !== key))
  }

  // 所有筛选(库存告警/列筛选/Can be Sold/商品类型)都编码成请求参数交给后端做，
  // 后端两步查(聚合定位 id → 按 id 分页)，绝不一次性拉全量模板到前端。
  const queryParams = useMemo(() => {
    const params = new URLSearchParams()
    // 不传 status = 后端默认排除 ARCHIVED；status=all 连归档一起返回；status=archived 只要归档
    if (archivedOnlyFilter) params.set('status', 'archived')
    else if (showArchived) params.set('status', 'all')
    if (canBeSoldFilter) params.set('canBeSold', '1')
    if (stockAlertFilter !== 'all') params.set('stockAlert', stockAlertFilter)
    const typeSet = new Set([...(columnMultiFilters.type ?? []), ...(productTypeFilter ? [productTypeFilter] : [])])
    if (typeSet.size > 0) params.set('cfm_type', [...typeSet].join(','))
    for (const [key, val] of Object.entries(columnFilters)) {
      if (val) params.set(`cf_${key}`, val)
    }
    for (const [key, vals] of Object.entries(columnMultiFilters)) {
      if (key === 'type') continue // 已合并进上面的 cfm_type
      if (vals && vals.length > 0) params.set(`cfm_${key}`, vals.join(','))
    }
    applyFacets(params, facets)
    // 排序是整个筛选结果集的排序（服务端 orderBy），不是只对当前这一页重排——
    // 否则翻页/换排序方向时，看到的顺序会跟其余 5000+ 条商品脱节（20260907 客户反馈：
    // 按 Last Updated on 排序时，同一天改的商品没有排在一起，散落在好几页里）
    if (sortKey) { params.set('sortKey', sortKey); params.set('sortDir', sortDir) }
    return params.toString()
  }, [showArchived, archivedOnlyFilter, canBeSoldFilter, productTypeFilter, stockAlertFilter, columnFilters, columnMultiFilters, facets, sortKey, sortDir])

  // 导出：吃的就是 queryParams —— 与列表请求同一份筛选参数，同一份 where 构造，
  // 所以导出的是当前筛选下的**全部**结果，不是屏幕上这 50 条。
  // 勾了行（选中了具体商品）时改成只导出勾选的那些——传 ids= 短路其余筛选条件
  // （见 lib/products-query.ts），所见即所得，不用先把筛选调到刚好只剩这几条。
  const exportAction = useCsvExport({
    entity: 'product-templates',
    params: () => {
      if (selected.size > 0) return new URLSearchParams({ ids: [...selected].join(',') })
      const params = new URLSearchParams(queryParams)
      if (searchInput) params.set('search', searchInput)
      return params
    },
    fallbackFilename: isEn ? 'products.csv' : '商品.csv',
    columns: PRODUCT_TEMPLATE_EXPORT_COLUMNS,
  })
  const exportActionLabeled = selected.size > 0
    ? { ...exportAction, label: isEn ? `Export (${selected.size} selected)` : `导出(已选 ${selected.size})` }
    : exportAction

  // 勾选了具体商品时，permanentActions 里的导出按钮只导出勾选的那些(所见即所得)。
  // 但勾选框一次最多勾到当前页(pageSize 上限 200)，客户反馈"导出全部"在有勾选时
  // 够不到 200 条之外的商品(20261001)——另开一个不理会 selected、永远按当前筛选
  // 导出全量的入口，只在有勾选时出现在 Actions 下拉里，跟"导出(已选 N)"并列，
  // 不勾选时 permanentActions 的"导出"本来就是全量，不用重复摆一个。
  const exportAllAction = useCsvExport({
    entity: 'product-templates',
    params: () => {
      const params = new URLSearchParams(queryParams)
      if (searchInput) params.set('search', searchInput)
      return params
    },
    fallbackFilename: isEn ? 'products.csv' : '商品.csv',
    columns: PRODUCT_TEMPLATE_EXPORT_COLUMNS,
  })

  // 批量操作(20261001)：勾选商品后弹出 Actions 下拉，逐条复用现有单条接口(创建/改状态/删除)，
  // 不新开批量后端路由——跟本次会话里订单/采购单批量导入同一个思路(见那两处提交)。
  // 顺序执行而不是 Promise.all：有限并发能跑得更快，但顺序执行足够简单可靠，批量对象
  // 上限就是当前页的行数(pageSize，默认 50)，串行也不会慢到不可接受。
  const [bulkRunning, setBulkRunning] = useState(false)
  async function runBulkAction(confirmMsg: string | null, fn: (row: ProductTemplate) => Promise<void>) {
    if (selected.size === 0 || bulkRunning) return
    if (confirmMsg && !window.confirm(confirmMsg)) return
    setBulkRunning(true)
    const rows = templates.filter(t => selected.has(t.id))
    let success = 0
    const failures: string[] = []
    for (const row of rows) {
      try {
        await fn(row)
        success++
      } catch (e) {
        failures.push(`${row.name}: ${e instanceof Error ? e.message : (isEn ? 'failed' : '失败')}`)
      }
    }
    setBulkRunning(false)
    setSelected(new Set())
    if (failures.length === 0) {
      toast.success(isEn ? `Done — ${success} succeeded` : `完成，成功 ${success} 条`)
    } else {
      toast.warning(
        isEn
          ? `${success} succeeded, ${failures.length} failed: ${failures.slice(0, 5).join('; ')}${failures.length > 5 ? '…' : ''}`
          : `成功 ${success} 条，失败 ${failures.length} 条：${failures.slice(0, 5).join('；')}${failures.length > 5 ? '…' : ''}`,
      )
    }
    loadPage(page, searchInput)
  }

  function bulkDuplicate() {
    return runBulkAction(
      isEn ? `Duplicate ${selected.size} selected products?` : `复制这 ${selected.size} 个商品？`,
      async (row) => {
        // 跟商品详情页单条复制(handleDuplicate)同一套排除字段：id/时间戳/externalId(唯一约束)/
        // qtyOnHand(库存是物理状态不是"内容"，新商品从 0 开始)；saleUoms 单独摘出来接可售单位创建。
        const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, externalId: _externalId, qtyOnHand: _qtyOnHand, saleUoms, ...fields } = row
        const created = await apiPost<ProductTemplate>('/api/products', {
          ...fields,
          name: `${row.name} (duplicated)`,
          createdAt: new Date().toISOString(),
        })
        if (saleUoms && saleUoms.length > 0) {
          await apiPut(`/api/products/${created.id}/sale-uoms`, {
            items: saleUoms.map(u => ({
              uomId: u.uomId, isDefault: u.isDefault, factor: u.factor, active: u.active, sequence: u.sequence, spec: u.spec,
            })),
          })
        }
      },
    )
  }

  function bulkArchive(archived: boolean) {
    return runBulkAction(
      // 归档影响下单/报价选品，批量操作前确认一下；恢复是低风险操作，跟详情页单条
      // Active 开关(点了就生效、不二次确认)保持一致，不额外挡一道。
      archived ? (isEn ? `Archive ${selected.size} selected products?` : `归档这 ${selected.size} 个商品？`) : null,
      (row) => apiPut(`/api/products/${row.id}`, { status: archived ? 'archived' : 'active' }),
    )
  }

  function bulkDelete() {
    return runBulkAction(
      isEn
        ? `Permanently delete ${selected.size} selected products? This cannot be undone. Products already used in sales/purchases will be reported as failed instead (delete them individually to see why, or archive them).`
        : `永久删除这 ${selected.size} 个商品？此操作不可撤销。已在销售/采购中用过的会报失败(不会被跳过归档)——逐条查看失败原因，或改用归档。`,
      (row) => apiDelete(`/api/products/${row.id}`),
    )
  }

  async function loadPage(p: number, q: string, ps: number = pageSize) {
    setLoading(true)
    try {
      const params = new URLSearchParams(queryParams)
      params.set('page', String(p))
      params.set('pageSize', String(ps))
      if (q) params.set('search', q)
      const res = await apiGet<{
        data: ProductTemplate[]; items: ProductTemplate[]; total: number; page: number; pageSize: number
        totalPages: number; alertCounts: { negative: number; low: number }
      }>(`/api/products?${params}`)
      const source = res.data ?? res.items ?? []
      setTemplates(source.map(t => {
        const uom = (t as unknown as { uom?: { name: string; nameZh?: string | null } }).uom
        return {
          ...t,
          status: (t.status as string).toLowerCase() as ProductTemplate['status'],
          type: (t.type as string).toLowerCase() as ProductTemplate['type'],
          uomName: (isEn ? (uom?.name ?? uom?.nameZh) : (uom?.nameZh ?? uom?.name)) ?? undefined,
        }
      }))
      setTotal(res.total)
      setPage(res.page)
      setPageSize(res.pageSize ?? ps)
      setTotalPages(res.totalPages)
      setAlertCounts(res.alertCounts ?? { negative: 0, low: 0 })

      const ids = source.map(t => t.id).filter(Boolean)
      if (ids.length > 0) {
        apiGet<{ productId: string; forecast: number; qtyOnHand: number }[]>(`/api/products/forecast?ids=${ids.join(',')}`)
          .then(rows => {
            const m = new Map<string, { forecast: number; qtyOnHand: number }>()
            rows.forEach(r => m.set(r.productId, r))
            setForecastMap(m)
          }).catch(() => {})
      } else {
        setForecastMap(new Map())
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load products' : '加载商品失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    apiGet<ProductCategory[]>('/api/product-categories').then(setCategories).catch(() => {})
    apiGet<{ uomName: string[]; updatedBy: string[] }>('/api/products/filter-options')
      .then(setMultiSelectOptions).catch(() => {})
    apiGet<{ id: string; name: string; nameZh?: string | null; categoryId?: string }[]>('/api/uoms')
      .then(setUoms).catch(() => {})
    // page/searchInput 这时已经是懒初始化时从 sessionStorage 恢复出来的值(如果有)，
    // 不再硬编码 loadPage(1, '')——否则从详情页返回时会先闪一下"未筛选的第 1 页"。
    loadPage(page, searchInput)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // searchMountedRef 跳过首次挂载：上面那个 effect 已经用恢复出来的 page/searchInput
  // 拉过一次了，这里如果不跳过，400ms 后会用硬编码的 page=1 再拉一次，把刚恢复的页码
  // 悄悄冲掉（20261001 修"返回列表丢筛选"时顺带发现的连带 bug）。
  const searchMountedRef = useRef(false)
  useEffect(() => {
    if (!searchMountedRef.current) { searchMountedRef.current = true; return }
    const timer = setTimeout(() => loadPage(1, searchInput), 400)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  // 筛选条件变化(库存告警/Can be Sold/商品类型/列筛选)时重新拉第 1 页。
  // mountedRef 跳过首次挂载，避免与上面初始加载重复请求。
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    loadPage(1, searchInput)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryParams])

  // 把筛选/排序/分页状态写回 sessionStorage，供下次挂载（如"进商品详情页再返回"）
  // 时原样恢复。写的时机在 mount 时也会跑一遍，属于无害的"原样写回"。
  useEffect(() => {
    writeSavedProductsListState({
      searchInput, columnFilters, columnMultiFilters, canBeSoldFilter, productTypeFilter,
      stockAlertFilter, showArchived, archivedOnlyFilter, sortKey, sortDir, facets, page, pageSize,
    })
  }, [searchInput, columnFilters, columnMultiFilters, canBeSoldFilter, productTypeFilter,
      stockAlertFilter, showArchived, archivedOnlyFilter, sortKey, sortDir, facets, page, pageSize])

  // 排序已经由后端做（按整个筛选结果集排序，见 loadPage 里的 sortKey/sortDir 参数，
  // Product Category 列传的 sortKey 是 'categoryLabel'，后端按 category 关系的 name 排序）
  const filteredTemplates = templates

  // ─── 单元格保存：调 PUT /api/products/[id]，并刷新本地 row ──
  async function handleCellEdit(row: Record<string, unknown>, key: string, newValue: unknown) {
    const t = row as unknown as ProductTemplate
    // Product Spec 列（20260912 改造）：Product.spec 已废弃清空，这列改读/写默认单位的
    // ProductSaleUom.spec —— 走可售单位的 PATCH 接口，不是商品自己的 PUT，否则会把值
    // 写回那个没人再读的废字段。多单位商品只改得到默认单位，其它单位仍要去可售单位弹窗改。
    if (key === 'spec') {
      const def = t.saleUoms?.find(u => u.isDefault)
      if (!def) {
        toast.error(isEn ? 'This product has no configured sale unit to edit' : '该商品还没配置可售单位，无法在这里编辑')
        throw new Error('no default sale unit')
      }
      const specVal = newValue == null || newValue === '' ? null : String(newValue).trim() || null
      try {
        await apiPatch(`/api/products/${t.id}/sale-uoms/${def.uomId}`, { spec: specVal })
        setTemplates(prev => prev.map(row => row.id === t.id
          ? { ...row, saleUoms: row.saleUoms?.map(u => u.uomId === def.uomId ? { ...u, spec: specVal } : u) }
          : row))
        toast.success(isEn ? 'Saved' : '已保存')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
        throw e
      }
      return
    }
    let payloadVal: unknown = newValue
    if (['listPrice', 'standardPrice', 'commissionPrice', 'weight'].includes(key)) {
      const n = Number(newValue)
      if (!Number.isFinite(n) || n < 0) {
        toast.error(isEn ? 'Please enter a valid non-negative number' : '请输入合法的非负数字')
        throw new Error('invalid number')
      }
      payloadVal = n
    }
    if (['customerTaxRate', 'vendorTaxRate'].includes(key)) {
      const n = Number(newValue)
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        toast.error(isEn ? 'Tax rate must be between 0 and 1' : '税率须在 0–1 之间')
        throw new Error('invalid tax rate')
      }
      payloadVal = n
    }
    try {
      await apiPut(`/api/products/${t.id}`, { [key]: payloadVal })
      setTemplates(prev => prev.map(row => row.id === t.id ? { ...row, [key]: payloadVal } as ProductTemplate : row))
      toast.success(isEn ? 'Saved' : '已保存')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
      throw e
    }
  }

  // ─── 行级背景色：负库存 = 浅红，低库存 = 浅橙 ───
  function getRowStyle(row: Record<string, unknown>): React.CSSProperties | undefined {
    const t = row as unknown as ProductTemplate
    const qty = t.qtyOnHand ?? 0
    if (qty < 0) return { background: '#fff1f2' }
    if (qty < LOW_STOCK_THRESHOLD) return { background: '#fffbeb' }
    return undefined
  }

  // ─── 「装货顺序」列（20260908 建列 / 20260912 改为展示 pack sequence 而非单位名 /
  // 20260930 改为列出全部单位的顺序数字，而非"默认单位顺序 +N"）───
  // 之前"默认单位顺序 +N"的写法有个真实的坑：客户在弹窗里只改了非默认单位(如 BOTTLE)
  // 的装货顺序，默认单位(如 CASE)的数字没变，这一列看着就跟没保存一样——"+1"还容易被
  // 读成箭头"→1"。改成把每个单位的顺序数字都列出来(逗号分隔)，改了哪个单位、改成几，
  // 列表上直接就能看见，不用再靠弹窗里的"+N"去猜。
  function saleUnitName(u: ProductSaleUomSummary): string {
    return isEn ? (u.uom.name || u.uom.nameZh || '') : (u.uom.nameZh || u.uom.name || '')
  }
  function saleUnitSequenceLabel(u: ProductSaleUomSummary): string {
    return u.sequence != null ? String(u.sequence) : '—'
  }
  // 管理可售单位是弹窗动作,不是行内文本编辑——不该跟随 Quick Edit 开关(否则默认
  // 关着的时候点这列毫无反应,点击反而被行点击接管跳去详情页,20260910 客户反馈实测踩坑)。
  function renderSaleUnitsBadge(row: ProductTemplate) {
    const list = row.saleUoms ?? []
    if (list.length === 0) return <span className="text-gray-300 text-xs">—</span>
    const def = list.find(u => u.isDefault) ?? list[0]
    const tooltip = list.map(u => `${saleUnitName(u)}: ${saleUnitSequenceLabel(u)}`).join(' · ')
    const sorted = list.length > 1
      ? [...list].sort((a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER))
      : list
    const label = list.length === 1 ? saleUnitSequenceLabel(def) : sorted.map(u => saleUnitSequenceLabel(u)).join(',')
    const isMulti = list.length > 1
    return (
      <button
        type="button"
        title={isEn ? `${tooltip} — click to manage` : `${tooltip} — 点击管理`}
        onClick={e => {
          e.stopPropagation()
          setUomDialogProduct({ id: row.id, name: row.name, uomId: row.uomId, listPrice: row.listPrice, commissionPrice: row.commissionPrice ?? null })
        }}
        className={isMulti
          ? 'inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors'
          : 'text-xs text-gray-600 hover:text-[#875A7B] hover:underline'}
      >
        {label}
      </button>
    )
  }

  // spec 列背后写的是默认 ProductSaleUom.spec（见 handleCellEdit 的 'spec' 分支），商品没有
  // 配置可售单位（或没有默认单位）时后端必定拒绝；跟 by-sale-unit 页同一个坑，改成按行禁用。
  const hasDefaultSaleUnit = (row: Record<string, unknown>) =>
    !!(row as unknown as ProductTemplate).saleUoms?.some(u => u.isDefault)
  const noDefaultSaleUnitHint = () => (isEn
    ? 'This product has no configured sale unit yet — open "Sellable Units" to add one'
    : '该商品还没配置可售单位，请先点击「装货顺序」列打开可售单位弹窗添加')

  const columns: OdooColumn[] = [
    {
      key: 'productNo',
      width: 64,
      label: isEn ? 'No.' : '编号',
      // 20261001 客户反馈：放大镜点开弹窗搜索太绕，改成跟 Name 列一样的行内输入框
      // （OdooTable 表头下面那行 filterType:'text' 专用的输入行）。
      filterType: 'text',
      sortable: true,
      render: (v) => <span className="text-xs text-gray-400">{v != null ? String(v) : ''}</span>,
    },
    {
      key: 'internalRef',
      width: 84,
      label: 'Internal Reference',
      filterType: 'text',
      sortable: true,
      editable: true,
      editType: 'text',
      render: (v) => <span className="font-mono text-xs text-gray-500">{String(v || '')}</span>,
    },
    {
      // 不设 width 会让这列按最长商品名无上限撑开（无 table-fixed，浏览器自动布局
      // 只在有显式 width 时才收窄换行），是横向滚动条的最大来源，故这里给硬上限。
      key: 'name',
      width: 260,
      label: 'Name',
      filterType: 'text',
      sortable: true,
      editable: true,
      editType: 'text',
      render: (v, row) => {
        const t = row as unknown as ProductTemplate
        return (
          <div className="flex items-center gap-2">
            {(t.images?.[0]) && (
              <img
                src={t.images[0]}
                alt=""
                className="w-8 h-8 object-cover rounded border border-gray-200 flex-shrink-0"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            )}
            <span className="font-medium" style={{ color: '#875A7B' }}>{String(v ?? '')}</span>
            {t.canBeSold && (
              <span
                className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] flex-shrink-0"
                style={{ background: '#d1fae5', color: '#059669' }}
                title={isEn ? 'Can be Sold' : '可售'}
              >
                ✓
              </span>
            )}
          </div>
        )
      },
    },
    {
      key: 'saleDescription',
      width: 145,
      label: 'Sale Description',
      filterType: 'text',
      editable: true,
      editType: 'text',
      render: (v) => v ? <span className="text-xs text-gray-500 truncate max-w-xs block">{String(v)}</span> : <span className="text-gray-300">—</span>,
    },
    {
      // Product.spec 已废弃清空（20260912），这列改显示/编辑默认可售单位的 spec
      // （如"6*2kg"）——见 handleCellEdit 里的特殊分支。没有配置可售单位的商品这里恒为空，
      // 不能在这内联编辑，按行禁用（跟 by-sale-unit 页的 uomId 守卫同款，20261001 修）。
      key: 'spec',
      width: 95,
      label: 'Product Spec',
      align: 'center',
      editable: hasDefaultSaleUnit,
      editDisabledHint: noDefaultSaleUnitHint,
      editType: 'text',
      render: (_v, row) => {
        const spec = (row as unknown as ProductTemplate).saleUoms?.find(u => u.isDefault)?.spec
        return spec ? <span className="text-xs text-gray-600">{spec}</span> : <span className="text-gray-300">—</span>
      },
    },
    {
      key: 'listPrice',
      width: 70,
      label: 'Sale Price',
      align: 'center',
      filterType: 'text',
      sortable: true,
      editable: true,
      editType: 'number',
      render: (v) => <span>€{Number(v).toFixed(2)}</span>,
    },
    {
      key: 'customerTaxRate',
      width: 60,
      label: 'Customer Taxes',
      filterType: 'multi-select',
      editable: true,
      editType: 'select',
      editOptions: TAX_OPTIONS,
      filterOptions: TAX_OPTIONS,
      filterLabelGetter: (val) => TAX_LABEL[val] ?? (val ? `${(Number(val) * 100).toFixed(0)}%` : emptyLabel),
      render: (v) => (
        <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
          {TAX_LABEL[String(v)] ?? `${(Number(v) * 100).toFixed(0)}%`}
        </span>
      ),
    },
    {
      key: 'standardPrice',
      width: 70,
      label: 'Cost',
      align: 'center',
      filterType: 'text',
      sortable: true,
      editable: true,
      editType: 'number',
      render: (v) => <span>€{Number(v ?? 0).toFixed(2)}</span>,
    },
    {
      key: 'vendorTaxRate',
      width: 60,
      label: 'Vendor Taxes',
      filterType: 'multi-select',
      editable: true,
      editType: 'select',
      editOptions: [{ value: '', label: '—' }, ...TAX_OPTIONS],
      filterOptions: [{ value: '', label: emptyLabel }, ...TAX_OPTIONS],
      filterLabelGetter: (val) => TAX_LABEL[val] ?? (val ? `${(Number(val) * 100).toFixed(0)}%` : emptyLabel),
      render: (v) => v != null ? (
        <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
          {TAX_LABEL[String(v)] ?? `${(Number(v) * 100).toFixed(0)}%`}
        </span>
      ) : <span className="text-gray-300">—</span>,
    },
    {
      key: 'weight',
      width: 66,
      label: 'Weight',
      align: 'center',
      filterType: 'text',
      sortable: true,
      editable: true,
      editType: 'number',
      render: (v) => v != null ? <span className="text-xs">{Number(v).toFixed(2)} kg</span> : <span className="text-gray-400">—</span>,
    },
    {
      // 只读提示灯，不走通用的行内编辑机制（管理走点击弹窗，见 renderSaleUnitsBadge）
      // 20260912：sortKey 此前误用 saleUnitsCount（按可售单位个数排），跟列名毫无关系，
      // 改成真按装货顺序值排（见 lib/products-query.ts 的 packSequence）。
      key: 'saleUoms',
      width: 80,
      label: 'Pack Sequence',
      align: 'center',
      sortable: true,
      sortKey: 'packSequence',
      render: (_, row) => renderSaleUnitsBadge(row as unknown as ProductTemplate),
    },
    {
      // Quantity On Hand 是实时计算值(后端按 templateId 聚合后逐行附加到 qtyOnHand)，
      // 没有稳定的原始字段可供通用文本筛选匹配，故此列不给筛选框(Odoo 原版这一列同样没有)。
      key: 'id',
      width: 72,
      label: 'Quantity On Hand',
      render: (_, row) => {
        const t = row as unknown as ProductTemplate
        const qty = t.qtyOnHand ?? 0
        if (qty < 0) {
          return (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-700">
              ⚠ {qty.toFixed(1)}
            </span>
          )
        }
        if (qty < LOW_STOCK_THRESHOLD) {
          return (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-700">
              ↓ {qty.toFixed(1)}
            </span>
          )
        }
        return <span className={qty > 0 ? 'font-medium text-gray-700' : 'text-gray-400'}>{qty.toFixed(1)}</span>
      },
    },
    {
      key: 'forecastQty',
      width: 62,
      label: 'Forecast Quantity',
      // 实时值来自 forecastMap（/api/products/forecast），不再是 DB 里那个只在导入时
      // 赋过值、此后永不更新的 forecastQty 死字段，所以这里不再提供子串筛选——
      // 筛的是数据库旧值、显示的是现算值，两边对不上比没有筛选更糟。
      render: (_, row) => {
        const t = row as unknown as ProductTemplate
        const fc = forecastMap.get(t.id)
        return fc != null ? <span>{fc.forecast.toFixed(1)}</span> : <span className="text-gray-400">—</span>
      },
    },
    {
      key: 'categoryId',
      width: 110,
      label: 'Product Category',
      filterType: 'text',
      // 排序按显示名称传参(categoryLabel)，而非裸 categoryId——后端映射成按 category 关系的 name 排序
      sortable: true,
      sortKey: 'categoryLabel',
      editable: true,
      editType: 'select',
      editOptions: [
        { value: '', label: '—' },
        ...categories.map(c => ({ value: c.id, label: (isEn ? (c.name || c.nameZh) : (c.nameZh || c.name)) ?? c.name })),
      ],
      render: (v) => {
        const cat = categories.find(c => c.id === String(v ?? ''))
        const label = (isEn ? (cat?.name || cat?.nameZh) : (cat?.nameZh || cat?.name)) ?? (v ? String(v) : '—')
        return <span className="text-xs text-gray-600">{label}</span>
      },
    },
    {
      key: 'commissionPrice',
      width: 70,
      label: 'Commission Price',
      filterType: 'text',
      editable: true,
      editType: 'number',
      render: (v) => v != null ? <span>€{Number(v).toFixed(2)}</span> : <span className="text-gray-400">—</span>,
    },
    {
      key: 'updatedBy',
      width: 84,
      label: 'Last Updated by',
      filterType: 'multi-select',
      // ⛔ 这里曾经把空值兜底显示成写死的 'Administrator'——PUT /api/products/[id] 此前从不回写
      // 这个字段，编辑商品的人显示的却是一个不存在的固定假名，误导排查（20260902 客户反馈）。
      // 现在 PUT/POST 已补上真实写入，这里的兜底改回诚实的"空"，不再编造身份。
      filterOptions: multiSelectOptions.updatedBy.map(v => ({ value: v, label: v || emptyLabel })),
      filterLabelGetter: (val) => val || emptyLabel,
      render: (v) => <span className="text-xs text-gray-500">{v ? String(v) : <span className="text-gray-300">—</span>}</span>,
    },
    {
      key: 'updatedAt',
      width: 76,
      label: 'Last Updated on',
      sortable: true,
      filterType: 'date-range',
      render: (v) => v ? <span className="text-xs text-gray-500">{new Date(String(v)).toLocaleDateString('en-GB', { timeZone: BUSINESS_TIMEZONE })}</span> : <span className="text-gray-400">—</span>,
    },
  ]

  const activeMultiCount = Object.values(columnMultiFilters).reduce((n, arr) => n + (arr?.length ?? 0), 0)
  const hasAlerts = alertCounts.negative > 0 || alertCounts.low > 0

  return (
    <div>
      <OdooControlPanel
        breadcrumb={isEn ? ['Inventory', 'Products'] : ['库存', '商品']}
        onNew={() => router.push(`${prefix}/classic/operator/products/new`)}
        newLabel={isEn ? 'New' : '新建'}
        permanentActions={[
          { label: isEn ? 'Import' : '导入', onClick: () => setImportOpen(true) },
          exportActionLabeled,
          ...(isReadMode
            ? [
                { label: 'Mode', onClick: () => setIsReadMode(false) },
                { label: 'Read', onClick: () => {}, primary: true },
              ]
            : [
                { label: 'Edit', onClick: () => {}, primary: true },
                { label: 'Mode', onClick: () => setIsReadMode(true) },
              ]),
        ]}
        actions={selected.size > 0 ? [
          { label: exportActionLabeled.label, onClick: exportActionLabeled.onClick, disabled: bulkRunning },
          { label: isEn ? 'Export All (matching filter)' : '导出全部(按当前筛选)', onClick: exportAllAction.onClick, disabled: bulkRunning || exportAllAction.disabled },
          { label: isEn ? 'Duplicate' : '复制', onClick: bulkDuplicate, disabled: bulkRunning },
          { label: isEn ? 'Archive' : '归档', onClick: () => bulkArchive(true), disabled: bulkRunning },
          { label: isEn ? 'Unarchive' : '恢复', onClick: () => bulkArchive(false), disabled: bulkRunning },
          { label: isEn ? 'Delete' : '删除', onClick: bulkDelete, disabled: bulkRunning, style: 'red' as const },
        ] : []}
        searchValue={searchInput}
        onSearch={setSearchInput}
        onSearchSubmit={() => loadPage(1, searchInput)}
        facetFields={localizeFacetFields(PRODUCT_FACET_FIELDS, isEn)}
        onFacetAdd={addFacet}
        activeFilters={[
          ...groupFacets(facets).map(g => ({ label: g.chipLabel, values: g.values, prefix: g.key === 'all' ? undefined : g.label, onRemove: () => removeFacetGroup(g.key) })),
          ...(showArchived ? [{ label: isEn ? 'Incl. archived' : '含已归档', onRemove: () => setShowArchived(false) }] : []),
          ...(archivedOnlyFilter ? [{ label: isEn ? 'Archived Only' : '仅已归档', onRemove: () => setArchivedOnlyFilter(false) }] : []),
          ...(canBeSoldFilter ? [{ label: 'Can be Sold', onRemove: () => setCanBeSoldFilter(false) }] : []),
          ...(productTypeFilter ? [{ label: TYPE_LABEL[productTypeFilter] ?? productTypeFilter, onRemove: () => setProductTypeFilter('') }] : []),
          ...(stockAlertFilter !== 'all' ? [{
            label: stockAlertFilter === 'negative' ? (isEn ? '⚠ Negative Stock' : '⚠ 负库存') : (isEn ? '↓ Low Stock' : '↓ 低库存'),
            onRemove: () => setStockAlertFilter('all'),
          }] : []),
          ...(activeMultiCount > 0 ? [{ label: isEn ? `Column filters (${activeMultiCount})` : `列筛选 (${activeMultiCount})`, onRemove: () => setColumnMultiFilters({}) }] : []),
        ]}
        filterOptions={[
          { label: 'Can be Sold', value: 'canBeSold' },
          { label: 'Storable Product', value: 'product' },
          { label: 'Consumable', value: 'consu' },
          { label: 'Service', value: 'service' },
          { label: isEn ? 'Archived Only' : '仅已归档', value: 'archivedOnly' },
        ]}
        activeFilterValues={[
          ...(canBeSoldFilter ? ['canBeSold'] : []),
          ...(productTypeFilter ? [productTypeFilter] : []),
          ...(archivedOnlyFilter ? ['archivedOnly'] : []),
        ]}
        onFilterSelect={(v) => {
          if (v === 'canBeSold') setCanBeSoldFilter(prev => !prev)
          else if (v === 'archivedOnly') setArchivedOnlyFilter(prev => { const next = !prev; if (next) setShowArchived(false); return next })
          else setProductTypeFilter(prev => prev === v ? '' : v)
        }}
        groupByOptions={[
          { label: isEn ? 'Product Type' : '商品类型', value: 'type' },
          { label: isEn ? 'Product Category' : '商品分类', value: 'category' },
        ]}
        groupByValue={groupBy}
        onGroupByChange={v => setGroupBy(prev => prev === v ? '' : v)}
        favouriteState={{ searchInput, showArchived, archivedOnlyFilter, canBeSoldFilter, productTypeFilter, stockAlertFilter, groupBy, facets, columnFilters, columnMultiFilters }}
        onFavouriteApply={s => {
          setSearchInput(String(s.searchInput ?? ''))
          setShowArchived(Boolean(s.showArchived))
          setArchivedOnlyFilter(Boolean(s.archivedOnlyFilter))
          setCanBeSoldFilter(Boolean(s.canBeSoldFilter))
          setProductTypeFilter(String(s.productTypeFilter ?? ''))
          setStockAlertFilter((s.stockAlertFilter as StockAlertFilter) ?? 'all')
          setGroupBy(String(s.groupBy ?? ''))
          // 分面搜索(name/ref/category/description)与列头筛选此前没进收藏，收藏"pepper veg"这类
          // 靠分面搜出来的筛选结果，点开收藏等于什么都没恢复(客户反馈"收藏的筛选条件不起作用")
          setFacets(Array.isArray(s.facets) ? (s.facets as Facet[]) : [])
          setColumnFilters((s.columnFilters as Record<string, string>) ?? {})
          setColumnMultiFilters((s.columnMultiFilters as Record<string, string[]>) ?? {})
          setPage(1)
        }}
        storageKey="classic_products_favs"
        total={total}
        page={page}
        pageSize={pageSize}
        onPageChange={p => loadPage(p, searchInput)}
        onPageSizeChange={ps => loadPage(1, searchInput, ps)}
      />

      {/* ─── 库存告警横幅 ─── */}
      {hasAlerts && !alertDismissed && (
        <div className="mx-4 mt-3 rounded border flex items-start gap-3 px-4 py-3"
          style={{ background: '#fff7ed', borderColor: '#fed7aa' }}>
          <span className="text-lg leading-none mt-0.5">⚠️</span>
          <div className="flex-1 text-sm">
            <span className="font-semibold text-orange-800">{isEn ? 'Stock Alert' : '库存预警'}</span>
            <span className="text-orange-700 ml-2">
              {alertCounts.negative > 0 && (
                <>
                  <span className="font-semibold text-red-600">{alertCounts.negative}</span>
                  <span>{isEn ? ' products with negative stock' : ' 种商品库存为负'}</span>
                </>
              )}
              {alertCounts.negative > 0 && alertCounts.low > 0 && <span className="mx-1">{isEn ? ',' : '，'}</span>}
              {alertCounts.low > 0 && (
                <>
                  <span className="font-semibold text-amber-600">{alertCounts.low}</span>
                  <span>{isEn ? ` products below safety stock (<${LOW_STOCK_THRESHOLD})` : ` 种商品低于安全库存（<${LOW_STOCK_THRESHOLD}）`}</span>
                </>
              )}
            </span>
            <span className="ml-3 space-x-2">
              {alertCounts.negative > 0 && (
                <button
                  onClick={() => { setStockAlertFilter('negative'); setAlertDismissed(true) }}
                  className="text-xs font-medium underline text-red-600 hover:text-red-800"
                >
                  {isEn ? 'View negative stock →' : '查看负库存 →'}
                </button>
              )}
              {alertCounts.low > 0 && (
                <button
                  onClick={() => { setStockAlertFilter('low'); setAlertDismissed(true) }}
                  className="text-xs font-medium underline text-amber-600 hover:text-amber-800"
                >
                  {isEn ? 'View low stock →' : '查看低库存 →'}
                </button>
              )}
            </span>
          </div>
          <button
            onClick={() => setAlertDismissed(true)}
            className="text-orange-400 hover:text-orange-600 text-base leading-none"
            title={isEn ? 'Close' : '关闭'}
          >
            ✕
          </button>
        </div>
      )}

      {/* ─── 工具栏：快速编辑 + 库存筛选 pills ─── */}
      <div className="px-4 pt-3 pb-1 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => setIsReadMode(v => !v)}
          aria-pressed={editMode}
          className="h-8 px-3 text-sm rounded border transition-colors flex items-center gap-1.5"
          style={{
            background: editMode ? '#875A7B' : 'white',
            borderColor: editMode ? '#875A7B' : '#d1d5db',
            color: editMode ? 'white' : '#4b5563',
          }}
          title={isEn ? 'When on, click editable fields in the list to edit directly, without opening the product detail page' : '开启后，可单击列表中可编辑字段直接修改，无需打开商品详情页'}
        >
          <span style={{ fontSize: 13 }}>✏️</span>
          {editMode ? (isEn ? 'Quick Edit (On)' : '快速编辑（已开启）') : (isEn ? 'Quick Edit' : '快速编辑')}
        </button>

        {/* 库存筛选 pills */}
        <div className="flex items-center gap-1.5 ml-2">
          {(
            [
              { value: 'all', label: isEn ? 'All' : '全部', color: undefined },
              { value: 'negative', label: isEn ? '⚠ Negative Stock' : '⚠ 负库存', color: 'red' },
              { value: 'low', label: isEn ? '↓ Low Stock' : '↓ 低库存', color: 'amber' },
            ] as { value: StockAlertFilter; label: string; color: string | undefined }[]
          ).map(({ value, label, color }) => {
            const active = stockAlertFilter === value
            const styles: Record<string, React.CSSProperties> = {
              red: { background: active ? '#fee2e2' : 'white', borderColor: active ? '#f87171' : '#d1d5db', color: active ? '#dc2626' : '#6b7280' },
              amber: { background: active ? '#fef3c7' : 'white', borderColor: active ? '#fbbf24' : '#d1d5db', color: active ? '#d97706' : '#6b7280' },
            }
            const defaultStyle: React.CSSProperties = { background: active ? '#f3eff5' : 'white', borderColor: active ? '#875A7B' : '#d1d5db', color: active ? '#875A7B' : '#6b7280' }
            return (
              <button
                key={value}
                type="button"
                onClick={() => setStockAlertFilter(value)}
                className="h-7 px-2.5 text-xs rounded border transition-colors font-medium"
                style={color ? styles[color] : defaultStyle}
              >
                {label}
                {value === 'negative' && alertCounts.negative > 0 && (
                  <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full text-xs font-bold bg-red-500 text-white"
                    style={{ fontSize: 10 }}>
                    {alertCounts.negative}
                  </span>
                )}
                {value === 'low' && alertCounts.low > 0 && (
                  <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full text-xs font-bold bg-amber-500 text-white"
                    style={{ fontSize: 10 }}>
                    {alertCounts.low}
                  </span>
                )}
              </button>
            )
          })}

          {/* 归档商品开关：默认关 —— 归档 = 停售，不该混在在售商品里让人误编辑 */}
          <button
            type="button"
            onClick={() => { setShowArchived(v => !v); setArchivedOnlyFilter(false) }}
            className="h-7 px-2.5 text-xs rounded border transition-colors font-medium ml-1"
            style={showArchived
              ? { background: '#f3eff5', borderColor: '#875A7B', color: '#875A7B' }
              : { background: 'white', borderColor: '#d1d5db', color: '#6b7280' }}
            title={isEn
              ? 'Archived products never appear in order / quotation product pickers'
              : '已归档商品不会出现在下单 / 报价的选品中'}
          >
            {showArchived ? (isEn ? '✓ Incl. archived' : '✓ 含已归档') : (isEn ? 'Incl. archived' : '含已归档')}
          </button>

          {/* 可售商品开关：与顶部筛选下拉的 Can be Sold 项共用同一个 state */}
          <button
            type="button"
            onClick={() => setCanBeSoldFilter(v => !v)}
            className="h-7 px-2.5 text-xs rounded border transition-colors font-medium ml-1"
            style={canBeSoldFilter
              ? { background: '#d1fae5', borderColor: '#10b981', color: '#059669' }
              : { background: 'white', borderColor: '#d1d5db', color: '#6b7280' }}
            title={isEn ? 'Show only products that can be sold' : '只显示可售商品'}
          >
            {canBeSoldFilter ? (isEn ? '✓ Can be Sold' : '✓ 可售商品') : (isEn ? 'Can be Sold' : '可售商品')}
          </button>
        </div>

        {/* 按可售单位查看商品（20260912）：入口按钮放这一行工具栏最后——每个可售单位
            单独一行展开显示，客户反馈原来塞进「Pack Sequence」列点开的弹窗不够直观。 */}
        <button
          type="button"
          onClick={() => router.push(`${prefix}/classic/operator/products/by-sale-unit`)}
          className="h-7 px-2.5 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors font-medium ml-auto"
        >
          {isEn ? 'View by Sale Unit' : '按可售单位查看商品'}
        </button>

        {editMode && (
          <span className="text-xs text-gray-500">
            {isEn ? (
              <><strong style={{ color: '#875A7B' }}>Click</strong> a purple-background cell to edit, press Enter or click elsewhere to save, Esc to cancel.</>
            ) : (
              <><strong style={{ color: '#875A7B' }}>单击</strong>紫色背景列即可编辑，回车或点击其他位置保存，Esc 取消。</>
            )}
          </span>
        )}
      </div>

      <div className="p-4 overflow-x-auto">
        <OdooTable
          columns={columns}
          rows={filteredTemplates as unknown as Record<string, unknown>[]}
          loading={loading}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={key => {
            if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
            else { setSortKey(key); setSortDir('asc') }
          }}
          selected={selected}
          onSelectAll={checked => {
            if (checked) setSelected(new Set(filteredTemplates.map(t => t.id)))
            else setSelected(new Set())
          }}
          onSelectRow={(id, checked) => {
            setSelected(prev => {
              const next = new Set(prev)
              if (checked) next.add(id)
              else next.delete(id)
              return next
            })
          }}
          onRowClick={row => {
            writeProductNavList(filteredTemplates.map(t => t.id))
            router.push(`${prefix}/classic/operator/products/${String(row.id)}`)
          }}
          emptyText={
            stockAlertFilter === 'negative'
              ? (isEn ? 'No products with negative stock' : '无负库存商品')
              : stockAlertFilter === 'low'
                ? (isEn ? 'No products with low stock' : '无低库存商品')
                : (isEn ? 'No product data' : '暂无商品数据')
          }
          columnFilters={columnFilters}
          onColumnFilterChange={(key, val) => setColumnFilters(prev => ({ ...prev, [key]: val }))}
          columnMultiFilters={columnMultiFilters}
          onColumnMultiFilterChange={(key, vals) => {
            setColumnMultiFilters(prev => {
              const next = { ...prev }
              if (vals.length === 0) delete next[key]
              else next[key] = vals
              return next
            })
          }}
          inlineEditEnabled={editMode}
          onCellEdit={handleCellEdit}
          getRowStyle={getRowStyle}
          groupByField={groupBy === 'type' ? 'type' : groupBy === 'category' ? 'categoryId' : ''}
          groupByFormatter={(key, count) => {
            let label: string
            if (groupBy === 'type') label = TYPE_LABEL[key] ?? (key || emptyLabel)
            else if (groupBy === 'category') {
              const cat = categories.find(c => c.id === key)
              label = (isEn ? (cat?.name || cat?.nameZh) : (cat?.nameZh || cat?.name)) ?? (key || emptyLabel)
            } else label = key || emptyLabel
            return <>{label} <span className="font-normal text-xs ml-1" style={{ color: '#a07898' }}>({count})</span></>
          }}
        />
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={p => loadPage(p, searchInput)} />

      <BulkImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={() => loadPage(1, searchInput)}
        templateFileName="products-import-template"
        columns={PRODUCT_IMPORT_COLUMNS}
        exampleRows={PRODUCT_IMPORT_EXAMPLE_ROWS}
        endpoint="/api/products/bulk"
        title={{ zh: '批量导入商品(CSV)', en: 'Bulk Import Products (CSV)' }}
        hint={PRODUCT_IMPORT_HINT}
        extraHint={PRODUCT_IMPORT_EXTRA_HINT}
      />
      {exportActionLabeled.dialog}
      {exportAllAction.dialog}

      <SaleUomsDialog
        open={uomDialogProduct != null}
        product={uomDialogProduct}
        uoms={uoms}
        isEn={isEn}
        onClose={() => setUomDialogProduct(null)}
        onSaved={(rows: SaleUomFormRow[]) => {
          if (!uomDialogProduct) return
          const uomMap = new Map(uoms.map(u => [u.id, u]))
          const summaries: ProductSaleUomSummary[] = rows
            .filter(r => r.active)
            .map(r => ({
              uomId: r.uomId, isDefault: r.isDefault, factor: r.factor, active: r.active, sequence: r.sequence, spec: r.spec ?? null,
              uom: { name: uomMap.get(r.uomId)?.name ?? '', nameZh: uomMap.get(r.uomId)?.nameZh },
            }))
          setTemplates(prev => prev.map(t => t.id === uomDialogProduct.id ? { ...t, saleUoms: summaries } : t))
        }}
      />
    </div>
  )
}
