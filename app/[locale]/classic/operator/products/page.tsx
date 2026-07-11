'use client'
import { useState, useEffect, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import type { ProductTemplate, ProductCategory } from '@/lib/types'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'
import CsvImportDialog from '@/components/classic/CsvImportDialog'
import { sortRows, type SortDir } from '@/components/shared/sort-th'
import { Pagination } from '@/components/ui/pagination'

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

const TYPE_OPTIONS = [
  { value: 'product', label: 'Storable Product' },
  { value: 'consu', label: 'Consumable' },
  { value: 'service', label: 'Service' },
]

type StockAlertFilter = 'all' | 'negative' | 'low'

export default function ClassicProductsPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const [templates, setTemplates] = useState<ProductTemplate[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [multiSelectOptions, setMultiSelectOptions] = useState<{ uomName: string[]; createdBy: string[]; updatedBy: string[] }>({ uomName: [], createdBy: [], updatedBy: [] })
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [page, setPage] = useState(1)
  const [alertCounts, setAlertCounts] = useState({ negative: 0, low: 0 })
  const [searchInput, setSearchInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({})
  const [columnMultiFilters, setColumnMultiFilters] = useState<Record<string, string[]>>({})
  const [canBeSoldFilter, setCanBeSoldFilter] = useState(false)
  const [productTypeFilter, setProductTypeFilter] = useState('')
  const [stockAlertFilter, setStockAlertFilter] = useState<StockAlertFilter>('all')
  const [quickEditMode, setQuickEditMode] = useState(false)
  const [isReadMode, setIsReadMode] = useState(true)
  const [groupBy, setGroupBy] = useState('')
  const [sortKey, setSortKey] = useState('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [alertDismissed, setAlertDismissed] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  // 所有筛选(库存告警/列筛选/Can be Sold/商品类型)都编码成请求参数交给后端做，
  // 后端两步查(聚合定位 id → 按 id 分页)，绝不一次性拉全量模板到前端。
  const queryParams = useMemo(() => {
    const params = new URLSearchParams()
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
    return params.toString()
  }, [canBeSoldFilter, productTypeFilter, stockAlertFilter, columnFilters, columnMultiFilters])

  async function loadPage(p: number, q: string) {
    setLoading(true)
    try {
      const params = new URLSearchParams(queryParams)
      params.set('page', String(p))
      params.set('pageSize', String(PAGE_SIZE))
      if (q) params.set('search', q)
      const res = await apiGet<{
        data: ProductTemplate[]; items: ProductTemplate[]; total: number; page: number
        totalPages: number; alertCounts: { negative: number; low: number }
      }>(`/api/product-templates?${params}`)
      const source = res.data ?? res.items ?? []
      setTemplates(source.map(t => {
        const uom = (t as unknown as { uom?: { name: string; nameZh?: string | null } }).uom
        return {
          ...t,
          status: (t.status as string).toLowerCase() as ProductTemplate['status'],
          type: (t.type as string).toLowerCase() as ProductTemplate['type'],
          uomName: uom?.nameZh ?? uom?.name,
        }
      }))
      setTotal(res.total)
      setPage(res.page)
      setTotalPages(res.totalPages)
      setAlertCounts(res.alertCounts ?? { negative: 0, low: 0 })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载商品失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    apiGet<ProductCategory[]>('/api/product-categories').then(setCategories).catch(() => {})
    apiGet<{ uomName: string[]; createdBy: string[]; updatedBy: string[] }>('/api/product-templates/filter-options')
      .then(setMultiSelectOptions).catch(() => {})
    loadPage(1, '')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
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

  // 排序只在当前页内进行(与订单/报价单列表页一致的服务端分页限制：排序、筛选不跨页)
  const filteredTemplates = useMemo(() => sortRows(templates, sortKey, sortDir), [templates, sortKey, sortDir])

  // ─── 单元格保存：调 PUT /api/product-templates/[id]，并刷新本地 row ──
  async function handleCellEdit(row: Record<string, unknown>, key: string, newValue: unknown) {
    const t = row as unknown as ProductTemplate
    let payloadVal: unknown = newValue
    if (['listPrice', 'standardPrice', 'commissionPrice', 'weight', 'sequence'].includes(key)) {
      const n = Number(newValue)
      if (!Number.isFinite(n) || n < 0) {
        toast.error('请输入合法的非负数字')
        throw new Error('invalid number')
      }
      payloadVal = n
    }
    if (['customerTaxRate', 'vendorTaxRate'].includes(key)) {
      const n = Number(newValue)
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        toast.error('税率须在 0–1 之间')
        throw new Error('invalid tax rate')
      }
      payloadVal = n
    }
    try {
      await apiPut(`/api/product-templates/${t.id}`, { [key]: payloadVal })
      setTemplates(prev => prev.map(row => row.id === t.id ? { ...row, [key]: payloadVal } as ProductTemplate : row))
      toast.success('已保存')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
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

  const columns: OdooColumn[] = [
    {
      key: 'internalRef',
      label: 'Internal Reference',
      filterType: 'text',
      sortable: true,
      editable: true,
      editType: 'text',
      render: (v) => <span className="font-mono text-xs text-gray-500">{String(v || '')}</span>,
    },
    {
      key: 'externalId',
      label: 'ID',
      filterType: 'text',
      sortable: true,
      render: (v) => <span className="text-xs text-gray-500 font-mono">{v ? String(v) : '—'}</span>,
    },
    {
      key: 'sequence',
      label: 'Sequence',
      filterType: 'text',
      sortable: true,
      editable: true,
      editType: 'number',
      render: (v) => <span className="text-xs text-gray-500">{v != null ? String(v) : '0'}</span>,
    },
    {
      key: 'name',
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
          </div>
        )
      },
    },
    {
      key: 'saleDescription',
      label: 'Sale Description',
      filterType: 'text',
      editable: true,
      editType: 'text',
      render: (v) => v ? <span className="text-xs text-gray-500 truncate max-w-xs block">{String(v)}</span> : <span className="text-gray-300">—</span>,
    },
    {
      key: 'listPrice',
      label: 'Sale Price',
      filterType: 'text',
      sortable: true,
      editable: true,
      editType: 'number',
      render: (v) => <span>€{Number(v).toFixed(2)}</span>,
    },
    {
      key: 'customerTaxRate',
      label: 'Customer Taxes',
      filterType: 'multi-select',
      editable: true,
      editType: 'select',
      editOptions: TAX_OPTIONS,
      filterOptions: TAX_OPTIONS,
      filterLabelGetter: (val) => TAX_LABEL[val] ?? (val ? `${(Number(val) * 100).toFixed(0)}%` : '（空）'),
      render: (v) => (
        <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
          {TAX_LABEL[String(v)] ?? `${(Number(v) * 100).toFixed(0)}%`}
        </span>
      ),
    },
    {
      key: 'standardPrice',
      label: 'Cost',
      filterType: 'text',
      sortable: true,
      editable: true,
      editType: 'number',
      render: (v) => <span>€{Number(v ?? 0).toFixed(2)}</span>,
    },
    {
      key: 'vendorTaxRate',
      label: 'Vendor Taxes',
      filterType: 'multi-select',
      editable: true,
      editType: 'select',
      editOptions: [{ value: '', label: '—' }, ...TAX_OPTIONS],
      filterOptions: [{ value: '', label: '（空）' }, ...TAX_OPTIONS],
      filterLabelGetter: (val) => TAX_LABEL[val] ?? (val ? `${(Number(val) * 100).toFixed(0)}%` : '（空）'),
      render: (v) => v != null ? (
        <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
          {TAX_LABEL[String(v)] ?? `${(Number(v) * 100).toFixed(0)}%`}
        </span>
      ) : <span className="text-gray-300">—</span>,
    },
    {
      key: 'weight',
      label: 'Weight',
      filterType: 'text',
      sortable: true,
      editable: true,
      editType: 'number',
      render: (v) => v != null ? <span className="text-xs">{Number(v).toFixed(2)} kg</span> : <span className="text-gray-400">—</span>,
    },
    {
      // Quantity On Hand 是实时计算值(后端按 templateId 聚合后逐行附加到 qtyOnHand)，
      // 没有稳定的原始字段可供通用文本筛选匹配，故此列不给筛选框(Odoo 原版这一列同样没有)。
      key: 'id',
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
      label: 'Forecast Quantity',
      filterType: 'text',
      render: (v) => v != null ? <span>{Number(v).toFixed(1)}</span> : <span className="text-gray-400">0.0</span>,
    },
    {
      key: 'categoryId',
      label: 'Product Category',
      filterType: 'text',
      editable: true,
      editType: 'select',
      editOptions: [
        { value: '', label: '—' },
        ...categories.map(c => ({ value: c.id, label: c.nameZh ?? c.name })),
      ],
      render: (v) => {
        const cat = categories.find(c => c.id === String(v ?? ''))
        const label = cat?.nameZh ?? cat?.name ?? (v ? String(v) : '—')
        return <span className="text-xs text-gray-600">{label}</span>
      },
    },
    {
      key: 'uomName',
      label: 'Unit of Measure',
      filterType: 'multi-select',
      filterOptions: multiSelectOptions.uomName.map(v => ({ value: v, label: v })),
      filterLabelGetter: (val) => val || '（空）',
      render: (v) => v ? <span className="text-xs text-gray-600">{String(v)}</span> : <span className="text-gray-300">—</span>,
    },
    {
      key: 'type',
      label: 'Product Type',
      filterType: 'multi-select',
      editable: true,
      editType: 'select',
      editOptions: TYPE_OPTIONS,
      filterOptions: TYPE_OPTIONS,
      filterLabelGetter: (val) => TYPE_LABEL[val] ?? val ?? '（空）',
      render: (v) => <span className="text-xs">{TYPE_LABEL[String(v)] ?? String(v)}</span>,
    },
    {
      key: 'commissionPrice',
      label: 'Commission Price',
      filterType: 'text',
      editable: true,
      editType: 'number',
      render: (v) => v != null ? <span>€{Number(v).toFixed(2)}</span> : <span className="text-gray-400">—</span>,
    },
    {
      key: 'createdBy',
      label: 'Created by',
      filterType: 'multi-select',
      filterOptions: multiSelectOptions.createdBy.map(v => ({ value: v, label: v || 'Administrator' })),
      filterLabelGetter: (val) => val || 'Administrator',
      render: (v) => <span className="text-xs text-gray-500">{String(v || 'Administrator')}</span>,
    },
    {
      key: 'createdAt',
      label: 'Created on',
      sortable: true,
      filterType: 'date-range',
      render: (v) => <span className="text-xs text-gray-500">{new Date(String(v)).toLocaleDateString('en-GB')}</span>,
    },
    {
      key: 'updatedBy',
      label: 'Last Updated by',
      filterType: 'multi-select',
      filterOptions: multiSelectOptions.updatedBy.map(v => ({ value: v, label: v || 'Administrator' })),
      filterLabelGetter: (val) => val || 'Administrator',
      render: (v) => <span className="text-xs text-gray-500">{String(v || 'Administrator')}</span>,
    },
    {
      key: 'updatedAt',
      label: 'Last Updated on',
      sortable: true,
      filterType: 'date-range',
      render: (v) => v ? <span className="text-xs text-gray-500">{new Date(String(v)).toLocaleDateString('en-GB')}</span> : <span className="text-gray-400">—</span>,
    },
  ]

  const activeMultiCount = Object.values(columnMultiFilters).reduce((n, arr) => n + (arr?.length ?? 0), 0)
  const hasAlerts = alertCounts.negative > 0 || alertCounts.low > 0

  return (
    <div>
      <OdooControlPanel
        breadcrumb={['库存', '商品']}
        onNew={() => router.push(`${prefix}/classic/operator/products/new`)}
        permanentActions={[
          { label: '导入', onClick: () => setImportOpen(true) },
          { label: '导出', onClick: () => toast.info('导出功能即将推出') },
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
        searchValue={searchInput}
        onSearch={setSearchInput}
        onSearchSubmit={() => loadPage(1, searchInput)}
        activeFilters={[
          ...(canBeSoldFilter ? [{ label: 'Can be Sold', onRemove: () => setCanBeSoldFilter(false) }] : []),
          ...(productTypeFilter ? [{ label: TYPE_LABEL[productTypeFilter] ?? productTypeFilter, onRemove: () => setProductTypeFilter('') }] : []),
          ...(stockAlertFilter !== 'all' ? [{
            label: stockAlertFilter === 'negative' ? '⚠ 负库存' : '↓ 低库存',
            onRemove: () => setStockAlertFilter('all'),
          }] : []),
          ...(activeMultiCount > 0 ? [{ label: `列筛选 (${activeMultiCount})`, onRemove: () => setColumnMultiFilters({}) }] : []),
        ]}
        filterOptions={[
          { label: 'Can be Sold', value: 'canBeSold' },
          { label: 'Storable Product', value: 'product' },
          { label: 'Consumable', value: 'consu' },
          { label: 'Service', value: 'service' },
        ]}
        onFilterSelect={(v) => {
          if (v === 'canBeSold') setCanBeSoldFilter(prev => !prev)
          else setProductTypeFilter(prev => prev === v ? '' : v)
        }}
        groupByOptions={[
          { label: '商品类型', value: 'type' },
          { label: '商品分类', value: 'category' },
        ]}
        groupByValue={groupBy}
        onGroupByChange={v => setGroupBy(prev => prev === v ? '' : v)}
        favouriteState={{ searchInput, canBeSoldFilter, productTypeFilter, stockAlertFilter, groupBy }}
        onFavouriteApply={s => {
          setSearchInput(String(s.searchInput ?? ''))
          setCanBeSoldFilter(Boolean(s.canBeSoldFilter))
          setProductTypeFilter(String(s.productTypeFilter ?? ''))
          setStockAlertFilter((s.stockAlertFilter as StockAlertFilter) ?? 'all')
          setGroupBy(String(s.groupBy ?? ''))
          setPage(1)
        }}
        storageKey="classic_products_favs"
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={p => loadPage(p, searchInput)}
      />

      {/* ─── 库存告警横幅 ─── */}
      {hasAlerts && !alertDismissed && (
        <div className="mx-4 mt-3 rounded border flex items-start gap-3 px-4 py-3"
          style={{ background: '#fff7ed', borderColor: '#fed7aa' }}>
          <span className="text-lg leading-none mt-0.5">⚠️</span>
          <div className="flex-1 text-sm">
            <span className="font-semibold text-orange-800">库存预警</span>
            <span className="text-orange-700 ml-2">
              {alertCounts.negative > 0 && (
                <>
                  <span className="font-semibold text-red-600">{alertCounts.negative}</span>
                  <span> 种商品库存为负</span>
                </>
              )}
              {alertCounts.negative > 0 && alertCounts.low > 0 && <span className="mx-1">，</span>}
              {alertCounts.low > 0 && (
                <>
                  <span className="font-semibold text-amber-600">{alertCounts.low}</span>
                  <span> 种商品低于安全库存（&lt;{LOW_STOCK_THRESHOLD}）</span>
                </>
              )}
            </span>
            <span className="ml-3 space-x-2">
              {alertCounts.negative > 0 && (
                <button
                  onClick={() => { setStockAlertFilter('negative'); setAlertDismissed(true) }}
                  className="text-xs font-medium underline text-red-600 hover:text-red-800"
                >
                  查看负库存 →
                </button>
              )}
              {alertCounts.low > 0 && (
                <button
                  onClick={() => { setStockAlertFilter('low'); setAlertDismissed(true) }}
                  className="text-xs font-medium underline text-amber-600 hover:text-amber-800"
                >
                  查看低库存 →
                </button>
              )}
            </span>
          </div>
          <button
            onClick={() => setAlertDismissed(true)}
            className="text-orange-400 hover:text-orange-600 text-base leading-none"
            title="关闭"
          >
            ✕
          </button>
        </div>
      )}

      {/* ─── 工具栏：快速编辑 + 库存筛选 pills ─── */}
      <div className="px-4 pt-3 pb-1 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => setQuickEditMode(v => !v)}
          aria-pressed={quickEditMode}
          className="h-8 px-3 text-sm rounded border transition-colors flex items-center gap-1.5"
          style={{
            background: quickEditMode ? '#875A7B' : 'white',
            borderColor: quickEditMode ? '#875A7B' : '#d1d5db',
            color: quickEditMode ? 'white' : '#4b5563',
          }}
          title="开启后，可双击列表中可编辑字段直接修改，无需打开商品详情页"
        >
          <span style={{ fontSize: 13 }}>✏️</span>
          {quickEditMode ? '快速编辑（已开启）' : '快速编辑'}
        </button>

        {/* 库存筛选 pills */}
        <div className="flex items-center gap-1.5 ml-2">
          {(
            [
              { value: 'all', label: '全部', color: undefined },
              { value: 'negative', label: '⚠ 负库存', color: 'red' },
              { value: 'low', label: '↓ 低库存', color: 'amber' },
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
        </div>

        {quickEditMode && (
          <span className="text-xs text-gray-500">
            <strong style={{ color: '#875A7B' }}>双击</strong>紫色背景列即可编辑，回车或点击其他位置保存，Esc 取消。
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
          onRowClick={row => router.push(`${prefix}/classic/operator/products/${String(row.id)}`)}
          emptyText={stockAlertFilter === 'negative' ? '无负库存商品' : stockAlertFilter === 'low' ? '无低库存商品' : '暂无商品数据'}
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
          inlineEditEnabled={quickEditMode}
          onCellEdit={handleCellEdit}
          getRowStyle={getRowStyle}
          groupByField={groupBy === 'type' ? 'type' : groupBy === 'category' ? 'categoryId' : ''}
          groupByFormatter={(key, count) => {
            let label: string
            if (groupBy === 'type') label = TYPE_LABEL[key] ?? (key || '（空）')
            else if (groupBy === 'category') {
              const cat = categories.find(c => c.id === key)
              label = cat?.nameZh ?? cat?.name ?? (key || '（空）')
            } else label = key || '（空）'
            return <>{label} <span className="font-normal text-xs ml-1" style={{ color: '#a07898' }}>({count})</span></>
          }}
        />
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={p => loadPage(p, searchInput)} />

      <CsvImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="批量导入商品(CSV)"
        templateName="products-import-template"
        endpoint="/api/products/bulk"
        columns={[
          { key: 'name', label: '名称', required: true },
          { key: 'spec', label: '规格' },
          { key: 'price', label: '售价' },
          { key: 'stock', label: '库存' },
          { key: 'taxRate', label: '税率' },
          { key: 'commissionPrice', label: '佣金价' },
          { key: 'internalRef', label: '内部编号' },
        ]}
        onDone={() => loadPage(1, searchInput)}
      />
    </div>
  )
}
