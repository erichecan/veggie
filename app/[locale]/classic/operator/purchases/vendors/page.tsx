'use client'
/**
 * 采购模块下的供应商列表（Purchases → Vendors）
 * ============================================================================
 * 客户 20260906 反馈：供应商目前只能从 Customers 列表用「供货商」开关筛出来，
 * 和普通客户混在一张列表里，希望采购模块下单独有一个入口——列表 + 编辑 + 新建。
 *
 * 供应商与客户共用同一张 Customer 表（isVendor 布尔位区分，见 prisma/schema.prisma），
 * 所以这里不新建数据模型，列表仍直接查 `/api/customers?isVendor=1`（与 Customers 页
 * 的「供货商」开关走的是同一个后端查询）。
 *
 * ⛔ 20260907 客户决策：客户/供应商字段彻底分离，编辑/新建不再复用
 * `customers/[id]` 那张大表单——改用独立的 `purchases/vendors/[id]/page.tsx`。
 * 「一个联系人既是客户又是供应商」按客户要求分两条记录各自编辑，不共享表单。
 */
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import { Pagination } from '@/components/ui/pagination'
import type { Customer } from '@/lib/types'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'
import BulkImportDialog from '@/components/shared/BulkImportDialog'
import { useCsvExport } from '@/hooks/use-csv-export'
import { CUSTOMER_EXPORT_COLUMNS, CUSTOMER_EXPORT_COLUMNS_EN } from '@/lib/export/columns/customers'
import { hasPermission, useAbility } from '@/lib/permissions'
import { deleteCustomersFlow, DELETE_PERMISSION_HINT } from '@/components/customers/delete-customers'
import { useRefetchOnFocus } from '@/lib/hooks/use-refetch-on-focus'

// 供应商与客户同表，编号就是同一个 customerNo 序列(20261007)；导出时表头换成「供应商编号」
const VENDOR_EXPORT_COLUMNS = CUSTOMER_EXPORT_COLUMNS.map(c => c.key === 'customerNo' ? { ...c, header: '供应商编号', headerEn: 'Vendor No' } : c)
const VENDOR_EXPORT_COLUMNS_EN = CUSTOMER_EXPORT_COLUMNS_EN.map(c => c.key === 'customerNo' ? { ...c, header: 'Vendor No', headerEn: 'Vendor No' } : c)

const PAGE_SIZE = 20

