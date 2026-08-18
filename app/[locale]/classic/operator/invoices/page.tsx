'use client'
import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { Pagination } from '@/components/ui/pagination'
import type { Invoice, InvoiceLine, Order, Customer } from '@/lib/types'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useCsvExport } from '@/hooks/use-csv-export'
import { invoiceExportColumns } from '@/lib/export/columns/invoices'
import { useFacets } from '@/lib/use-facets'
import { filterByFacets } from '@/lib/facet-client'
import { INVOICE_FACET_DEFS, fieldsOf } from '@/lib/facets/client-defs'
import { SortTh, sortRows, type SortDir } from '@/components/shared/sort-th'

const STATUS_LABEL_ZH: Record<Invoice['status'], string> = {
  draft: '草稿',
  posted: '已确认',
  paid: '已付款',
  cancelled: '已取消',
}

const STATUS_LABEL_EN: Record<Invoice['status'], string> = {
  draft: 'Draft',
  posted: 'Posted',
  paid: 'Paid',
  cancelled: 'Cancelled',
}

const STATUS_COLOR: Record<Invoice['status'], string> = {
  draft: 'bg-gray-100 text-gray-600',
  posted: 'bg-blue-100 text-blue-700',
  paid: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-600',
}

const PAYMENT_LABELS_ZH: Record<string, string> = { cash: '现付', weekly: '周结', monthly: '月结' }
const PAYMENT_LABELS_EN: Record<string, string> = { cash: 'Cash', weekly: 'Weekly', monthly: 'Monthly' }

function buildInvoicePayload(
  orderIds: string[],
  orders: Order[],
  customers: Customer[],
  invoiceCount: number,
): Omit<Invoice, 'id'> | null {
  const selectedOrders = orders.filter(o => orderIds.includes(o.id))
  if (selectedOrders.length === 0) return null

  const firstOrder = selectedOrders[0]
  const customer = customers.find(c => c.id === firstOrder.restaurantId)

  const lineMap = new Map<string, InvoiceLine>()
  selectedOrders.forEach(order => {
    order.items.forEach(item => {
      const key = item.productId
      // Normalize: place-order stores percentage (e.g. 13.5), restaurant stores fraction (e.g. 0.135)
      const rawRate = item.taxRate ?? 0
      const taxRate = rawRate > 1 ? rawRate / 100 : rawRate
      if (lineMap.has(key)) {
        const l = lineMap.get(key)!
        l.qty += item.quantity
        l.subtotalExTax = Math.round(l.qty * l.unitPrice * (1 / (1 + taxRate)) * 100) / 100
        l.taxAmount = Math.round(l.subtotalExTax * taxRate * 100) / 100
        l.subtotalIncTax = Math.round(l.qty * l.unitPrice * 100) / 100
      } else {
        const subtotalIncTax = Math.round(item.price * item.quantity * 100) / 100
        const subtotalExTax = Math.round(subtotalIncTax / (1 + taxRate) * 100) / 100
        lineMap.set(key, {
          productId: item.productId,
          productName: item.productName,
          spec: item.spec,
          qty: item.quantity,
          unitPrice: item.price,
          taxRate,
          subtotalExTax,
          taxAmount: Math.round(subtotalIncTax - subtotalExTax),
          subtotalIncTax,
        })
      }
    })
  })

  const lines = Array.from(lineMap.values())
  const subtotalExTax = lines.reduce((acc, l) => acc + l.subtotalExTax, 0)
  const totalTax = lines.reduce((acc, l) => acc + l.taxAmount, 0)
  const totalIncTax = lines.reduce((acc, l) => acc + l.subtotalIncTax, 0)

  const invNum = String(invoiceCount + 1).padStart(4, '0')

  return {
    name: `INV-${invNum}`,
    customerId: firstOrder.restaurantId,
    customerName: firstOrder.restaurantName,
    saleOrderIds: orderIds,
    lines,
    subtotalExTax: Math.round(subtotalExTax * 100) / 100,
    totalTax: Math.round(totalTax * 100) / 100,
    totalIncTax: Math.round(totalIncTax * 100) / 100,
    amountPaid: 0,
    amountDue: Math.round(totalIncTax * 100) / 100,
    status: 'draft',
    paymentTerms: customer?.paymentTerm ?? 'cash',
    createdAt: new Date().toISOString(),
  }
}

