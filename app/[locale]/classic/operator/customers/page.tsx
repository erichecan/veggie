'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { Pagination } from '@/components/ui/pagination'
import type { Customer, OdooPricelist } from '@/lib/types'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'
import CsvImportDialog from '@/components/classic/CsvImportDialog'

const PAGE_SIZE = 20

const PAYMENT_LABELS_ZH: Record<string, string> = { cash: '现付', weekly: '周结', monthly: '月结' }
const PAYMENT_LABELS_EN: Record<string, string> = { cash: 'Cash', weekly: 'Weekly', monthly: 'Monthly' }

export default function ClassicCustomersPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale
  const PAYMENT_LABELS = isEn ? PAYMENT_LABELS_EN : PAYMENT_LABELS_ZH

  const [customers, setCustomers] = useState<Customer[]>([])
  const [pricelists, setPricelists] = useState<OdooPricelist[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [searchInput, setSearchInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [paymentFilter, setPaymentFilter] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [isReadMode, setIsReadMode] = useState(true)
  const [groupBy, setGroupBy] = useState('')
  const [importOpen, setImportOpen] = useState(false)

  async function loadPage(p: number, q: string, payTerm = paymentFilter, archived = includeArchived) {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
      if (q) params.set('search', q)
      if (payTerm) params.set('paymentTerm', payTerm)
      if (archived) params.set('includeArchived', '1')
      const res = await apiGet<{ data: Customer[]; total: number; page: number }>(`/api/customers?${params}`)
      setCustomers(res.data)
      setTotal(res.total)
      setPage(res.page)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load customers' : '加载客户失败'))
    } finally {
      setLoading(false)
    }
  }

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
    { key: 'vatNumber', label: isEn ? 'VAT Number' : '税号' },
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
      key: 'pricelistId',
      label: isEn ? 'Pricelist' : '价格表',
      render: (v) => v ? (pricelistMap.get(String(v)) ?? String(v)) : <span className="text-gray-400">—</span>,
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
          ...(selected.size > 0 ? [
            { label: isEn ? `Export (${selected.size})` : `导出 (${selected.size})`, onClick: () => toast.info(isEn ? 'Export coming soon' : '导出功能即将推出') },
            { label: isEn ? `Delete (${selected.size})` : `删除 (${selected.size})`, onClick: () => toast.info(isEn ? 'Delete coming soon' : '删除功能即将推出') },
          ] : []),
        ]}
        searchValue={searchInput}
        onSearch={setSearchInput}
        onSearchSubmit={() => loadPage(1, searchInput)}
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
        pageSize={PAGE_SIZE}
        onPageChange={p => loadPage(p, searchInput)}
      />

      <div className="p-4">
        <OdooTable
          columns={columns}
          rows={customers as unknown as Record<string, unknown>[]}
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
          groupByField={groupBy === 'paymentTerm' ? 'paymentTerm' : groupBy === 'pricelist' ? 'pricelistId' : ''}
          groupByFormatter={(key, count) => {
            const emptyLabel = isEn ? '(none)' : '（空）'
            let label: string
            if (groupBy === 'paymentTerm') label = PAYMENT_LABELS[key] ?? (key || emptyLabel)
            else if (groupBy === 'pricelist') label = pricelistMap.get(key) ?? (key || emptyLabel)
            else label = key || emptyLabel
            return <>{label} <span className="font-normal text-xs ml-1" style={{ color: '#a07898' }}>({count})</span></>
          }}
        />
        <Pagination page={page} totalPages={Math.ceil(total / PAGE_SIZE)} onPageChange={p => loadPage(p, searchInput)} />
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