export default function VendorsPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale

  const [vendors, setVendors] = useState<Customer[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [searchInput, setSearchInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [includeArchived, setIncludeArchived] = useState(false)
  // 只看已归档(20261008，与客户/商品列表同款)；与「包含已归档」互斥
  const [archivedOnly, setArchivedOnly] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const canDelete = hasPermission(useAbility(), 'master.customer.delete')

  // 导出吃与列表请求相同的筛选参数，服务端 suppliers 实体已经强制 isVendor=1
  // （见 lib/export/registry.ts），这里不用再自己拼一次
  const exportAction = useCsvExport({
    entity: 'suppliers',
    params: () => {
      const params = new URLSearchParams()
      if (searchInput) params.set('search', searchInput)
      if (includeArchived) params.set('includeArchived', '1')
      if (archivedOnly) params.set('archivedOnly', '1')
      return params
    },
    fallbackFilename: isEn ? 'suppliers.csv' : '供应商.csv',
    columns: isEn ? VENDOR_EXPORT_COLUMNS_EN : VENDOR_EXPORT_COLUMNS,
  })

  async function loadPage(p: number, q: string, archived = includeArchived) {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE), isVendor: '1' })
      if (q) params.set('search', q)
      if (archived) params.set('includeArchived', '1')
      if (archivedOnly) params.set('archivedOnly', '1')
      const res = await apiGet<{ data: Customer[]; total: number; page: number }>(`/api/customers?${params}`)
      setVendors(res.data)
      // 勾选只对当前看得见的行有效(20261007 客户反馈：搜索后只勾了 1 个，却提示删除 2 个——
      // 之前勾过、已被筛出列表的那条还留在 selected 里，会被看不见地一起删掉)
      setSelected(prev => {
        const visible = new Set(res.data.map(r => r.id))
        const next = new Set([...prev].filter(id => visible.has(id)))
        return next.size === prev.size ? prev : next
      })
      setTotal(res.total)
      setPage(res.page)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load vendors' : '加载供应商失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadPage(1, searchInput, includeArchived)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived, archivedOnly])

  useEffect(() => {
    const timer = setTimeout(() => loadPage(1, searchInput), 400)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  // 切去别的 tab 改了供应商数据后，切回来时刷新当前这一页（节流 30s）
  useRefetchOnFocus([() => loadPage(page, searchInput, includeArchived)])

  function openNew() {
    // 客户/供应商字段彻底分离(20260907)：不再复用 customers/[id] 那张表单，
    // 编辑/新建走独立的 purchases/vendors/[id]
    router.push(`${prefix}/classic/operator/purchases/vendors/new`)
  }
  function openEdit(v: Customer) {
    router.push(`${prefix}/classic/operator/purchases/vendors/${v.id}`)
  }

  async function handleArchiveSelected() {
    if (selected.size === 0 || busy) return
    if (!confirm(isEn
      ? `Archive ${selected.size} vendor(s)? They disappear from the vendor list and purchase pickers; all history is kept and can be restored.`
      : `确认归档 ${selected.size} 个供应商？归档后从供应商列表和采购选择中消失，历史完整保留，可恢复。`)) return
    setBusy(true)
    const results = await Promise.allSettled([...selected].map(id => apiPut(`/api/customers/${id}`, { isActive: false })))
    const ok = results.filter(r => r.status === 'fulfilled').length
    const fail = results.length - ok
    setBusy(false)
    setSelected(new Set())
    if (fail === 0) toast.success(isEn ? `Archived ${ok} vendor(s)` : `已归档 ${ok} 个供应商`)
    else toast.warning(isEn ? `${ok} succeeded, ${fail} failed` : `成功 ${ok} 个，失败 ${fail} 个`)
    loadPage(page, searchInput)
  }

  async function handleDeleteSelected() {
    if (selected.size === 0 || busy) return
    if (!canDelete) { toast.error(isEn ? DELETE_PERMISSION_HINT.en : DELETE_PERMISSION_HINT.zh); return }
    setBusy(true)
    try {
      const changed = await deleteCustomersFlow([...selected], { isEn, noun: { zh: '供应商', en: 'vendor' } })
      if (changed) { setSelected(new Set()); loadPage(page, searchInput) }
    } finally {
      setBusy(false)
    }
  }

  const columns: OdooColumn[] = [
    { key: 'customerNo', label: isEn ? 'Vendor No' : '供应商编号', render: v => <span className="text-gray-500 tabular-nums">{v != null ? String(v) : ''}</span> },
    {
      key: 'name',
      label: isEn ? 'Vendor Name' : '供应商名称',
      render: (_, row) => <span className="font-medium" style={{ color: '#875A7B' }}>{String(row.name ?? '')}</span>,
    },
    { key: 'address', label: isEn ? 'Address' : '地址', render: v => <span className="text-gray-600 text-xs">{String(v || '')}</span> },
    { key: 'phone', label: isEn ? 'Phone' : '电话', render: v => v ? String(v) : <span className="text-gray-400">—</span> },
    { key: 'vatNumber', label: isEn ? 'VAT Number' : '税号', render: v => v ? String(v) : <span className="text-gray-400">—</span> },
    {
      key: 'supplierPaymentTerm',
      label: isEn ? 'Payment Terms' : '付款条款',
      render: v => v ? <span className="inline-block px-2 py-0.5 rounded text-xs" style={{ background: '#f3eff5', color: '#6d4a66' }}>{String(v)}</span> : <span className="text-gray-400">—</span>,
    },
    {
      key: 'vendorTaxRate',
      label: isEn ? 'Vendor Tax Rate' : '采购税率',
      render: v => v != null ? `${(Number(v) * 100).toFixed(1)}%` : <span className="text-gray-400">—</span>,
    },
    {
      key: 'isActive',
      label: isEn ? 'Status' : '状态',
      render: v => (
        <span className={`inline-block px-2 py-0.5 rounded text-xs ${v !== false ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
          {v !== false ? (isEn ? 'Active' : '活跃') : (isEn ? 'Inactive' : '停用')}
        </span>
      ),
    },
  ]

  const activeFilters = [
    ...(includeArchived ? [{ label: isEn ? 'Include Archived' : '包含已归档', onRemove: () => setIncludeArchived(false) }] : []),
    ...(archivedOnly ? [{ label: isEn ? 'Archived Only' : '仅已归档', onRemove: () => setArchivedOnly(false) }] : []),
  ]

  return (
    <div>
      <OdooControlPanel
        breadcrumb={isEn ? ['Purchases', 'Vendors'] : ['采购', '供应商']}
        onNew={openNew}
        newLabel={isEn ? 'New' : '新建'}
        permanentActions={[
          { label: isEn ? 'Import' : '导入', onClick: () => setImportOpen(true) },
          exportAction,
          ...(selected.size > 0 ? [
            { label: isEn ? `Archive (${selected.size})` : `归档 (${selected.size})`, onClick: handleArchiveSelected, disabled: busy },
            { label: busy ? (isEn ? 'Working...' : '处理中...') : (isEn ? `Delete (${selected.size})` : `删除 (${selected.size})`), onClick: handleDeleteSelected, style: 'red' as const, disabled: busy },
          ] : []),
        ]}
        searchValue={searchInput}
        onSearch={setSearchInput}
        onSearchSubmit={() => loadPage(1, searchInput)}
        activeFilters={activeFilters}
        filterOptions={[
          { label: isEn ? 'Include Archived' : '包含已归档', value: '__archived__' },
          { label: isEn ? 'Archived Only' : '仅已归档', value: '__archived_only__' },
        ]}
        activeFilterValues={[
          ...(includeArchived ? ['__archived__'] : []),
          ...(archivedOnly ? ['__archived_only__'] : []),
        ]}
        onFilterSelect={v => {
          if (v === '__archived__') setIncludeArchived(prev => { const next = !prev; if (next) setArchivedOnly(false); return next })
          else if (v === '__archived_only__') setArchivedOnly(prev => { const next = !prev; if (next) setIncludeArchived(false); return next })
        }}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={p => loadPage(p, searchInput)}
      />

      <div className="p-4">
        <OdooTable
          columns={columns}
          rows={vendors as unknown as Record<string, unknown>[]}
          loading={loading}
          selected={selected}
          onSelectAll={checked => setSelected(checked ? new Set(vendors.map(v => v.id)) : new Set())}
          onSelectRow={(id, checked) => setSelected(prev => {
            const next = new Set(prev)
            if (checked) next.add(id)
            else next.delete(id)
            return next
          })}
          onRowClick={row => openEdit(row as unknown as Customer)}
          emptyText={isEn ? 'No vendors yet' : '暂无供应商'}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} onPageChange={p => loadPage(p, searchInput)} />
      </div>

      <BulkImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        templateFileName="vendors-import-template"
        endpoint="/api/suppliers/bulk" historyResource="supplier"
        title={{ zh: '批量导入供应商(CSV)', en: 'Bulk Import Vendors (CSV)' }}
        hint={{
          zh: '第一行为表头。仅「名称」必填。',
          en: 'Row 1 is the header. Name is the only required column.',
        }}
        extraHint={{
          zh: <>按「供应商编号」或「ID」精确匹配更新对应供应商(新供应商编号留空，系统自动生成)——保留从导出文件带出的「ID」列可可靠更新;没传/没匹配上则按名称:已有同名<b>客户</b>(还不是供应商)的,直接把它标成供应商(客户资料不覆盖,只补空字段);已有同名供应商的跳过,不覆盖;都没有则新建。状态填 Active / Inactive(Inactive = 归档)，留空不改。</>,
          en: <>Matched by Vendor No or ID (exact match) updates that vendor (leave Vendor No blank for new vendors; it is generated automatically) — keep the ID column from an exported file to reliably update. Otherwise by name: an existing <b>customer</b> with the same name (not yet a vendor) is marked as a vendor too (its details are kept, only empty fields filled); an existing vendor with the same name is skipped, not overwritten; no match creates a new one. Status accepts Active / Inactive (Inactive = archived); leave blank to keep it unchanged.</>,
        }}
        columns={[
          { key: 'customerNo', label: isEn ? 'Vendor No' : '供应商编号', aliases: ['Vendor No', '供应商编号', 'Customer No', '客户编号'] },
          { key: 'externalId', label: isEn ? 'ID' : 'ID', aliases: ['External ID', '外部单号'] },
          // 供应商导出沿用客户导出的列，名称列表头是 Customer Name / 客户名称，这里都认
          { key: 'name', label: isEn ? 'Name' : '名称', aliases: ['Vendor Name', '供应商名称', 'Customer Name', '客户名称'], required: true },
          { key: 'phone', label: isEn ? 'Phone' : '电话' },
          { key: 'email', label: isEn ? 'Email' : '邮箱' },
          { key: 'address', label: isEn ? 'Address' : '地址' },
          { key: 'city', label: isEn ? 'City' : '城市' },
          { key: 'zip', label: isEn ? 'ZIP' : '邮编' },
          { key: 'vatNumber', label: isEn ? 'VAT Number' : '税号' },
          { key: 'supplierPaymentTerm', label: isEn ? 'Payment Terms' : '付款条款' },
          { key: 'vendorTaxRate', label: isEn ? 'Vendor Tax Rate (0-1)' : '采购税率(0-1)' },
          { key: 'notes', label: isEn ? 'Notes' : '备注', aliases: ['Internal Notes', '内部备注'] },
          { key: 'isActive', label: isEn ? 'Status' : '状态', aliases: ['Status', '状态'] },
        ]}
        exampleRows={[
          ['', '', 'Demo Supplier Ltd', '0851234567', '', '12 Main Street', 'Dublin', 'D01', 'IE1234567T', '30 days', '0.135', '', 'Active'],
        ]}
        onDone={() => loadPage(1, searchInput)}
      />
      {exportAction.dialog}
    </div>
  )
}
