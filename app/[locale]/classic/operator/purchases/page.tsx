'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { Pagination } from '@/components/ui/pagination'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useCsvExport } from '@/hooks/use-csv-export'
import { parseCsv, downloadCsv } from '@/lib/csv-export'
import { purchaseOrderExportColumns } from '@/lib/export/columns/purchase-orders'
import { isValidPurchaseTaxRate, PURCHASE_TAX_RATES } from '@/lib/purchase/tax-rates'
import { applyFacets, groupFacets, localizeFacetFields, PURCHASE_FACET_FIELDS, type Facet } from '@/lib/list-filters'
import ProcurementOverviewPage from './overview/page'
import FreshDailySuggestionsPage from './fresh/page'
import CatalogPickingPage from './catalog/page'
import AnnualPlanPage from './annual-plan/page'
import VendorsPage from './vendors/page'
import { DatePicker } from '@/components/ui/date-picker'

const PURPLE = '#875A7B'

type MainTab = 'quotations' | 'overview' | 'fresh' | 'catalog' | 'annual-plan' | 'vendors'

const MAIN_TABS_ZH: { k: MainTab; icon: string; label: string }[] = [
  { k: 'quotations', icon: '📝', label: '询价单' },
  { k: 'overview', icon: '📊', label: '总览' },
  { k: 'fresh', icon: '🥬', label: '生鲜次日备货' },
  { k: 'catalog', icon: '🛒', label: '目录挑选' },
  { k: 'annual-plan', icon: '🌾', label: '干货年度计划' },
  { k: 'vendors', icon: '🏭', label: '供应商' },
]

const MAIN_TABS_EN: { k: MainTab; icon: string; label: string }[] = [
  { k: 'quotations', icon: '📝', label: 'Quotations' },
  { k: 'overview', icon: '📊', label: 'Overview' },
  { k: 'fresh', icon: '🥬', label: 'Next-Day Fresh Stocking' },
  { k: 'catalog', icon: '🛒', label: 'Catalog Picking' },
  { k: 'annual-plan', icon: '🌾', label: 'Dry Goods Annual Plan' },
  { k: 'vendors', icon: '🏭', label: 'Vendors' },
]

type POStatus = 'DRAFT' | 'SENT' | 'CONFIRMED' | 'RECEIVED' | 'INVOICED' | 'LOCKED' | 'TO_APPROVE' | 'CANCELLED'

interface PurchaseOrder {
  id: string
  name: string
  status: POStatus
  supplierId: string
  supplierName?: string
  createdBy?: string | null
  createdByName?: string | null
  orderDate: string
  expectedDate?: string | null
  subtotalExTax: number
  totalTax: number
  totalIncTax: number
  createdAt: string
  lines: Array<{ id: string; productName: string; orderedQty: number; unitCost: number }>
}

const STATUS_LABEL_ZH: Record<POStatus, string> = {
  DRAFT:      '询价单',
  SENT:       '询价单已发送',
  TO_APPROVE: '待审批',
  CONFIRMED:  '采购订单',
  RECEIVED:   '已收货',
  INVOICED:   '已开票',
  LOCKED:     '已锁定',
  CANCELLED:  '已取消',
}

const STATUS_LABEL_EN: Record<POStatus, string> = {
  DRAFT:      'Quotation',
  SENT:       'Quotation Sent',
  TO_APPROVE: 'To Approve',
  CONFIRMED:  'Purchase Order',
  RECEIVED:   'Received',
  INVOICED:   'Invoiced',
  LOCKED:     'Locked',
  CANCELLED:  'Cancelled',
}

const STATUS_COLOR: Record<POStatus, string> = {
  DRAFT:      'bg-gray-100 text-gray-600',
  SENT:       'bg-blue-50 text-blue-700',
  TO_APPROVE: 'bg-yellow-50 text-yellow-700',
  CONFIRMED:  'bg-purple-50 text-purple-700',
  RECEIVED:   'bg-cyan-50 text-cyan-700',
  INVOICED:   'bg-green-50 text-green-700',
  LOCKED:     'bg-emerald-50 text-emerald-800',
  CANCELLED:  'bg-red-50 text-red-600',
}

