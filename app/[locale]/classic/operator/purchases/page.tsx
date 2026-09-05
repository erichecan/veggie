'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { Pagination } from '@/components/ui/pagination'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useCsvExport } from '@/hooks/use-csv-export'
import { applyFacets, groupFacets, localizeFacetFields, PURCHASE_FACET_FIELDS, type Facet } from '@/lib/list-filters'
import ProcurementOverviewPage from './overview/page'
import FreshDailySuggestionsPage from './fresh/page'
import CatalogPickingPage from './catalog/page'
import AnnualPlanPage from './annual-plan/page'

const PURPLE = '#875A7B'

type MainTab = 'quotations' | 'overview' | 'fresh' | 'catalog' | 'annual-plan'

const MAIN_TABS_ZH: { k: MainTab; icon: string; label: string }[] = [
  { k: 'quotations', icon: '📝', label: '询价单' },
  { k: 'overview', icon: '📊', label: '总览' },
  { k: 'fresh', icon: '🥬', label: '生鲜次日备货' },
  { k: 'catalog', icon: '🛒', label: '目录挑选' },
  { k: 'annual-plan', icon: '🌾', label: '干货年度计划' },
]

const MAIN_TABS_EN: { k: MainTab; icon: string; label: string }[] = [
  { k: 'quotations', icon: '📝', label: 'Quotations' },
  { k: 'overview', icon: '📊', label: 'Overview' },
  { k: 'fresh', icon: '🥬', label: 'Next-Day Fresh Stocking' },
  { k: 'catalog', icon: '🛒', label: 'Catalog Picking' },
  { k: 'annual-plan', icon: '🌾', label: 'Dry Goods Annual Plan' },
]

type POStatus = 'DRAFT' | 'SENT' | 'CONFIRMED' | 'RECEIVED' | 'INVOICED' | 'LOCKED' | 'TO_APPROVE' | 'CANCELLED'

interface PurchaseOrder {
  id: string
  name: string
  status: POStatus
  supplierId: string
  supplierName?: string
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

  function addFacet(key: string, value: string) {
    const field = PURCHASE_FACET_FIELDS.find(f => f.key === key)
    if (!field) return
    setFacets(prev => [...prev, { key, label: isEn ? field.labelEn : field.label, value }])
  }
  function removeFacetGroup(key: string) {
    setFacets(prev => prev.filter(f => f.key !== key))
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (activeTab !== 'all') params.set('status', activeTab)
      if (search) params.set('search', search)
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String((page - 1) * PAGE_SIZE))
      applyFacets(params, facets)
      const data = await apiGet<{ items: PurchaseOrder[]; total: number }>(`/api/purchase-orders?${params}`)
      setPos(data.items ?? (data as unknown as PurchaseOrder[]))
      setTotal(data.total ?? (data as unknown as PurchaseOrder[]).length)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [activeTab, search, page, isEn, facets])

  // 导出与列表同参（状态页签 + 搜索 + 分面），服务端复用同一个 buildPurchaseOrdersWhere
  const exportAction = useCsvExport({
    entity: 'purchase-orders',
    params: () => {
      const params = new URLSearchParams()
      if (activeTab !== 'all') params.set('status', activeTab)
      if (search) params.set('search', search)
      applyFacets(params, facets)
      return params
    },
    fallbackFilename: isEn ? 'purchase-orders.csv' : '采购单.csv',
  })

  useEffect(() => { load() }, [load])

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

      {mainTab === 'quotations' && <>
      <OdooControlPanel
        breadcrumb={isEn ? ['Purchases', 'Quotations'] : ['采购', '询价单']}
        permanentActions={[
          exportAction,
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
        ]}
        groupByValue={groupBy}
        onGroupByChange={v => setGroupBy(prev => prev === v ? '' : v)}
        favouriteState={{ searchInput, activeTab, groupBy, facets }}
        onFavouriteApply={s => {
          setSearchInput(String(s.searchInput ?? ''))
          setSearch(String(s.searchInput ?? ''))
          handleTabChange(String(s.activeTab ?? 'all'))
          setGroupBy(String(s.groupBy ?? ''))
          // 分面搜索(单号/供应商/商品/备注)此前没进收藏，与商品页同一个坑
          setFacets(Array.isArray(s.facets) ? (s.facets as Facet[]) : [])
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
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">{isEn ? 'Supplier' : '供应商'}</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">{isEn ? 'Order Date' : '订购日期'}</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">{isEn ? 'Expected Arrival' : '预计到货'}</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">{isEn ? 'Source Document' : '来源单据'}</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">{isEn ? 'Status' : '状态'}</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">{isEn ? 'Amount Ex. Tax' : '税前金额'}</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">{isEn ? 'Total Inc. Tax' : '含税总额'}</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const GB_FIELD: Record<string, keyof PurchaseOrder> = {
                  supplier: 'supplierName',
                  status: 'status',
                  orderDate: 'orderDate',
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
                    <td colSpan={9} className="px-3 py-1.5 font-semibold text-sm" style={{ color: '#6d4a66' }}>
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

      </>}
    </div>
  )
}
