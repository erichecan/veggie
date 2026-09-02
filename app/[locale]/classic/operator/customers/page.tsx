'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { applyFacets, groupFacets, CUSTOMER_FACET_FIELDS, type Facet } from '@/lib/list-filters'
import { Pagination } from '@/components/ui/pagination'
import type { Customer, OdooPricelist } from '@/lib/types'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useCsvExport } from '@/hooks/use-csv-export'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'
import CsvImportDialog from '@/components/classic/CsvImportDialog'

const PAGE_SIZE = 20

const PAYMENT_LABELS_ZH: Record<string, string> = { cash: '现付', weekly: '周结', monthly: '月结' }
const PAYMENT_LABELS_EN: Record<string, string> = { cash: 'Cash', weekly: 'Weekly', monthly: 'Monthly' }
// Price Type 沿用下单页(place-order)的说法，中英文界面下都不翻译——与那边保持一致
const PRICE_TYPE_LABELS: Record<string, string> = { multi: 'Multi Price', default: 'Default Price', last: 'Last Purchase Price' }

export default function ClassicCustomersPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale
  const PAYMENT_LABELS = isEn ? PAYMENT_LABELS_EN : PAYMENT_LABELS_ZH

  const [customers, setCustomers] = useState<Customer[]>([])
  const [pricelists, setPricelists] = useState<OdooPricelist[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [total, setTotal] = useState(0)
  const [searchInput, setSearchInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [paymentFilter, setPaymentFilter] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [isReadMode, setIsReadMode] = useState(true)
  // Odoo 式分面：同维度多值 OR、跨维度 AND（后端 buildFacetWhere）
  const [facets, setFacets] = useState<Facet[]>([])

  function addFacet(key: string, value: string) {
    const field = CUSTOMER_FACET_FIELDS.find(f => f.key === key)
    if (!field) return
    setFacets(prev => [...prev, { key, label: field.label, value }])
  }
  function removeFacetGroup(key: string) {
    setFacets(prev => prev.filter(f => f.key !== key))
  }
  const [groupBy, setGroupBy] = useState('')
  const [importOpen, setImportOpen] = useState(false)

  // 导出吃与列表请求完全相同的筛选参数（含分面），所以导出的就是屏幕上筛出来的那批，
  // 且服务端复用同一个 buildCustomersWhere —— 销售的行级隔离在导出上照样生效
  const exportAction = useCsvExport({
    entity: 'customers',
    params: () => {
      const params = new URLSearchParams()
      if (searchInput) params.set('search', searchInput)
      if (paymentFilter) params.set('paymentTerm', paymentFilter)
      if (includeArchived) params.set('includeArchived', '1')
      applyFacets(params, facets)
      return params
    },
    fallbackFilename: '客户.csv',
  })

  async function loadPage(p: number, q: string, payTerm = paymentFilter, archived = includeArchived, ps: number = pageSize) {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(ps) })
      if (q) params.set('search', q)
      if (payTerm) params.set('paymentTerm', payTerm)
      if (archived) params.set('includeArchived', '1')
      applyFacets(params, facets)
      const res = await apiGet<{ data: Customer[]; total: number; page: number; pageSize: number }>(`/api/customers?${params}`)
      setCustomers(res.data)
      setTotal(res.total)
      setPage(res.page)
      setPageSize(res.pageSize ?? ps)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load customers' : '加载客户失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadPage(1, searchInput, paymentFilter, includeArchived)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facets])

  useEffect(() => {
    loadPage(1, '', paymentFilter, includeArchived)
    apiGet<OdooPricelist[]>('/api/pricelists').then(d => setPricelists(Array.isArray(d) ? d.filter(pl => pl.active) : [])).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived])

  // debounced search
  useEffect(() => {
    const timer = setTimeout(() => loadPage(1, searchInput, paymentFilter, includeArchived), 400)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  function openAdd() {
    router.push(`${prefix}/classic/operator/customers/new`)
  }
  function openEdit(c: Customer) {
    router.push(`${prefix}/classic/operator/customers/${c.id}`)
  }

  function removePaymentFilter() {
    setPaymentFilter('')
    loadPage(1, searchInput, '', includeArchived)
  }

  const pricelistMap = new Map(pricelists.map(p => [p.id, p.name]))

  const columns: OdooColumn[] = [
    {
      key: 'name',
      label: isEn ? 'Customer Name' : '客户名称',
      render: (_, row) => (
        <span className="font-medium" style={{ color: '#875A7B' }}>
          {String(row.name ?? '')}
        </span>
      ),
    },
    { key: 'address', label: isEn ? 'Address' : '地址', render: (v) => <span className="text-gray-600 text-xs">{String(v || '')}</span> },
    { key: 'salesman', label: isEn ? 'Salesperson' : '销售员', render: (v) => v ? String(v) : <span className="text-gray-400">—</span> },
    {
      key: 'paymentTerm',
      label: isEn ? 'Payment Term' : '结算方式',
      render: (v) => (
        <span className="inline-block px-2 py-0.5 rounded text-xs" style={{ background: '#f3eff5', color: '#6d4a66' }}>
          {PAYMENT_LABELS[String(v)] ?? String(v)}
        </span>
      ),
    },
    {
      key: 'primaryPricelistId',
      label: isEn ? 'Pricelist' : '价格表',
      render: (_v, row) => {
        const links = (row.pricelists as { pricelistId: string }[] | undefined) ?? []
        if (links.length === 0) return <span className="text-gray-400">—</span>
        const primaryName = pricelistMap.get(links[0].pricelistId) ?? links[0].pricelistId
        return links.length > 1 ? `${primaryName} (+${links.length - 1})` : primaryName
      },
    },
    {
      key: 'priceType',
      label: 'Price Type',
      render: (v) => PRICE_TYPE_LABELS[String(v)] ?? PRICE_TYPE_LABELS.multi,
    },
    {
      key: 'creditLimit',
      label: isEn ? 'Credit Limit' : '信用额度',
      render: (v) => v != null ? `€${Number(v).toLocaleString()}` : <span className="text-gray-400">{isEn ? 'No limit' : '无限额'}</span>,
    },
    {
      key: 'isActive',
      label: isEn ? 'Status' : '状态',
      render: (v) => (
        <span className={`inline-block px-2 py-0.5 rounded text-xs ${v !== false ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
          {v !== false ? (isEn ? 'Active' : '活跃') : (isEn ? 'Inactive' : '停用')}
        </span>
      ),
    },
  ]

  const activeFilters = [
    ...groupFacets(facets).map(g => ({ label: g.chipLabel, onRemove: () => removeFacetGroup(g.key) })),
    ...(paymentFilter ? [{ label: isEn ? `Payment Term: ${PAYMENT_LABELS[paymentFilter] ?? paymentFilter}` : `结算方式：${PAYMENT_LABELS[paymentFilter] ?? paymentFilter}`, onRemove: removePaymentFilter }] : []),
    ...(includeArchived ? [{ label: isEn ? 'Include Archived' : '包含已归档', onRemove: () => setIncludeArchived(false) }] : []),
  ]

  return (
    <div>
      <OdooControlPanel
        breadcrumb={isEn ? ['Sales', 'Customers'] : ['销售', '客户']}
        onNew={openAdd}
        permanentActions={[
          { label: 'Import', onClick: () => setImportOpen(true) },
          ...(isReadMode
            ? [
                { label: 'Mode', onClick: () => setIsReadMode(false) },
                { label: 'Read', onClick: () => {}, primary: true },
              ]
            : [
                { label: 'Edit', onClick: () => {}, primary: true },
                { label: 'Mode', onClick: () => setIsReadMode(true) },
              ]),
          // 导出吃的是当前筛选参数（跟 selected 无关），所以常驻显示，不依赖勾选行
          exportAction,
          ...(selected.size > 0 ? [
            { label: isEn ? `Delete (${selected.size})` : `删除 (${selected.size})`, onClick: () => toast.info(isEn ? 'Delete coming soon' : '删除功能即将推出') },
          ] : []),
        ]}
        searchValue={searchInput}
        onSearch={setSearchInput}
        onSearchSubmit={() => loadPage(1, searchInput)}
        facetFields={CUSTOMER_FACET_FIELDS}
        onFacetAdd={addFacet}
        activeFilters={activeFilters}
        filterOptions={[
          { label: isEn ? 'Cash Customers' : '现付客户', value: 'cash' },
          { label: isEn ? 'Weekly Customers' : '周结客户', value: 'weekly' },
          { label: isEn ? 'Monthly Customers' : '月结客户', value: 'monthly' },
          { label: isEn ? 'Include Archived' : '包含已归档', value: '__archived__' },
        ]}
        groupByOptions={[
          { label: isEn ? 'Payment Term' : '结算方式', value: 'paymentTerm' },
          { label: isEn ? 'Pricelist' : '价格表', value: 'pricelist' },
        ]}
        onFilterSelect={v => {
          if (v === '__archived__') {
            setIncludeArchived(true)
          } else {
            setPaymentFilter(v as typeof paymentFilter)
            loadPage(1, searchInput, v, includeArchived)
          }
        }}
        groupByValue={groupBy}
        onGroupByChange={v => setGroupBy(prev => prev === v ? '' : v)}
        favouriteState={{ searchInput, paymentFilter, includeArchived, groupBy }}
        onFavouriteApply={s => {
          setSearchInput(String(s.searchInput ?? ''))
          const pf = String(s.paymentFilter ?? '')
          setPaymentFilter(pf)
          setIncludeArchived(Boolean(s.includeArchived))
          setGroupBy(String(s.groupBy ?? ''))
          loadPage(1, String(s.searchInput ?? ''), pf, Boolean(s.includeArchived))
        }}
        storageKey="classic_customers_favs"
        total={total}
        page={page}
        pageSize={pageSize}
        onPageChange={p => loadPage(p, searchInput)}
        onPageSizeChange={ps => loadPage(1, searchInput, paymentFilter, includeArchived, ps)}
      />

      <div className="p-4">
        <OdooTable
          columns={columns}
          rows={customers.map(c => ({ ...c, primaryPricelistId: c.pricelists?.[0]?.pricelistId ?? null })) as unknown as Record<string, unknown>[]}
          loading={loading}
          selected={selected}
          onSelectAll={checked => {
            if (checked) setSelected(new Set(customers.map(c => c.id)))
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
          onRowClick={row => openEdit(row as unknown as Customer)}
          emptyText={isEn ? 'No customer data' : '暂无客户数据'}
          groupByField={groupBy === 'paymentTerm' ? 'paymentTerm' : groupBy === 'pricelist' ? 'primaryPricelistId' : ''}
          groupByFormatter={(key, count) => {
            const emptyLabel = isEn ? '(none)' : '（空）'
            let label: string
            if (groupBy === 'paymentTerm') label = PAYMENT_LABELS[key] ?? (key || emptyLabel)
            else if (groupBy === 'pricelist') label = pricelistMap.get(key) ?? (key || emptyLabel)
            else label = key || emptyLabel
            return <>{label} <span className="font-normal text-xs ml-1" style={{ color: '#a07898' }}>({count})</span></>
          }}
        />
        <Pagination page={page} totalPages={Math.ceil(total / pageSize)} onPageChange={p => loadPage(p, searchInput)} />
      </div>

      <CsvImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={isEn ? 'Bulk Import Customers (CSV)' : '批量导入客户(CSV)'}
        templateName="customers-import-template"
        endpoint="/api/customers/bulk"
        columns={[
          { key: 'name', label: isEn ? 'Name' : '名称', required: true },
          { key: 'phone', label: isEn ? 'Phone' : '电话' },
          { key: 'email', label: isEn ? 'Email' : '邮箱' },
          { key: 'address', label: isEn ? 'Address' : '地址' },
          { key: 'city', label: isEn ? 'City' : '城市' },
          { key: 'zip', label: isEn ? 'ZIP' : '邮编' },
          { key: 'paymentTerm', label: isEn ? 'Payment Term' : '账期' },
          { key: 'salesman', label: isEn ? 'Salesperson' : '业务员' },
          { key: 'vatNumber', label: isEn ? 'VAT Number' : '税号' },
          { key: 'notes', label: isEn ? 'Notes' : '备注' },
        ]}
        onDone={() => loadPage(1, searchInput)}
      />
    </div>
  )
}