const STATUS_TABS_ZH = [
  { key: 'all', label: '全部' },
  { key: 'DRAFT', label: '询价单' },
  { key: 'SENT', label: '询价单已发送' },
  { key: 'TO_APPROVE', label: '待审批' },
  { key: 'CONFIRMED', label: '采购订单' },
  { key: 'RECEIVED', label: '已收货' },
  { key: 'INVOICED', label: '已开票' },
  { key: 'LOCKED', label: '已锁定' },
  { key: 'CANCELLED', label: '已取消' },
]

const STATUS_TABS_EN = [
  { key: 'all', label: 'All' },
  { key: 'DRAFT', label: 'Quotation' },
  { key: 'SENT', label: 'Quotation Sent' },
  { key: 'TO_APPROVE', label: 'To Approve' },
  { key: 'CONFIRMED', label: 'Purchase Order' },
  { key: 'RECEIVED', label: 'Received' },
  { key: 'INVOICED', label: 'Invoiced' },
  { key: 'LOCKED', label: 'Locked' },
  { key: 'CANCELLED', label: 'Cancelled' },
]

const PAGE_SIZE = 40

const FILTER_INPUT_CLS = 'w-full border border-gray-300 rounded bg-white text-xs px-1.5 py-0.5 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-200'

function norm(s: string | null | undefined): string {
  return s ? s.toLowerCase().trim() : ''
}

// CSV 导入列定义(采购单)：中文表头为主约定，英文表头作为别名同样可被识别(匹配大小写不敏感)。
// key 是解析后 Record 的固定字段名，不随界面语言变化。
const PO_IMPORT_COLUMNS: { key: string; zh: string; en: string; required?: boolean }[] = [
  { key: 'supplier',     zh: '供应商名称', en: 'Supplier Name', required: true },
  { key: 'product',      zh: '商品名称',   en: 'Product Name',  required: true },
  { key: 'productRef',   zh: '商品编号',   en: 'Product Ref' },
  { key: 'quantity',     zh: '数量',       en: 'Quantity',      required: true },
  { key: 'unitCost',     zh: '单价',       en: 'Unit Cost',     required: true },
  { key: 'taxRate',      zh: '税率',       en: 'Tax Rate' },
  { key: 'expectedDate', zh: '预计到货',   en: 'Expected Date' },
  { key: 'notes',        zh: '备注',       en: 'Notes' },
]

