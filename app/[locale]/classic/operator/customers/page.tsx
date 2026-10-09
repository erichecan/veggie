'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import { PAYMENT_TERM_OPTIONS } from '@/lib/payment-terms'
import { applyFacets, groupFacets, localizeFacetFields, CUSTOMER_FACET_FIELDS, type Facet } from '@/lib/list-filters'
import { Pagination } from '@/components/ui/pagination'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import type { Customer, OdooPricelist } from '@/lib/types'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useCsvExport } from '@/hooks/use-csv-export'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'
import BulkImportDialog from '@/components/shared/BulkImportDialog'
import { CUSTOMER_EXPORT_COLUMNS, CUSTOMER_EXPORT_COLUMNS_EN } from '@/lib/export/columns/customers'
import { type SortDir } from '@/components/shared/sort-th'
import { BUSINESS_TIMEZONE } from '@/lib/analytics/metrics'
import { writeCustomerNavList } from '@/lib/customer-nav-list'
import { hasPermission, useAbility } from '@/lib/permissions'
import { deleteCustomersFlow, DELETE_PERMISSION_HINT } from '@/components/customers/delete-customers'
import { userPickerOptions, type PickerUser } from '@/lib/user-picker'

const PAGE_SIZE = 20

// 筛选/排序/分页状态持久化（20261007 客户反馈：筛出某个业务员的客户、点进去改完，
// 点面包屑 Contacts 回来筛选全没了）。详情页是整页路由跳转，列表组件会被卸载，
// 跟商品列表(products/page.tsx)同一个做法：sessionStorage 记一份，回到列表原样恢复；
// 只在本标签页内有效，不会跨会话粘住。
const CUSTOMERS_FILTER_STORAGE_KEY = 'customers-list-filters-v1'

interface SavedCustomersListState {
  searchInput: string
  paymentFilter: string
  includeArchived: boolean
  archivedOnly?: boolean
  isVendorOnly: boolean
  facets: Facet[]
  sortKey: string
  sortDir: SortDir
  columnMultiFilters: Record<string, string[]>
  columnFilters: Record<string, string>
  groupBy: string
  page: number
  pageSize: number
}

function readSavedCustomersListState(): Partial<SavedCustomersListState> | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(CUSTOMERS_FILTER_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeSavedCustomersListState(state: SavedCustomersListState) {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(CUSTOMERS_FILTER_STORAGE_KEY, JSON.stringify(state))
  } catch { /* 隐私模式/存储禁用——丢了就丢了，不是关键功能 */ }
}

