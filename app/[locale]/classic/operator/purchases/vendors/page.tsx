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
import { apiGet } from '@/lib/api'
import { Pagination } from '@/components/ui/pagination'
import type { Customer } from '@/lib/types'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import OdooTable, { OdooColumn } from '@/components/classic/OdooTable'

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

  async function loadPage(p: number, q: string, archived = includeArchived) {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE), isVendor: '1' })
      if (q) params.set('search', q)
      if (archived) params.set('includeArchived', '1')
      const res = await apiGet<{ data: Customer[]; total: number; page: number }>(`/api/customers?${params}`)
      setVendors(res.data)
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
  }, [includeArchived])

  useEffect(() => {
    const timer = setTimeout(() => loadPage(1, searchInput), 400)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  function openNew() {
    // 客户/供应商字段彻底分离(20260907)：不再复用 customers/[id] 那张表单，
    // 编辑/新建走独立的 purchases/vendors/[id]
    router.push(`${prefix}/classic/operator/purchases/vendors/new`)
  }
  function openEdit(v: Customer) {
    router.push(`${prefix}/classic/operator/purchases/vendors/${v.id}`)
  }

  const columns: OdooColumn[] = [
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
  ]

  return (
    <div>
      <OdooControlPanel
        breadcrumb={isEn ? ['Purchases', 'Vendors'] : ['采购', '供应商']}
        onNew={openNew}
        newLabel={isEn ? 'New' : '新建'}
        searchValue={searchInput}
        onSearch={setSearchInput}
        onSearchSubmit={() => loadPage(1, searchInput)}
        activeFilters={activeFilters}
        filterOptions={[
          { label: isEn ? 'Include Archived' : '包含已归档', value: '__archived__' },
        ]}
        onFilterSelect={v => { if (v === '__archived__') setIncludeArchived(true) }}
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
          onRowClick={row => openEdit(row as unknown as Customer)}
          emptyText={isEn ? 'No vendors yet' : '暂无供应商'}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} onPageChange={p => loadPage(p, searchInput)} />
      </div>
    </div>
  )
}