function InvoiceRow({ inv, locale, isEn, onClick }: {
  inv: Invoice
  locale: string
  isEn: boolean
  onClick: () => void
}) {
  const [hover, setHover] = useState(false)
  const STATUS_LABEL = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH
  const PAYMENT_LABELS = isEn ? PAYMENT_LABELS_EN : PAYMENT_LABELS_ZH
  return (
    <tr
      style={{ background: hover ? '#f3eff5' : undefined, cursor: 'pointer' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
    >
      <td className="px-4 py-3 font-mono font-medium" style={{ color: '#875A7B' }}>
        {inv.name}
      </td>
      <td className="px-4 py-3 text-gray-800">{inv.customerName}</td>
      <td className="px-4 py-3 text-center">
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[inv.status]}`}>
          {STATUS_LABEL[inv.status]}
        </span>
      </td>
      <td className="px-4 py-3 text-right font-medium">€{inv.totalIncTax.toFixed(2)}</td>
      <td className={`px-4 py-3 text-right font-medium ${inv.amountDue > 0 ? 'text-orange-600' : 'text-green-600'}`}>
        €{inv.amountDue.toFixed(2)}
      </td>
      <td className="px-4 py-3 text-center text-gray-500">
        {PAYMENT_LABELS[inv.paymentTerms]}
      </td>
      <td className="px-4 py-3 text-center text-xs text-gray-400">
        {new Date(inv.createdAt).toLocaleDateString('en-GB')}
      </td>
      <td className="px-4 py-3 text-center" onClick={e => e.stopPropagation()}>
        <button
          onClick={onClick}
          className="text-xs hover:underline"
          style={{ color: '#875A7B' }}
        >
          {isEn ? 'View' : '查看'}
        </button>
      </td>
    </tr>
  )
}

export default function ClassicInvoicesPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale
  const STATUS_LABEL = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH
  const PAYMENT_LABELS = isEn ? PAYMENT_LABELS_EN : PAYMENT_LABELS_ZH
  const [invoices, setInvoices] = useState<Invoice[]>([])
  // 发票总数由服务端给（列表只加载最近 200 张），发票号 INV-${total+1} 依赖它
  const [invoiceTotal, setInvoiceTotal] = useState(0)
  const [orders, setOrders] = useState<Order[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [genOpen, setGenOpen] = useState(false)
  const [selectedCustomerId, setSelectedCustomerId] = useState('')
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([])
  const [generating, setGenerating] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [page, setPage] = useState(1)
  const [sortKey, setSortKey] = useState('createdAt')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [statusFilter, setStatusFilter] = useState<Invoice['status'] | ''>('')
  const [groupBy, setGroupBy] = useState('')

  async function load() {
    try {
      // 只取最近 200 张。以前这里拉全部 148,285 张（74 MB / 15 秒，且能把服务端内存
      // 推到 1.09 GiB），只为在浏览器里做搜索排序 —— 翻到第 700 页的需求并不存在。
      // total 必须来自服务端：发票号是 `INV-${total+1}`，用前端数组长度会和已有号撞
      // 车（Invoice.name 有唯一约束）。
      const [invPage, rawOrders, rawCustomers] = await Promise.all([
        apiGet<{ data: Record<string, unknown>[]; total: number }>('/api/invoices?page=1&pageSize=200'),
        apiGet<Record<string, unknown>[]>('/api/orders?status=COMPLETED,IN_DELIVERY,WAVE_ASSIGNED,CONFIRMED&include_lines=false'),
        apiGet<Customer[]>('/api/customers'),
      ])
      const normalizedInvoices: Invoice[] = (invPage.data ?? []).map(inv => ({
        ...(inv as unknown as Invoice),
        status: (inv.status as string).toLowerCase() as Invoice['status'],
        lines: (inv.lines as Invoice['lines']) ?? [],
        saleOrderIds: (inv.saleOrderIds as string[]) ?? [],
      }))
      const normalizedOrders: Order[] = rawOrders.map(o => ({
        ...(o as unknown as Order),
        status: (o.status as string).toLowerCase() as Order['status'],
        items: (o.items as Order['items']) ?? [],
      }))
      setInvoices(normalizedInvoices)
      setInvoiceTotal(invPage.total ?? normalizedInvoices.length)
      setOrders(normalizedOrders)
      setCustomers(rawCustomers)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load data' : '加载数据失败'))
    }
  }

  useEffect(() => { load() }, [])

  // 「该客户还没开票的已完成订单」。以前是拿全量发票在前端 some() 判断，现在只把
  // 这个客户的已完成订单 id 发过去精确反查 —— 判断 20 张单的开票状态不必扫全表。
  const [billedOrderIds, setBilledOrderIds] = useState<Set<string>>(new Set())
  const customerCompletedOrders = useMemo(
    () => orders.filter(o => o.restaurantId === selectedCustomerId && o.status === 'completed'),
    [orders, selectedCustomerId],
  )

  useEffect(() => {
    if (!selectedCustomerId || customerCompletedOrders.length === 0) {
      setBilledOrderIds(new Set())
      return
    }
    let cancelled = false
    const ids = customerCompletedOrders.map(o => o.id)
    apiGet<{ id: string; saleOrderIds: string[] }[]>(
      `/api/invoices?slim=1&orderIds=${encodeURIComponent(ids.join(','))}`,
    )
      .then(rows => {
        if (cancelled) return
        setBilledOrderIds(new Set(rows.flatMap(r => r.saleOrderIds ?? [])))
      })
      .catch(() => { if (!cancelled) setBilledOrderIds(new Set()) })
    return () => { cancelled = true }
  }, [selectedCustomerId, customerCompletedOrders])

  const unbilledOrders = customerCompletedOrders.filter(o => !billedOrderIds.has(o.id))

  function toggleOrder(id: string) {
    setSelectedOrderIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  async function handleGenerate() {
    if (generating) return
    if (!selectedOrderIds.length) {
      toast.error(isEn ? 'Please select at least one order' : '请至少选择一个订单')
      return
    }
    const payload = buildInvoicePayload(selectedOrderIds, orders, customers, invoiceTotal)
    if (!payload) { toast.error(isEn ? 'Failed to generate' : '生成失败'); return }

    setGenerating(true)
    try {
      const created = await apiPost<Invoice>('/api/invoices', payload)
      await load()
      setGenOpen(false)
      setSelectedOrderIds([])
      setSelectedCustomerId('')
      toast.success(isEn ? `Invoice ${created.name} generated` : `发票 ${created.name} 已生成`)
      router.push(`${prefix}/classic/operator/invoices/${created.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to generate invoice' : '生成发票失败'))
    } finally {
      setGenerating(false)
    }
  }

  const { facets, chips, controlPanelProps } = useFacets(fieldsOf(INVOICE_FACET_DEFS))

  const filtered = useMemo(() => {
    let base = invoices
    if (statusFilter) base = base.filter(inv => inv.status === statusFilter)
    if (searchInput) base = base.filter(inv =>
      inv.name.toLowerCase().includes(searchInput.toLowerCase()) ||
      inv.customerName.toLowerCase().includes(searchInput.toLowerCase())
    )
    // 分面：同维度 OR、跨维度 AND（与服务端类页面同一套语义，见 lib/facet-client.ts）
    base = filterByFacets(base, facets, INVOICE_FACET_DEFS)
    return sortRows(base, sortKey, sortDir)
  }, [invoices, searchInput, statusFilter, sortKey, sortDir, facets])

  // 这一页是全量拉取 + 客户端筛选，所以导出走本地模式：导的就是屏幕上这批已筛好的行。
  // 走服务端导出的话，服务端不认识这些客户端筛选条件，会变成「导出全部」。
  const exportAction = useCsvExport({
    columns: invoiceExportColumns(isEn),
    rows: () => filtered,
    filenameZh: '发票',
    filenameEn: 'Invoices',
  })

  const INVOICE_GB_FIELD: Record<string, keyof Invoice> = {
    customer: 'customerName',
    status: 'status',
    paymentTerms: 'paymentTerms',
  }

  const PAGE_SIZE = 20
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <div>
      <OdooControlPanel
        breadcrumb={isEn ? ['Finance', 'Invoices'] : ['财务', '发票']}
        permanentActions={[
          { label: isEn ? 'New' : '新建', onClick: () => { setGenOpen(true); setSelectedCustomerId(''); setSelectedOrderIds([]) }, primary: true },
          exportAction,
        ]}
        searchValue={searchInput}
        onSearch={v => { setSearchInput(v); setPage(1) }}
        onSearchSubmit={() => setPage(1)}
        {...controlPanelProps}
        activeFilters={[
          ...chips,
          ...(statusFilter ? [{ label: isEn ? `Status: ${STATUS_LABEL[statusFilter]}` : `状态：${STATUS_LABEL[statusFilter]}`, onRemove: () => setStatusFilter('') }] : []),
        ]}
        filterOptions={[
          { label: isEn ? 'Draft' : '草稿', value: 'draft' },
          { label: isEn ? 'Posted' : '已确认', value: 'posted' },
          { label: isEn ? 'Paid' : '已付款', value: 'paid' },
          { label: isEn ? 'Cancelled' : '已取消', value: 'cancelled' },
        ]}
        onFilterSelect={v => { setStatusFilter(prev => prev === v ? '' : v as Invoice['status']); setPage(1) }}
        groupByOptions={[
          { label: isEn ? 'Customer' : '客户', value: 'customer' },
          { label: isEn ? 'Status' : '状态', value: 'status' },
          { label: isEn ? 'Payment Terms' : '结款方式', value: 'paymentTerms' },
        ]}
        groupByValue={groupBy}
        onGroupByChange={v => setGroupBy(prev => prev === v ? '' : v)}
        favouriteState={{ searchInput, statusFilter, groupBy }}
        onFavouriteApply={s => {
          setSearchInput(String(s.searchInput ?? ''))
          setStatusFilter((s.statusFilter as Invoice['status']) ?? '')
          setGroupBy(String(s.groupBy ?? ''))
          setPage(1)
        }}
        storageKey="classic_invoices_favs"
        total={filtered.length}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
      />
      <div className="p-4">
        <div className="bg-white border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead style={{ background: '#f3eff5', borderBottom: '1px solid #ddd' }}>
              <tr>
                <SortTh sk="name" cur={sortKey} dir={sortDir} label={isEn ? 'Invoice No.' : '发票号'} onClick={k => { if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(k); setSortDir('asc') } }} />
                <SortTh sk="customerName" cur={sortKey} dir={sortDir} label={isEn ? 'Customer' : '客户'} onClick={k => { if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(k); setSortDir('asc') } }} />
                <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Status' : '状态'}</th>
                <SortTh sk="totalIncTax" cur={sortKey} dir={sortDir} label={isEn ? 'Total (incl. tax)' : '含税总额'} align="right" onClick={k => { if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(k); setSortDir('asc') } }} />
                <SortTh sk="amountDue" cur={sortKey} dir={sortDir} label={isEn ? 'Amount Due' : '待收款'} align="right" onClick={k => { if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(k); setSortDir('asc') } }} />
                <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Payment Terms' : '结款方式'}</th>
                <SortTh sk="createdAt" cur={sortKey} dir={sortDir} label={isEn ? 'Created At' : '创建时间'} align="center" onClick={k => { if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(k); setSortDir('asc') } }} />
                <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Actions' : '操作'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-gray-400">
                    {isEn ? 'No invoices yet. Click "New" to generate one from completed orders.' : '暂无发票，点击「生成发票」从已完成订单创建'}
                  </td>
                </tr>
              )}
              {(() => {
                const field = INVOICE_GB_FIELD[groupBy]
                if (!groupBy || !field || pageRows.length === 0) {
                  return pageRows.map(inv => (
                    <InvoiceRow key={inv.id} inv={inv} locale={locale} isEn={isEn} onClick={() => router.push(`${prefix}/classic/operator/invoices/${inv.id}`)} />
                  ))
                }
                const groups = new Map<string, Invoice[]>()
                for (const inv of pageRows) {
                  const key = String(inv[field] ?? '')
                  if (!groups.has(key)) groups.set(key, [])
                  groups.get(key)!.push(inv)
                }
                return Array.from(groups.entries()).flatMap(([key, groupInvs]) => [
                  <tr key={`__group__${key}`} style={{ background: '#f5f0f7', borderBottom: '2px solid #d4b8d0' }}>
                    <td colSpan={8} className="px-3 py-1.5 font-semibold text-sm" style={{ color: '#6d4a66' }}>
                      {groupBy === 'status' ? STATUS_LABEL[key as Invoice['status']] ?? key
                        : groupBy === 'paymentTerms' ? PAYMENT_LABELS[key] ?? key
                        : key || (isEn ? '(empty)' : '（空）')}
                      {' '}<span className="font-normal text-xs ml-1" style={{ color: '#a07898' }}>({groupInvs.length})</span>
                    </td>
                  </tr>,
                  ...groupInvs.map(inv => (
                    <InvoiceRow key={inv.id} inv={inv} locale={locale} isEn={isEn} onClick={() => router.push(`${prefix}/classic/operator/invoices/${inv.id}`)} />
                  )),
                ])
              })()}
            </tbody>
          </table>
        </div>
        <Pagination page={page} totalPages={Math.ceil(filtered.length / PAGE_SIZE)} onPageChange={setPage} />
      </div>

      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEn ? 'Generate Invoice from Orders' : '从订单生成发票'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm font-medium text-gray-700">{isEn ? 'Select Customer' : '选择客户'}</label>
              <select
                className="mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#875A7B]"
                value={selectedCustomerId}
                onChange={e => { setSelectedCustomerId(e.target.value); setSelectedOrderIds([]) }}
              >
                <option value="">{isEn ? 'Please select a customer...' : '请选择客户...'}</option>
                {customers.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            {selectedCustomerId && (
              <div>
                <label className="text-sm font-medium text-gray-700">
                  {isEn
                    ? `Select uninvoiced completed orders (${unbilledOrders.length} available)`
                    : `选择未开票的已完成订单（${unbilledOrders.length} 个可选）`}
                </label>
                {unbilledOrders.length === 0 ? (
                  <p className="mt-2 text-sm text-gray-400">{isEn ? 'This customer has no uninvoiced completed orders' : '该客户暂无未开票的已完成订单'}</p>
                ) : (
                  <div className="mt-2 space-y-2 max-h-60 overflow-y-auto border border-gray-200 rounded-lg p-2">
                    {unbilledOrders.map(o => (
                      <label key={o.id} className="flex items-center gap-3 p-2 rounded hover:bg-gray-50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedOrderIds.includes(o.id)}
                          onChange={() => toggleOrder(o.id)}
                          className="w-4 h-4 accent-[#875A7B]"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-800">{o.id.slice(-8)}</p>
                          <p className="text-xs text-gray-500">
                            {new Date(o.createdAt).toLocaleDateString('en-GB')} · {isEn ? `${o.items.length} items` : `${o.items.length} 种商品`}
                          </p>
                        </div>
                        <span className="text-sm font-medium text-orange-600">€{o.totalAmount.toFixed(2)}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenOpen(false)} disabled={generating}>{isEn ? 'Cancel' : '取消'}</Button>
            <Button
              disabled={selectedOrderIds.length === 0 || generating}
              onClick={handleGenerate}
              style={{ background: '#875A7B', borderColor: '#875A7B' }}
              className="text-white hover:opacity-90"
            >
              {generating ? (isEn ? 'Generating…' : '生成中…') : (isEn ? 'Generate Invoice' : '生成发票')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