export default function PurchasesPage() {
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const MAIN_TABS = isEn ? MAIN_TABS_EN : MAIN_TABS_ZH
  const STATUS_LABEL = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH
  const STATUS_TABS = isEn ? STATUS_TABS_EN : STATUS_TABS_ZH
  const [mainTab, setMainTab] = useState<MainTab>('quotations')
  const [pos, setPos] = useState<PurchaseOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [activeTab, setActiveTab] = useState('all')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [groupBy, setGroupBy] = useState('')
  // Odoo 式分面：同维度多值 OR、跨维度 AND（后端 buildFacetWhere）
  const [facets, setFacets] = useState<Facet[]>([])
  // 列头排序 + 列头筛选：全部下推服务端（只排/只筛当前页会让翻页后顺序断档、匹配记录被误判为空）
  const [sortField, setSortField] = useState('createdAt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [colSupplier, setColSupplier] = useState('')
  const [orderDateFrom, setOrderDateFrom] = useState('')
  const [orderDateTo, setOrderDateTo] = useState('')
  // 供应商筛选框防抖 400ms，避免逐字符打一次请求
  const [debouncedSupplier, setDebouncedSupplier] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSupplier(colSupplier.trim()), 400)
    return () => clearTimeout(t)
  }, [colSupplier])

  // ── Import modal ─────────────────────────────────────────────────────────
  const [showImportModal, setShowImportModal] = useState(false)
  const [importParsed, setImportParsed] = useState<Array<Record<string, string>>>([])
  const [importLoading, setImportLoading] = useState(false)
  const [importResult, setImportResult] = useState<{ success: number; failed: number; errors: string[] } | null>(null)
  const importFileRef = useRef<HTMLInputElement>(null)

  function setDateFilter(which: 'from' | 'to', value: string) {
    setPage(1)
    if (which === 'from') setOrderDateFrom(value)
    else setOrderDateTo(value)
  }

  function toggleSort(field: string) {
    setPage(1)
    if (sortField === field) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortField(field); setSortDir('asc') }
  }

  function addFacet(key: string, value: string) {
    const field = PURCHASE_FACET_FIELDS.find(f => f.key === key)
    if (!field) return
    setFacets(prev => [...prev, { key, label: isEn ? field.labelEn : field.label, value }])
  }
  function removeFacetGroup(key: string) {
    setFacets(prev => prev.filter(f => f.key !== key))
  }

  // 状态页签 + 搜索 + 分面 + 列筛选 + 排序。列表与导出共用，保证"导出的就是看到的"
  const buildParams = useCallback(() => {
    const params = new URLSearchParams()
    if (activeTab !== 'all') params.set('status', activeTab)
    if (search) params.set('search', search)
    if (debouncedSupplier) params.set('colSupplier', debouncedSupplier)
    if (orderDateFrom) params.set('orderDateFrom', orderDateFrom)
    if (orderDateTo) params.set('orderDateTo', orderDateTo)
    params.set('sortField', sortField)
    params.set('sortDir', sortDir)
    applyFacets(params, facets)
    return params
  }, [activeTab, search, debouncedSupplier, orderDateFrom, orderDateTo, sortField, sortDir, facets])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = buildParams()
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String((page - 1) * PAGE_SIZE))
      const data = await apiGet<{ items: PurchaseOrder[]; total: number }>(`/api/purchase-orders?${params}`)
      setPos(data.items ?? (data as unknown as PurchaseOrder[]))
      setTotal(data.total ?? (data as unknown as PurchaseOrder[]).length)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [buildParams, page, isEn])

  // 导出与列表同参（状态页签 + 搜索 + 分面），服务端复用同一个 buildPurchaseOrdersWhere
  const exportAction = useCsvExport({
    entity: 'purchase-orders',
    params: buildParams,
    fallbackFilename: isEn ? 'purchase-orders.csv' : '采购单.csv',
    columns: (isEn: boolean) => purchaseOrderExportColumns(isEn),
  })

  useEffect(() => { load() }, [load])

  // ── CSV import helpers ────────────────────────────────────────────────────

  function downloadImportTemplate() {
    const headers = PO_IMPORT_COLUMNS.map(c => isEn ? c.en : c.zh)
    const sample = isEn
      ? ['Supplier A', 'Cabbage', '', '10', '2.50', '23', '', '']
      : ['Supplier A', '白菜', '', '10', '2.50', '23', '', '']
    downloadCsv(isEn ? 'purchase_order_import_template' : '采购单导入模板', headers, [sample])
  }

  // 共享的健壮 CSV 解析器(引号包裹字段/内嵌逗号换行/BOM/CRLF)；表头按中/英文列名匹配
  // (大小写不敏感)后统一映射到固定 key 上，下游逻辑不关心上传文件用的是哪种语言的表头。
  function parseImportCSV(text: string): Array<Record<string, string>> {
    const rows = parseCsv(text)
    if (rows.length < 2) return []
    const header = rows[0].map(h => h.trim().toLowerCase())
    const colIdx = new Map<string, number>()
    for (const c of PO_IMPORT_COLUMNS) {
      const idx = header.findIndex(h => h === c.zh.toLowerCase() || h === c.en.toLowerCase())
      if (idx >= 0) colIdx.set(c.key, idx)
    }
    return rows.slice(1).map(r => {
      const row: Record<string, string> = {}
      for (const [key, idx] of colIdx) row[key] = (r[idx] ?? '').trim()
      return row
    })
  }

  function handleImportFile(file: File) {
    const reader = new FileReader()
    reader.onload = e => {
      const text = e.target?.result as string
      setImportParsed(parseImportCSV(text))
      setImportResult(null)
    }
    reader.readAsText(file, 'utf-8')
  }

  async function handleImportSubmit() {
    if (!importParsed.length) return
    setImportLoading(true)
    setImportResult(null)

    // 供应商 = Customer 里 isVendor=true 的那批；不传 pageSize 走legacy 扁平数组分支，
    // 一次拿到全部匹配行，不会像分页接口那样只搜到第一页。
    let vendors: Array<{ id: string; name: string }> = []
    // 商品匹配沿用报价单导入同一套口径：优先按商品编号(internalRef)，其次按名称精确匹配。
    let products: Array<{ id: string; name: string; internalRef?: string | null }> = []
    try {
      [vendors, products] = await Promise.all([
        apiGet<typeof vendors>('/api/customers?isVendor=1&slim=1'),
        apiGet<typeof products>('/api/products?slim=1'),
      ])
    } catch { /* ignore — 会在下方按"未找到"逐组报错 */ }

    function findProduct(productRef: string, productName: string) {
      if (productRef) {
        const byRef = products.find(p => p.internalRef && norm(p.internalRef) === norm(productRef))
        if (byRef) return byRef
      }
      return products.find(p => norm(p.name) === norm(productName)) ?? null
    }

    // 按供应商名分组，构建采购单
    const groups = new Map<string, typeof importParsed>()
    for (const row of importParsed) {
      const key = row.supplier?.trim()
      if (!key) continue
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }

    let success = 0
    const errors: string[] = []

    for (const [supplierName, rows] of groups) {
      const vendor = vendors.find(v => norm(v.name) === norm(supplierName))
      if (!vendor) { errors.push(isEn ? `Supplier not found: ${supplierName}` : `找不到供应商: ${supplierName}`); continue }

      const lines: Array<{ productId: string; productName: string; orderedQty: number; unitCost: number; taxRate: number }> = []
      const missingProducts: string[] = []
      const invalidRows: string[] = []

      for (const row of rows) {
        const productName = row.product?.trim() || ''
        if (!productName) continue
        const productRef = row.productRef?.trim() || ''
        const quantity = parseFloat(row.quantity)
        const unitCost = parseFloat(row.unitCost)
        const taxRateRaw = row.taxRate?.trim()
        const taxRate = taxRateRaw ? parseFloat(taxRateRaw) : 0

        if (!row.quantity?.trim() || !row.unitCost?.trim()) {
          invalidRows.push(isEn ? `${productName}: quantity and unit cost are required` : `${productName}: 数量和单价为必填项`)
          continue
        }
        // 数量/单价的范围校验(>0、0~1,000,000)留给服务端(POST /api/purchase-orders → createPurchaseOrder)
        // 统一把关——那里的报错信息本来就带商品名，直接透传比在这里另写一套校验话术更可靠。
        // 税率单独在这里先挡一道：它是枚举值而不是范围，服务端报错话术("税率只能是 0%/13.5%/23%")
        // 不点名是哪一行，客户端能拿到 productName 给出更精确的提示。
        if (!isValidPurchaseTaxRate(taxRate)) {
          invalidRows.push(isEn
            ? `${productName}: tax rate must be one of ${PURCHASE_TAX_RATES.join('/')}`
            : `${productName}: 税率只能是 ${PURCHASE_TAX_RATES.join('/')}`)
          continue
        }
        const matched = findProduct(productRef, productName)
        if (!matched) { missingProducts.push(productName); continue }
        lines.push({ productId: matched.id, productName, orderedQty: quantity, unitCost, taxRate })
      }

      if (missingProducts.length || invalidRows.length) {
        const parts: string[] = []
        if (missingProducts.length) {
          parts.push(isEn ? `product not found — ${missingProducts.join(', ')}` : `商品未找到 — ${missingProducts.join('、')}`)
        }
        if (invalidRows.length) parts.push(invalidRows.join('; '))
        errors.push(`${supplierName}: ${parts.join('; ')}`)
        continue
      }
      if (!lines.length) {
        errors.push(isEn ? `${supplierName}: no valid item rows` : `${supplierName}: 无有效商品行`)
        continue
      }

      const expectedDate = rows[0].expectedDate?.trim() || undefined
      const notes = rows[0].notes?.trim() || undefined

      try {
        await apiPost('/api/purchase-orders', {
          supplierId: vendor.id,
          lines,
          expectedDate,
          notes,
        })
        success++
      } catch (e) {
        errors.push(`${supplierName}: ${e instanceof Error ? e.message : (isEn ? 'Creation failed' : '创建失败')}`)
      }
    }

    setImportResult({ success, failed: errors.length, errors })
    setImportLoading(false)
    if (success > 0) {
      toast.success(isEn ? `Successfully imported ${success} purchase orders` : `成功导入 ${success} 个采购单`)
      load()
    }
  }

  function handleTabChange(tab: string) {
    setActiveTab(tab)
    setPage(1)
    setSelected(new Set())
  }

  function toggleAll() {
    if (selected.size === pos.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(pos.map(p => p.id)))
    }
  }

  function toggleOne(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }



  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* 品类工作台入口（同页切换，不跳转，参考库存管理页） */}
      <div className="flex gap-2 px-4 pt-3 pb-1 flex-wrap bg-gray-50">
        {MAIN_TABS.map(t => {
          const on = mainTab === t.k
          return (
            <button
              key={t.k}
              onClick={() => setMainTab(t.k)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border bg-white hover:shadow-sm transition-all"
              style={on ? { borderColor: PURPLE, color: PURPLE, background: '#f3eff5' } : { borderColor: '#e5e7eb', color: '#6b7280' }}
            >
              <span>{t.icon}</span>{t.label}
            </button>
          )
        })}
      </div>

      {mainTab === 'overview' && <ProcurementOverviewPage />}
      {mainTab === 'fresh' && <FreshDailySuggestionsPage />}
      {mainTab === 'catalog' && <CatalogPickingPage />}
      {mainTab === 'annual-plan' && <AnnualPlanPage />}
      {mainTab === 'vendors' && <VendorsPage />}

      {mainTab === 'quotations' && <>
      <OdooControlPanel
        breadcrumb={isEn ? ['Purchases', 'Quotations'] : ['采购', '询价单']}
        permanentActions={[
          exportAction,
          { label: isEn ? 'Import' : '导入', onClick: () => { setShowImportModal(true); setImportParsed([]); setImportResult(null) } },
          { label: isEn ? 'New' : '新建', onClick: () => router.push('purchases/new'), primary: true },
        ]}
        searchValue={searchInput}
        onSearch={v => setSearchInput(v)}
        onSearchSubmit={() => { setSearch(searchInput); setPage(1) }}
        facetFields={localizeFacetFields(PURCHASE_FACET_FIELDS, isEn)}
        onFacetAdd={addFacet}
        activeFilters={[
          ...groupFacets(facets).map(g => ({ label: g.chipLabel, onRemove: () => removeFacetGroup(g.key) })),
          ...(activeTab !== 'all' ? [{ label: isEn ? `Status: ${STATUS_LABEL[activeTab as POStatus] ?? activeTab}` : `状态：${STATUS_LABEL[activeTab as POStatus] ?? activeTab}`, onRemove: () => handleTabChange('all') }] : []),
        ]}
        filterOptions={STATUS_TABS.filter(t => t.key !== 'all').map(t => ({ label: t.label, value: t.key }))}
        onFilterSelect={v => handleTabChange(v)}
        groupByOptions={[
          { label: isEn ? 'Supplier' : '供应商', value: 'supplier' },
          { label: isEn ? 'Status' : '状态', value: 'status' },
          { label: isEn ? 'Order Date' : '订购日期', value: 'orderDate' },
          { label: isEn ? 'Created By' : '录入人', value: 'createdBy' },
        ]}
        groupByValue={groupBy}
        onGroupByChange={v => setGroupBy(prev => prev === v ? '' : v)}
        favouriteState={{ searchInput, activeTab, groupBy, facets, sortField, sortDir, colSupplier, orderDateFrom, orderDateTo }}
        onFavouriteApply={s => {
          setSearchInput(String(s.searchInput ?? ''))
          setSearch(String(s.searchInput ?? ''))
          handleTabChange(String(s.activeTab ?? 'all'))
          setGroupBy(String(s.groupBy ?? ''))
          // 分面搜索(单号/供应商/商品/备注)此前没进收藏，与商品页同一个坑
          setFacets(Array.isArray(s.facets) ? (s.facets as Facet[]) : [])
          // 列头排序/列筛选也进收藏——否则"存下来的视图"跟当时看到的顺序和筛选对不上
          setSortField(String(s.sortField ?? 'createdAt'))
          setSortDir(s.sortDir === 'asc' ? 'asc' : 'desc')
          setColSupplier(String(s.colSupplier ?? ''))
          setOrderDateFrom(String(s.orderDateFrom ?? ''))
          setOrderDateTo(String(s.orderDateTo ?? ''))
        }}
        storageKey="classic_purchases_favs"
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={p => setPage(p)}
      />

      {/* Table */}
      <div className="flex-1 overflow-auto relative">
        {loading && pos.length > 0 && (
          <div className="absolute top-0 left-0 right-0 h-0.5 overflow-hidden z-20">
            <div className="h-full w-1/3 animate-pulse" style={{ background: '#875A7B' }} />
          </div>
        )}
        {loading && pos.length === 0 ? (
          <div className="flex items-center justify-center py-24 text-gray-400">
            <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: '#875A7B' }} />
            {isEn ? 'Loading...' : '加载中...'}
          </div>
        ) : pos.length === 0 ? (
          <div className="py-24 text-center text-gray-400 text-sm">{isEn ? 'No purchase orders' : '暂无采购单'}</div>
        ) : (
          <table className="w-full text-sm border-collapse bg-white">
            <thead>
              <tr className="border-b border-gray-200" style={{ background: '#f9f9f9' }}>
                <th className="w-10 px-3 py-2.5 text-center">
                  <input
                    type="checkbox"
                    checked={selected.size === pos.length && pos.length > 0}
                    onChange={toggleAll}
                    className="w-3.5 h-3.5 accent-purple-700 cursor-pointer"
                  />
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">{isEn ? 'No.' : '编号'}</th>
                <th
                  className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs cursor-pointer select-none hover:bg-gray-100"
                  onClick={() => toggleSort('supplier')}
                >
                  <span className="inline-flex items-center gap-1">
                    {isEn ? 'Supplier' : '供应商'}
                    {sortField === 'supplier' && <span className="text-[10px]" style={{ color: PURPLE }}>{sortDir === 'asc' ? '▲' : '▼'}</span>}
                  </span>
                </th>
                <th
                  className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs cursor-pointer select-none hover:bg-gray-100"
                  onClick={() => toggleSort('orderDate')}
                >
                  <span className="inline-flex items-center gap-1">
                    {isEn ? 'Order Date' : '订购日期'}
                    {sortField === 'orderDate' && <span className="text-[10px]" style={{ color: PURPLE }}>{sortDir === 'asc' ? '▲' : '▼'}</span>}
                  </span>
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">{isEn ? 'Expected Arrival' : '预计到货'}</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">{isEn ? 'Source Document' : '来源单据'}</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">{isEn ? 'Status' : '状态'}</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">{isEn ? 'Created By' : '录入人'}</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">{isEn ? 'Amount Ex. Tax' : '税前金额'}</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">{isEn ? 'Total Inc. Tax' : '含税总额'}</th>
              </tr>
              {/* 列筛选行：供应商模糊 + 订购日期区间，与分面 chip 独立（彼此 AND），均走服务端 */}
              <tr className="border-b border-gray-200 bg-white">
                <td className="w-10 px-3 py-1.5 text-center text-gray-300">✎</td>
                <td className="px-4 py-1.5" />
                <td className="px-4 py-1.5">
                  <input
                    value={colSupplier}
                    onChange={e => { setPage(1); setColSupplier(e.target.value) }}
                    placeholder={isEn ? 'Filter supplier' : '筛选供应商'}
                    className={FILTER_INPUT_CLS}
                  />
                </td>
                <td className="px-4 py-1.5">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-gray-400 w-8">{isEn ? 'From' : '起'}</span>
                    <DatePicker value={orderDateFrom} onChange={v => setDateFilter('from', v)} className={FILTER_INPUT_CLS} clearable={false} />
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-[10px] text-gray-400 w-8">{isEn ? 'To' : '止'}</span>
                    <DatePicker value={orderDateTo} onChange={v => setDateFilter('to', v)} className={FILTER_INPUT_CLS} clearable={false} />
                  </div>
                </td>
                <td className="px-4 py-1.5" />
                <td className="px-4 py-1.5" />
                <td className="px-4 py-1.5" />
                <td className="px-4 py-1.5" />
                <td className="px-4 py-1.5" />
                <td className="px-4 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {(() => {
                const GB_FIELD: Record<string, keyof PurchaseOrder> = {
                  supplier: 'supplierName',
                  status: 'status',
                  orderDate: 'orderDate',
                  createdBy: 'createdByName',
                }
                const field = GB_FIELD[groupBy]
                const renderRow = (po: PurchaseOrder) => (
                  <tr
                    key={po.id}
                    onClick={() => router.push(`purchases/${po.id}`)}
                    className="cursor-pointer border-b border-gray-100 hover:bg-blue-50 transition-colors"
                    style={{ background: selected.has(po.id) ? '#f0f0ff' : undefined }}
                  >
                    <td className="w-10 px-3 py-2.5 text-center" onClick={e => { e.stopPropagation(); toggleOne(po.id) }}>
                      <input
                        type="checkbox"
                        checked={selected.has(po.id)}
                        onChange={() => toggleOne(po.id)}
                        className="w-3.5 h-3.5 accent-purple-700 cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-2.5 font-medium" style={{ color: '#875A7B' }}>{po.name}</td>
                    <td className="px-4 py-2.5 text-gray-700">{po.supplierName ?? po.supplierId}</td>
                    <td className="px-4 py-2.5 text-gray-500">
                      {po.orderDate ? new Date(po.orderDate).toLocaleDateString('en-GB') : '-'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500">
                      {po.expectedDate ? new Date(po.expectedDate).toLocaleDateString('en-GB') : '-'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400">-</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block px-2 py-0.5 rounded-sm text-xs font-medium ${STATUS_COLOR[po.status]}`}>
                        {STATUS_LABEL[po.status]}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-700">{po.createdByName ?? '-'}</td>
                    <td className="px-4 py-2.5 text-right text-gray-700">{Number(po.subtotalExTax).toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-right font-medium text-gray-900">{Number(po.totalIncTax).toFixed(2)}</td>
                  </tr>
                )
                if (!groupBy || !field) return pos.map(renderRow)
                const groups = new Map<string, PurchaseOrder[]>()
                for (const po of pos) {
                  const key = String(po[field] ?? '')
                  if (!groups.has(key)) groups.set(key, [])
                  groups.get(key)!.push(po)
                }
                return Array.from(groups.entries()).flatMap(([key, groupPos]) => [
                  <tr key={`__group__${key}`} style={{ background: '#f5f0f7', borderBottom: '2px solid #d4b8d0' }}>
                    <td colSpan={10} className="px-3 py-1.5 font-semibold text-sm" style={{ color: '#6d4a66' }}>
                      {groupBy === 'status' ? STATUS_LABEL[key as POStatus] ?? key
                        : groupBy === 'orderDate' ? (key ? new Date(key).toLocaleDateString('en-GB') : (isEn ? '(None)' : '（空）'))
                        : key || (isEn ? '(None)' : '（空）')}
                      {' '}<span className="font-normal text-xs ml-1" style={{ color: '#a07898' }}>({groupPos.length})</span>
                    </td>
                  </tr>,
                  ...groupPos.map(renderRow),
                ])
              })()}
            </tbody>
          </table>
        )}
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </div>

      {exportAction.dialog}

      {/* ── Import Modal ── */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowImportModal(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900">{isEn ? 'Import Purchase Orders (CSV)' : '导入采购单 (CSV)'}</h2>
              <button onClick={() => setShowImportModal(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
            </div>
            <div className="px-5 py-4 space-y-4">
              {/* Template download */}
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-600">{isEn ? '1. Download the template, fill in data, then upload' : '1. 下载模板，填写数据后上传'}</span>
                <button
                  onClick={downloadImportTemplate}
                  className="px-3 py-1 text-xs rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                >
                  {isEn ? '↓ Download Template' : '↓ 下载模板'}
                </button>
              </div>

              {/* File input */}
              <div>
                <span className="text-sm text-gray-600 block mb-2">{isEn ? '2. Select CSV file' : '2. 选择 CSV 文件'}</span>
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="text-sm text-gray-600 file:mr-3 file:px-3 file:py-1 file:rounded file:border file:border-gray-300 file:bg-white file:text-xs file:text-gray-700 file:hover:bg-gray-50 file:cursor-pointer"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f) }}
                />
              </div>

              {/* Preview table */}
              {importParsed.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">{isEn ? `Preview (first 5 of ${importParsed.length} rows):` : `预览（前 5 行，共 ${importParsed.length} 行）：`}</p>
                  <div className="overflow-x-auto border rounded">
                    <table className="text-xs w-full">
                      <thead>
                        <tr className="bg-gray-50 border-b">
                          {PO_IMPORT_COLUMNS.map(c => <th key={c.key} className="px-2 py-1 text-left font-medium text-gray-600 whitespace-nowrap">{isEn ? c.en : c.zh}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {importParsed.slice(0, 5).map((row, i) => (
                          <tr key={i} className="border-b last:border-0">
                            {PO_IMPORT_COLUMNS.map(c => <td key={c.key} className="px-2 py-1 text-gray-700 whitespace-nowrap">{row[c.key] || '—'}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Import result */}
              {importResult && (
                <div className={`rounded-lg px-4 py-3 text-sm ${importResult.failed === 0 ? 'bg-green-50 text-green-800' : 'bg-yellow-50 text-yellow-800'}`}>
                  <p className="font-medium">{isEn ? `${importResult.success} purchase orders succeeded, ${importResult.failed} failed` : `成功 ${importResult.success} 个采购单，失败 ${importResult.failed} 个`}</p>
                  {importResult.errors.length > 0 && (
                    <ul className="mt-1 list-disc list-inside text-xs space-y-0.5 text-red-700">
                      {importResult.errors.map((err, i) => <li key={i}>{err}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-200">
              <button onClick={() => setShowImportModal(false)} className="px-4 py-2 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
                {isEn ? 'Close' : '关闭'}
              </button>
              <button
                onClick={handleImportSubmit}
                disabled={importParsed.length === 0 || importLoading}
                className="px-4 py-2 text-sm rounded text-white disabled:opacity-50"
                style={{ background: PURPLE }}
              >
                {importLoading ? (isEn ? 'Importing…' : '导入中…') : (isEn ? `Import ${importParsed.length} rows` : `导入 ${importParsed.length} 行`)}
              </button>
            </div>
          </div>
        </div>
      )}

      </>}
    </div>
  )
}
