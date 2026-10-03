'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import { PAYMENT_TERM_OPTIONS } from '@/lib/payment-terms'
import { applyFacets, groupFacets, localizeFacetFields, CUSTOMER_FACET_FIELDS, type Facet } from '@/lib/list-filters'
import { Pagination } from '@/components/ui/pagination'
import type { Customer, OdooPricelist } from '@/lib/types'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useCsvExport } from '@/hooks/use-csv-export'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'
import BulkImportDialog from '@/components/shared/BulkImportDialog'
import { CUSTOMER_EXPORT_COLUMNS, CUSTOMER_EXPORT_COLUMNS_EN } from '@/lib/export/columns/customers'
import { type SortDir } from '@/components/shared/sort-th'
import { BUSINESS_TIMEZONE } from '@/lib/analytics/metrics'

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
  const emptyLabel = isEn ? '(empty)' : '（空）'

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
  const [isVendorOnly, setIsVendorOnly] = useState(false)
  const [isReadMode, setIsReadMode] = useState(true)
  const editMode = !isReadMode
  const [deleting, setDeleting] = useState(false)
  // Odoo 式分面：同维度多值 OR、跨维度 AND（后端 buildFacetWhere）
  const [facets, setFacets] = useState<Facet[]>([])
  // 列头排序：Customer Name / Salesperson / Pricelist / Price Type 均可点表头排序，
  // 与商品页(products/page.tsx)同一套约定——排序只在当前页内进行，与该页服务端分页的限制一致
  const [sortKey, setSortKey] = useState('')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  // 列头多选筛选(Pricelist / Price Type)，转成 cfm_* 参数发给后端，与商品页同一套惯例
  const [columnMultiFilters, setColumnMultiFilters] = useState<Record<string, string[]>>({})

  function addFacet(key: string, value: string) {
    const field = CUSTOMER_FACET_FIELDS.find(f => f.key === key)
    if (!field) return
    setFacets(prev => [...prev, { key, label: isEn ? field.labelEn : field.label, value }])
  }
  function removeFacetGroup(key: string) {
    setFacets(prev => prev.filter(f => f.key !== key))
  }
  const [groupBy, setGroupBy] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  // 列头日期区间筛选(Last Updated on)，转成 cf_<key>_from/_to 参数，与商品页同一套惯例
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({})
  // Last Updated by 下拉选项：去重历史值，同商品页 /api/products/filter-options 的模式
  const [updatedByOptions, setUpdatedByOptions] = useState<string[]>([])
  const [salesUsers, setSalesUsers] = useState<{ id: string; name: string }[]>([])

  // OdooTable 列 key → 后端 cfm_* 参数名（primaryPricelistId 是前端派生列，落地时映射回真实字段名）
  const CFM_PARAM_NAME: Record<string, string> = { primaryPricelistId: 'cfm_pricelistId', priceType: 'cfm_priceType' }
  function applyColumnMultiFilters(params: URLSearchParams) {
    for (const [key, vals] of Object.entries(columnMultiFilters)) {
      if (vals && vals.length > 0) params.set(CFM_PARAM_NAME[key] ?? `cfm_${key}`, vals.join(','))
    }
  }
  function applyColumnFilters(params: URLSearchParams) {
    for (const [key, val] of Object.entries(columnFilters)) {
      if (val) params.set(`cf_${key}`, val)
    }
  }

  // 导出吃与列表请求完全相同的筛选参数（含分面），所以导出的就是屏幕上筛出来的那批，
  // 且服务端复用同一个 buildCustomersWhere —— 销售的行级隔离在导出上照样生效
  const exportAction = useCsvExport({
    entity: 'customers',
    params: () => {
      const params = new URLSearchParams()
      if (searchInput) params.set('search', searchInput)
      if (paymentFilter) params.set('paymentTerm', paymentFilter)
      if (includeArchived) params.set('includeArchived', '1')
      if (isVendorOnly) params.set('isVendor', '1')
      applyFacets(params, facets)
      applyColumnMultiFilters(params)
      applyColumnFilters(params)
      return params
    },
    fallbackFilename: isEn ? 'customers.csv' : '客户.csv',
    columns: isEn ? CUSTOMER_EXPORT_COLUMNS_EN : CUSTOMER_EXPORT_COLUMNS,
  })

  async function loadPage(p: number, q: string, payTerm = paymentFilter, archived = includeArchived, ps: number = pageSize, vendorOnly = isVendorOnly) {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(ps) })
      if (q) params.set('search', q)
      if (payTerm) params.set('paymentTerm', payTerm)
      if (archived) params.set('includeArchived', '1')
      if (vendorOnly) params.set('isVendor', '1')
      applyFacets(params, facets)
      applyColumnMultiFilters(params)
      applyColumnFilters(params)
      // 排序是整个数据集的排序（服务端 orderBy），不是只对当前这一页重排——
      // 否则翻页/换排序方向时，看到的顺序会跟其余 1500+ 条客户脱节
      if (sortKey) { params.set('sortKey', sortKey); params.set('sortDir', sortDir) }
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
  }, [facets, columnMultiFilters, columnFilters, sortKey, sortDir])

  useEffect(() => {
    loadPage(1, '', paymentFilter, includeArchived)
    apiGet<OdooPricelist[]>('/api/pricelists').then(d => setPricelists(Array.isArray(d) ? d.filter(pl => pl.active) : [])).catch(() => {})
    apiGet<{ updatedBy: string[] }>('/api/customers/filter-options').then(d => setUpdatedByOptions(d.updatedBy ?? [])).catch(() => {})
    apiGet<{ id: string; name: string; email: string }[]>('/api/users?role=OPERATOR,SALES,EXTERNAL_SALES')
      .then(users => setSalesUsers(users.map(u => ({ id: u.id, name: u.name || u.email }))))
      .catch(() => {})
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

  function toggleVendorOnly() {
    const next = !isVendorOnly
    setIsVendorOnly(next)
    loadPage(1, searchInput, paymentFilter, includeArchived, pageSize, next)
  }

  // 客户有大量历史单据(订单/发票/对账单等)关联且无数据库级约束兜底，物理删除风险很高——
  // 复用详情页已有的归档(isActive=false)机制作为这里的"删除"：客户立即从常规列表/下单选择里消失，
  // 历史数据和关联单据完整保留，需要的话还能在详情页恢复（20261003 决定，见客户详情页 toggleActive）
  async function handleDeleteSelected() {
    if (selected.size === 0 || deleting) return
    if (!confirm(isEn
      ? `Archive ${selected.size} customer(s)? They will disappear from the regular list and from customer pickers on orders/quotations, but all history is kept and this can be undone from each customer's detail page.`
      : `确认归档 ${selected.size} 个客户？归档后会从常规列表和下单/报价的客户选择中消失，但历史数据完整保留，可在客户详情页恢复。`)) return
    setDeleting(true)
    const ids = [...selected]
    const results = await Promise.allSettled(ids.map(id => apiPut(`/api/customers/${id}`, { isActive: false })))
    const successCount = results.filter(r => r.status === 'fulfilled').length
    const failCount = results.filter(r => r.status === 'rejected').length
    setDeleting(false)
    setSelected(new Set())
    if (failCount === 0) toast.success(isEn ? `Archived ${successCount} customer(s)` : `已归档 ${successCount} 个客户`)
    else toast.warning(isEn ? `${successCount} succeeded, ${failCount} failed` : `成功 ${successCount} 个，失败 ${failCount} 个`)
    loadPage(page, searchInput)
  }

  async function handleCellEdit(row: Record<string, unknown>, key: string, newValue: unknown) {
    const c = row as unknown as Customer
    let payloadVal: unknown = newValue
    if (key === 'creditLimit') {
      if (newValue === '' || newValue == null) {
        payloadVal = null
      } else {
        const n = Number(newValue)
        if (!Number.isFinite(n) || n < 0) {
          toast.error(isEn ? 'Please enter a valid non-negative number' : '请输入合法的非负数字')
          throw new Error('invalid number')
        }
        payloadVal = n
      }
    }
    try {
      await apiPut(`/api/customers/${c.id}`, { [key]: payloadVal })
      // key==='salesUserId' 时展示用的 row.salesman 是单独展平字段，不会跟着自动更新——
      // 乐观更新里一并同步，否则要刷新整页才会显示新销售员的名字
      const extra = key === 'salesUserId'
        ? { salesman: salesUsers.find(u => u.id === payloadVal)?.name ?? null }
        : {}
      setCustomers(prev => prev.map(row => row.id === c.id ? { ...row, [key]: payloadVal, ...extra } as Customer : row))
      toast.success(isEn ? 'Saved' : '已保存')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
      throw e
    }
  }

  const pricelistMap = new Map(pricelists.map(p => [p.id, p.name]))

  const columns: OdooColumn[] = [
    {
      key: 'name',
      label: isEn ? 'Customer Name' : '客户名称',
      sortable: true,
      render: (_, row) => (
        <span className="font-medium" style={{ color: '#875A7B' }}>
          {String(row.name ?? '')}
        </span>
      ),
    },
    {
      key: 'address',
      label: isEn ? 'Address' : '地址',
      editable: true,
      editType: 'text',
      render: (v) => <span className="text-gray-600 text-xs">{String(v || '')}</span>,
    },
    {
      // key 用 salesUserId（行内编辑要提交的真实字段），显示仍读 row.salesman（已展平的姓名）；
      // sortKey 显式指回 'salesman'，后端按姓名排序的既有行为不受 key 改动影响
      key: 'salesUserId',
      sortKey: 'salesman',
      label: isEn ? 'Salesperson' : '销售员',
      sortable: true,
      editable: true,
      editType: 'select',
      editOptions: salesUsers.map(u => ({ value: u.id, label: u.name })),
      render: (_v, row) => row.salesman ? String(row.salesman) : <span className="text-gray-400">—</span>,
    },
    {
      key: 'paymentTerm',
      label: isEn ? 'Payment Term' : '结算方式',
      editable: true,
      editType: 'select',
      editOptions: PAYMENT_TERM_OPTIONS.map(o => ({ value: o.value, label: isEn ? o.labelEn : o.labelZh })),
      render: (v) => (
        <span className="inline-block px-2 py-0.5 rounded text-xs" style={{ background: '#f3eff5', color: '#6d4a66' }}>
          {PAYMENT_LABELS[String(v)] ?? String(v)}
        </span>
      ),
    },
    {
      key: 'primaryPricelistId',
      label: isEn ? 'Pricelist' : '价格表',
      sortable: true,
      filterType: 'multi-select',
      filterOptions: pricelists.map(p => ({ value: p.id, label: p.name })),
      filterLabelGetter: (v) => pricelistMap.get(v) ?? v,
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
      sortable: true,
      editable: true,
      editType: 'select',
      editOptions: Object.entries(PRICE_TYPE_LABELS).map(([value, label]) => ({ value, label })),
      filterType: 'multi-select',
      filterOptions: Object.entries(PRICE_TYPE_LABELS).map(([value, label]) => ({ value, label })),
      filterLabelGetter: (v) => PRICE_TYPE_LABELS[v] ?? v,
      render: (v) => PRICE_TYPE_LABELS[String(v)] ?? PRICE_TYPE_LABELS.multi,
    },
    {
      key: 'creditLimit',
      label: isEn ? 'Credit Limit' : '信用额度',
      editable: true,
      editType: 'number',
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
    {
      key: 'updatedBy',
      label: isEn ? 'Last Updated by' : '最后修改人',
      filterType: 'multi-select',
      filterOptions: updatedByOptions.map(v => ({ value: v, label: v || emptyLabel })),
      filterLabelGetter: (val) => val || emptyLabel,
      render: (v) => <span className="text-xs text-gray-500">{v ? String(v) : <span className="text-gray-300">—</span>}</span>,
    },
    {
      key: 'updatedAt',
      label: isEn ? 'Last Updated on' : '最后修改时间',
      sortable: true,
      filterType: 'date-range',
      // ⛔ 必须显式指定 timeZone：不然按查看者浏览器本地时区渲染，同一条记录在
      // 都柏林和北美的设备上可能显示成不同的日期，跟按都柏林日历日算的筛选边界对不上
      render: (v) => v ? <span className="text-xs text-gray-500">{new Date(String(v)).toLocaleDateString('en-GB', { timeZone: BUSINESS_TIMEZONE })}</span> : <span className="text-gray-400">—</span>,
    },
  ]

  const activeFilters = [
    ...groupFacets(facets).map(g => ({ label: g.chipLabel, values: g.values, prefix: g.key === 'all' ? undefined : g.label, onRemove: () => removeFacetGroup(g.key) })),
    ...(paymentFilter ? [{ label: isEn ? `Payment Term: ${PAYMENT_LABELS[paymentFilter] ?? paymentFilter}` : `结算方式：${PAYMENT_LABELS[paymentFilter] ?? paymentFilter}`, onRemove: removePaymentFilter }] : []),
    ...(includeArchived ? [{ label: isEn ? 'Include Archived' : '包含已归档', onRemove: () => setIncludeArchived(false) }] : []),
    ...(isVendorOnly ? [{ label: isEn ? 'Vendors' : '供货商', onRemove: toggleVendorOnly }] : []),
  ]

  return (
    <div>
      <OdooControlPanel
        breadcrumb={isEn ? ['Sales', 'Customers'] : ['销售', '客户']}
        onNew={openAdd}
        newLabel={isEn ? 'New' : '新建'}
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
            { label: deleting ? (isEn ? 'Archiving...' : '归档中...') : (isEn ? `Delete (${selected.size})` : `删除 (${selected.size})`), onClick: handleDeleteSelected, style: 'red' as const, disabled: deleting },
          ] : []),
        ]}
        searchValue={searchInput}
        onSearch={setSearchInput}
        onSearchSubmit={() => loadPage(1, searchInput)}
        facetFields={localizeFacetFields(CUSTOMER_FACET_FIELDS, isEn)}
        onFacetAdd={addFacet}
        activeFilters={activeFilters}
        toggleButtons={[
          { label: isEn ? 'Vendors' : '供货商', active: isVendorOnly, onClick: toggleVendorOnly },
        ]}
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
        favouriteState={{ searchInput, paymentFilter, includeArchived, isVendorOnly, groupBy, facets, columnMultiFilters, columnFilters, sortKey, sortDir }}
        onFavouriteApply={s => {
          setSearchInput(String(s.searchInput ?? ''))
          const pf = String(s.paymentFilter ?? '')
          setPaymentFilter(pf)
          setIncludeArchived(Boolean(s.includeArchived))
          const vendorOnly = Boolean(s.isVendorOnly)
          setIsVendorOnly(vendorOnly)
          setGroupBy(String(s.groupBy ?? ''))
          // 分面搜索(名称/城市/地址/电话/邮箱/税号/业务员)与列头筛选此前没进收藏，同商品页那个坑
          setFacets(Array.isArray(s.facets) ? (s.facets as Facet[]) : [])
          setColumnMultiFilters((s.columnMultiFilters as Record<string, string[]>) ?? {})
          setColumnFilters((s.columnFilters as Record<string, string>) ?? {})
          setSortKey(String(s.sortKey ?? ''))
          setSortDir(s.sortDir === 'desc' ? 'desc' : 'asc')
          loadPage(1, String(s.searchInput ?? ''), pf, Boolean(s.includeArchived), pageSize, vendorOnly)
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
          // 排序已经由后端做（按整个筛选结果集排序，见 loadPage 里的 sortKey/sortDir 参数），
          // 这里只需要把 primaryPricelistId 这个派生展示字段挂上去，不再客户端重排
          rows={customers.map(c => {
            const primaryPricelistId = c.pricelists?.[0]?.pricelistId ?? null
            return { ...c, primaryPricelistId, pricelistName: primaryPricelistId ? (pricelistMap.get(primaryPricelistId) ?? primaryPricelistId) : '' }
          }) as unknown as Record<string, unknown>[]}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={key => {
            if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
            else { setSortKey(key); setSortDir('asc') }
          }}
          columnMultiFilters={columnMultiFilters}
          onColumnMultiFilterChange={(key, vals) => {
            setColumnMultiFilters(prev => {
              const next = { ...prev }
              if (vals.length === 0) delete next[key]
              else next[key] = vals
              return next
            })
          }}
          columnFilters={columnFilters}
          onColumnFilterChange={(key, val) => setColumnFilters(prev => ({ ...prev, [key]: val }))}
          inlineEditEnabled={editMode}
          onCellEdit={handleCellEdit}
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

      <BulkImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        templateFileName="customers-import-template"
        endpoint="/api/customers/bulk"
        title={{ zh: '批量导入客户(CSV)', en: 'Bulk Import Customers (CSV)' }}
        hint={{
          zh: '第一行为表头。仅「名称」必填。',
          en: 'Row 1 is the header. Name is the only required column.',
        }}
        extraHint={{
          zh: <>按「ID」精确匹配更新对应客户——保留从导出文件带出的「ID」列可可靠更新;没传/没匹配上则按名称判重(撞了跳过,不覆盖),否则新建。</>,
          en: <>Matched by ID (exact match) updates that customer — keep the ID column from an exported file to reliably update; otherwise a name collision is skipped, no match creates a new one.</>,
        }}
        columns={[
          { key: 'externalId', label: isEn ? 'ID' : 'ID' },
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
        exampleRows={[
          ['', 'Demo Restaurant Ltd', '0851234567', 'demo@example.com', '12 Main Street', 'Dublin', 'D01', 'monthly', '', 'IE1234567T', ''],
        ]}
        onDone={() => loadPage(1, searchInput)}
      />
      {exportAction.dialog}
    </div>
  )
}