// 账期显示名与详情页下拉同源(lib/payment-terms.ts)，以前这里只认 3 档，双周结/双月结显示成原始代码
const PAYMENT_LABELS_ZH: Record<string, string> = Object.fromEntries(PAYMENT_TERM_OPTIONS.map(o => [o.value, o.labelZh]))
const PAYMENT_LABELS_EN: Record<string, string> = Object.fromEntries(PAYMENT_TERM_OPTIONS.map(o => [o.value, o.labelEn]))
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
  // 懒初始化时读一次上次留下的筛选状态(从详情页返回时恢复)
  const [saved] = useState(readSavedCustomersListState)
  const [page, setPage] = useState(saved?.page ?? 1)
  const [pageSize, setPageSize] = useState(saved?.pageSize ?? PAGE_SIZE)
  const [total, setTotal] = useState(0)
  const [searchInput, setSearchInput] = useState(saved?.searchInput ?? '')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [paymentFilter, setPaymentFilter] = useState(saved?.paymentFilter ?? '')
  const [includeArchived, setIncludeArchived] = useState(saved?.includeArchived ?? false)
  // 只看已归档(20261008 客户要求，与商品列表同款)；与「包含已归档」互斥
  const [archivedOnly, setArchivedOnly] = useState(saved?.archivedOnly ?? false)
  const [isVendorOnly, setIsVendorOnly] = useState(saved?.isVendorOnly ?? false)
  const [isReadMode, setIsReadMode] = useState(true)
  const editMode = !isReadMode
  const [deleting, setDeleting] = useState(false)
  const canDelete = hasPermission(useAbility(), 'master.customer.delete')
  // Odoo 式分面：同维度多值 OR、跨维度 AND（后端 buildFacetWhere）
  const [facets, setFacets] = useState<Facet[]>(saved?.facets ?? [])
  // 列头排序：Customer Name / Salesperson / Pricelist / Price Type 均可点表头排序，
  // 与商品页(products/page.tsx)同一套约定——排序只在当前页内进行，与该页服务端分页的限制一致
  const [sortKey, setSortKey] = useState(saved?.sortKey ?? '')
  const [sortDir, setSortDir] = useState<SortDir>(saved?.sortDir ?? 'asc')
  // 列头多选筛选(Pricelist / Price Type)，转成 cfm_* 参数发给后端，与商品页同一套惯例
  const [columnMultiFilters, setColumnMultiFilters] = useState<Record<string, string[]>>(saved?.columnMultiFilters ?? {})

  function addFacet(key: string, value: string) {
    const field = CUSTOMER_FACET_FIELDS.find(f => f.key === key)
    if (!field) return
    setFacets(prev => [...prev, { key, label: isEn ? field.labelEn : field.label, value }])
  }
  function removeFacetGroup(key: string) {
    setFacets(prev => prev.filter(f => f.key !== key))
  }
  const [groupBy, setGroupBy] = useState(saved?.groupBy ?? '')
  const [importOpen, setImportOpen] = useState(false)
  // 列头日期区间筛选(Last Updated on)，转成 cf_<key>_from/_to 参数，与商品页同一套惯例
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>(saved?.columnFilters ?? {})
  // Last Updated by 下拉选项：去重历史值，同商品页 /api/products/filter-options 的模式
  const [updatedByOptions, setUpdatedByOptions] = useState<string[]>([])
  const [salesUsers, setSalesUsers] = useState<PickerUser[]>([])

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
      if (archivedOnly) params.set('archivedOnly', '1')
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
      if (archivedOnly) params.set('archivedOnly', '1')
      if (vendorOnly) params.set('isVendor', '1')
      applyFacets(params, facets)
      applyColumnMultiFilters(params)
      applyColumnFilters(params)
      // 排序是整个数据集的排序（服务端 orderBy），不是只对当前这一页重排——
      // 否则翻页/换排序方向时，看到的顺序会跟其余 1500+ 条客户脱节
      if (sortKey) { params.set('sortKey', sortKey); params.set('sortDir', sortDir) }
      const res = await apiGet<{ data: Customer[]; total: number; page: number; pageSize: number }>(`/api/customers?${params}`)
      setCustomers(res.data)
      // 勾选只对当前看得见的行有效(20261007 客户反馈：搜索后只勾了 1 个，却提示删除 2 个——
      // 之前勾过、已被筛出列表的那条还留在 selected 里，会被看不见地一起删掉)
      setSelected(prev => {
        const visible = new Set(res.data.map(r => r.id))
        const next = new Set([...prev].filter(id => visible.has(id)))
        return next.size === prev.size ? prev : next
      })
      setTotal(res.total)
      setPage(res.page)
      setPageSize(res.pageSize ?? ps)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load customers' : '加载客户失败'))
    } finally {
      setLoading(false)
    }
  }

  // 挂载时只拉一次：用恢复出来的页码/筛选(没有就是第 1 页、无筛选)。下面几个按筛选
  // 变化重拉的 effect 都跳过首次挂载，否则会用 page=1 把刚恢复的页码冲掉。
  useEffect(() => {
    loadPage(page, searchInput, paymentFilter, includeArchived, pageSize, isVendorOnly)
    // 20261008 修复：这里不能只存 active 的——客户挂靠的价格表一旦被归档，
    // 名字映射(pricelistMap)就会查不到，列表里显示成 pl_35 这种内部 id(Odoo 迁移遗留格式)
    // 而不是真实名字。筛选器下拉(filterOptions)另外单独过滤出 active 的，归档的不需要出现在那
    apiGet<OdooPricelist[]>('/api/pricelists').then(d => setPricelists(Array.isArray(d) ? d : [])).catch(() => {})
    apiGet<{ updatedBy: string[] }>('/api/customers/filter-options').then(d => setUpdatedByOptions(d.updatedBy ?? [])).catch(() => {})
    apiGet<PickerUser[]>('/api/users?role=OPERATOR,SALES,EXTERNAL_SALES')
      .then(users => setSalesUsers(users.map(u => ({ id: u.id, name: u.name || u.email || u.id, isActive: u.isActive }))))
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtersMountedRef = useRef(false)
  useEffect(() => {
    if (!filtersMountedRef.current) { filtersMountedRef.current = true; return }
    loadPage(1, searchInput, paymentFilter, includeArchived)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facets, columnMultiFilters, columnFilters, sortKey, sortDir, includeArchived, archivedOnly])

  // debounced search
  const searchMountedRef = useRef(false)
  useEffect(() => {
    if (!searchMountedRef.current) { searchMountedRef.current = true; return }
    const timer = setTimeout(() => loadPage(1, searchInput, paymentFilter, includeArchived), 400)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  useEffect(() => {
    writeSavedCustomersListState({
      searchInput, paymentFilter, includeArchived, archivedOnly, isVendorOnly, facets, sortKey, sortDir,
      columnMultiFilters, columnFilters, groupBy, page, pageSize,
    })
  }, [searchInput, paymentFilter, includeArchived, archivedOnly, isVendorOnly, facets, sortKey, sortDir,
      columnMultiFilters, columnFilters, groupBy, page, pageSize])

  function openAdd() {
    router.push(`${prefix}/classic/operator/customers/new`)
  }
  function openEdit(c: Customer) {
    writeCustomerNavList(customers.map(customer => customer.id))
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

  // 真删除(20261007)：只删没有业务单据的客户，有单据的提示改归档，见 components/customers/delete-customers.ts
  async function handleHardDeleteSelected() {
    if (selected.size === 0 || deleting) return
    if (!canDelete) { toast.error(isEn ? DELETE_PERMISSION_HINT.en : DELETE_PERMISSION_HINT.zh); return }
    setDeleting(true)
    try {
      const changed = await deleteCustomersFlow([...selected], { isEn, noun: { zh: '客户', en: 'customer' } })
      if (changed) { setSelected(new Set()); loadPage(page, searchInput) }
    } finally {
      setDeleting(false)
    }
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
    if (key === 'primaryPricelistId') {
      // 列表里只改「主价格表」(排第一的那个)，其余已挂的价格表原样保留在它后面；选空白 = 去掉主价格表
      const current = (c.pricelists ?? []).slice().sort((a, b) => a.sequence - b.sequence).map(p => p.pricelistId)
      const rest = current.slice(1).filter(id => id !== newValue)
      const pricelistIds = newValue ? [String(newValue), ...rest] : rest
      try {
        await apiPut(`/api/customers/${c.id}`, { pricelistIds })
        setCustomers(prev => prev.map(row => row.id === c.id
          ? { ...row, pricelists: pricelistIds.map((pricelistId, idx) => ({ pricelistId, sequence: idx + 1 })) } as Customer
          : row))
        toast.success(isEn ? 'Saved' : '已保存')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
        throw e
      }
      return
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
  const activePricelists = pricelists.filter(p => p.active)

  const columns: OdooColumn[] = [
    { key: 'customerNo', label: isEn ? 'Customer No' : '客户编号', sortable: true },
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
      editType: 'search-select',
      editOptions: [{ value: '', label: '' }, ...userPickerOptions(salesUsers, null, isEn)],
      render: (_v, row) => row.salesman ? String(row.salesman) : <span className="text-gray-400">—</span>,
    },
    {
      key: 'paymentTerm',
      label: isEn ? 'Payment Term' : '结算方式',
      editable: true,
      editType: 'select',
      // 与详情页 Payment Terms 下拉同一份选项，第一项同样留空白
      editOptions: [{ value: '', label: '' }, ...PAYMENT_TERM_OPTIONS.map(o => ({ value: o.value, label: isEn ? o.labelEn : o.labelZh }))],
      render: (v) => v ? (
        <span className="inline-block px-2 py-0.5 rounded text-xs" style={{ background: '#f3eff5', color: '#6d4a66' }}>
          {PAYMENT_LABELS[String(v)] ?? String(v)}
        </span>
      ) : <span className="text-gray-400">—</span>,
    },
    {
      key: 'primaryPricelistId',
      label: isEn ? 'Pricelist' : '价格表',
      sortable: true,
      editable: true,
      editType: 'search-select',
      editOptions: [{ value: '', label: '' }, ...pricelists.map(p => ({ value: p.id, label: p.name }))],
      filterType: 'multi-select',
      filterOptions: activePricelists.map(p => ({ value: p.id, label: p.name })),
      filterLabelGetter: (v) => pricelistMap.get(v) ?? v,
      render: (_v, row) => {
        const links = (row.pricelists as { pricelistId: string }[] | undefined) ?? []
        if (links.length === 0) return <span className="text-gray-400">—</span>
        const primaryName = pricelistMap.get(links[0].pricelistId) ?? links[0].pricelistId
        const label = links.length > 1 ? `${primaryName} (+${links.length - 1})` : primaryName
        return (
          <Popover>
            <PopoverTrigger
              className="underline decoration-dotted underline-offset-2 hover:text-[#00a09d]"
              onClick={(e) => e.stopPropagation()}
            >
              {label}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72" onClick={(e) => e.stopPropagation()}>
              <PopoverHeader>
                <PopoverTitle>{isEn ? 'Applied Pricelists' : '挂靠的价格表'}</PopoverTitle>
              </PopoverHeader>
              <ul className="flex flex-col gap-1">
                {links.map((l, i) => (
                  <li key={l.pricelistId} className="flex items-baseline gap-1.5 text-sm">
                    <span className="text-gray-400 w-4 shrink-0 text-right">{i + 1}.</span>
                    <span>{pricelistMap.get(l.pricelistId) ?? l.pricelistId}</span>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        )
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
    ...(archivedOnly ? [{ label: isEn ? 'Archived Only' : '仅已归档', onRemove: () => setArchivedOnly(false) }] : []),
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
            { label: isEn ? `Archive (${selected.size})` : `归档 (${selected.size})`, onClick: handleDeleteSelected, disabled: deleting },
            { label: deleting ? (isEn ? 'Working...' : '处理中...') : (isEn ? `Delete (${selected.size})` : `删除 (${selected.size})`), onClick: handleHardDeleteSelected, style: 'red' as const, disabled: deleting },
          ] : []),
        ]}
        searchValue={searchInput}
        onSearch={setSearchInput}
        onSearchSubmit={() => loadPage(1, searchInput)}
        facetFields={localizeFacetFields(CUSTOMER_FACET_FIELDS, isEn)}
        onFacetAdd={addFacet}
        activeFilters={activeFilters}
        filterOptions={[
          ...PAYMENT_TERM_OPTIONS.map(o => ({ label: isEn ? `${o.labelEn} Customers` : `${o.labelZh}客户`, value: o.value })),
          { label: isEn ? 'Include Archived' : '包含已归档', value: '__archived__' },
          { label: isEn ? 'Archived Only' : '仅已归档', value: '__archived_only__' },
        ]}
        groupByOptions={[
          { label: isEn ? 'Payment Term' : '结算方式', value: 'paymentTerm' },
          { label: isEn ? 'Pricelist' : '价格表', value: 'pricelist' },
        ]}
        activeFilterValues={[
          ...(paymentFilter ? [paymentFilter] : []),
          ...(includeArchived ? ['__archived__'] : []),
          ...(archivedOnly ? ['__archived_only__'] : []),
        ]}
        onFilterSelect={v => {
          if (v === '__archived__') {
            setIncludeArchived(prev => { const next = !prev; if (next) setArchivedOnly(false); return next })
          } else if (v === '__archived_only__') {
            setArchivedOnly(prev => { const next = !prev; if (next) setIncludeArchived(false); return next })
          } else {
            // 再点一次已勾选的结算方式 = 取消(菜单里有 ✓ 之后，用户会这样操作)
            const next = paymentFilter === v ? '' : v
            setPaymentFilter(next)
            loadPage(1, searchInput, next, includeArchived)
          }
        }}
        groupByValue={groupBy}
        onGroupByChange={v => setGroupBy(prev => prev === v ? '' : v)}
        favouriteState={{ searchInput, paymentFilter, includeArchived, archivedOnly, isVendorOnly, groupBy, facets, columnMultiFilters, columnFilters, sortKey, sortDir }}
        onFavouriteApply={s => {
          setSearchInput(String(s.searchInput ?? ''))
          const pf = String(s.paymentFilter ?? '')
          setPaymentFilter(pf)
          setIncludeArchived(Boolean(s.includeArchived))
          setArchivedOnly(Boolean(s.archivedOnly))
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
        endpoint="/api/customers/bulk" historyResource="customer"
        title={{ zh: '批量导入客户(CSV)', en: 'Bulk Import Customers (CSV)' }}
        hint={{
          zh: '第一行为表头。仅「名称」必填。',
          en: 'Row 1 is the header. Name is the only required column.',
        }}
        extraHint={{
          zh: <>优先按客户编号匹配更新，其次按 ID。新客户请留空编号，系统自动生成。个人/公司填写 individual 或 company。状态填 Active / Inactive(Inactive = 归档)，留空不改。</>,
          en: <>Match by Customer No first, then ID. Leave Customer No blank for new customers; it is generated automatically. Contact Type accepts individual or company. Status accepts Active / Inactive (Inactive = archived); leave blank to keep it unchanged.</>,
        }}
        columns={[
          { key: 'customerNo', label: isEn ? 'Customer No' : '客户编号' },
          { key: 'externalId', label: isEn ? 'ID' : 'ID', aliases: ['External ID', '外部单号'] },
          { key: 'name', label: isEn ? 'Customer Name' : '客户名称', aliases: ['Name', '名称', 'Customer Name', '客户名称'], required: true },
          { key: 'phone', label: isEn ? 'Phone' : '电话' },
          { key: 'individualOrCompany', label: isEn ? 'Contact Type' : '个人/公司' },
          { key: 'mobile', label: isEn ? 'Mobile' : '手机' },
          { key: 'street', label: isEn ? 'Street' : '街道' },
          { key: 'street2', label: isEn ? 'Street 2' : '街道 2' },
          { key: 'state', label: isEn ? 'State' : '州/省' },
          { key: 'country', label: isEn ? 'Country' : '国家' },
          { key: 'email', label: isEn ? 'Email' : '邮箱' },
          { key: 'address', label: isEn ? 'Address' : '地址' },
          { key: 'city', label: isEn ? 'City' : '城市' },
          { key: 'zip', label: isEn ? 'ZIP' : '邮编' },
          { key: 'paymentTerm', label: isEn ? 'Payment Term' : '账期', aliases: ['Payment Term', 'Payment Terms', '结算方式', '账期'] },
          { key: 'salesman', label: isEn ? 'Salesperson' : '业务员', aliases: ['Salesman', 'Salesperson', '业务员', '销售员'] },
          { key: 'vatNumber', label: isEn ? 'VAT Number' : '税号' },
          { key: 'notes', label: isEn ? 'Notes' : '备注', aliases: ['Notes', 'Internal Notes', '内部备注'] },
          { key: 'isActive', label: isEn ? 'Status' : '状态', aliases: ['Status', '状态'] },
        ]}
        exampleRows={[
          ['', '', 'Demo Restaurant Ltd', '0851234567', 'company', '0857654321', '12 Main Street', 'Unit 2', 'Dublin', 'Ireland', '', '12 Main Street', 'Dublin', 'D01', 'monthly', '', 'IE1234567T', '', 'Active'],
        ]}
        onDone={() => loadPage(1, searchInput)}
      />
      {exportAction.dialog}
    </div>
  )
}
