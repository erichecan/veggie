'use client'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useCsvExport } from '@/hooks/use-csv-export'
import { creditNoteExportColumns } from '@/lib/export/columns/credit-notes'
import { useFacets } from '@/lib/use-facets'
import { filterByFacets, localizeClientFacetDefs, type ClientFacetDef } from '@/lib/facet-client'
import { useRefetchOnFocus } from '@/lib/hooks/use-refetch-on-focus'

type CnStatus = 'DRAFT' | 'CONFIRMED' | 'SETTLED' | 'CANCELLED'

interface CreditNoteLine {
  id: string
  productId: string
  productName: string
  quantity: number
  unitPrice: number
  taxRate: number
  subtotalExTax: number
  taxAmount: number
  subtotalIncTax: number
  reason?: string | null
  sourceOrderId?: string | null
  sourceTripId?: string | null
  sourceReturnId?: string | null
  sourceOrderCode?: string | null
  sequence?: number
}

interface CreditNote {
  id: string
  name: string
  customerName: string
  creditDate: string
  totalIncTax: number
  /** 剩余可抵扣/退款（20261014 L1） */
  amountRemaining?: number
  status: CnStatus
  notes?: string | null
  lines: CreditNoteLine[]
  createdAt: string
  sourceInvoice?: { id: string; name: string } | null
}

interface TripForGen {
  id: string
  restaurants?: { returns?: { status?: string }[] }[]
}

const STATUS_LABEL_ZH: Record<CnStatus, string> = {
  DRAFT: '草稿',
  CONFIRMED: '已确认',
  SETTLED: '已结算',
  CANCELLED: '已作废',
}

const STATUS_LABEL_EN: Record<CnStatus, string> = {
  DRAFT: 'Draft',
  CONFIRMED: 'Confirmed',
  SETTLED: 'Settled',
  CANCELLED: 'Cancelled',
}

const STATUS_COLOR: Record<CnStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  CONFIRMED: 'bg-blue-100 text-blue-700',
  SETTLED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-red-100 text-red-600',
}

const PAGE_SIZE = 20

const FACET_DEFS: ClientFacetDef<CreditNote>[] = [
  { key: 'name',     label: '单号', labelEn: 'Reference', values: r => [r.name] },
  { key: 'customer', label: '客户', labelEn: 'Customer',  values: r => [r.customerName] },
  { key: 'status',   label: '状态', labelEn: 'Status',    values: r => [r.status] },
  { key: 'product',  label: '商品', labelEn: 'Product',   values: r => r.lines.map(l => l.productName) },
]

export default function CreditNotesPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const STATUS_LABEL = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH
  const router = useRouter()

  const [notes, setNotes] = useState<CreditNote[]>([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<CnStatus | ''>('')
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [customers, setCustomers] = useState<Array<{ id: string; name: string }>>([])
  const [customerSearch, setCustomerSearch] = useState('')
  const [newCustomer, setNewCustomer] = useState<{ id: string; name: string } | null>(null)

  const load = useCallback(() => {
    apiGet<CreditNote[]>('/api/credit-notes')
      .then(setNotes)
      .catch(e => toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load credit notes' : '加载信用票失败')))
  }, [isEn])

  useEffect(() => { load() }, [load])

  // 信用票在别的 tab（如行程/退货页生成）改了之后，切回来希望看到最新结果
  useRefetchOnFocus([load])

  const { facets, chips, controlPanelProps, clear: clearFacets } = useFacets(localizeClientFacetDefs(FACET_DEFS, isEn))

  // 一键清除（20261017 客户反馈“清不掉筛选条件”）：本页全是前端 useMemo 过滤，
  // 重置 state 后 filtered 自动重算，无需手动重拉
  function clearAllFilters() {
    setSearch('')
    setStatusFilter('')
    clearFacets()
    setPage(1)
  }

  const filtered = useMemo(() => {
    let rows = notes
    if (statusFilter) rows = rows.filter(n => n.status === statusFilter)
    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter(n =>
        n.name.toLowerCase().includes(q) || n.customerName.toLowerCase().includes(q))
    }
    return filterByFacets(rows, facets, FACET_DEFS)
  }, [notes, statusFilter, search, facets])

  // 全量拉取 + 客户端筛选的页面 → 本地导出，导的就是屏幕上这批
  const exportAction = useCsvExport({
    columns: creditNoteExportColumns(isEn),
    rows: () => filtered,
    filenameZh: '贷记单',
    filenameEn: 'Credit Notes',
  })

  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  function openDetail(cn: CreditNote) {
    router.push(`${prefix}/classic/operator/credit-notes/${cn.id}`)
  }

  async function openNewCreditNote() {
    setNewOpen(true)
    setCustomerSearch('')
    setNewCustomer(null)
    try {
      const rows = await apiGet<Array<{ id: string; name: string; isActive?: boolean }>>('/api/customers?slim=1')
      setCustomers(rows.filter(row => row.isActive !== false))
    } catch (e) { toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load customers' : '加载客户失败')) }
  }

  async function createBlankDraft() {
    if (!newCustomer) return
    setBusy(true)
    try {
      const created = await apiPost<{ id: string; name: string }>('/api/credit-notes', {
        customerId: newCustomer.id, customerName: newCustomer.name, lines: [],
      })
      setNewOpen(false)
      router.push(`${prefix}/classic/operator/credit-notes/${created.id}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to create draft' : '创建草稿失败')) }
    finally { setBusy(false) }
  }

  // 扫描含「已批准退货」的行程,一键生成信用票
  async function generateFromReturns() {
    setBusy(true)
    try {
      const trips = await apiGet<TripForGen[]>('/api/trips')
      const tripIds = trips
        .filter(t => (t.restaurants ?? []).some(r =>
          (r.returns ?? []).some(ret => (ret.status ?? '').toUpperCase() === 'APPROVED')))
        .slice(0, 50)
        .map(t => t.id)
      if (tripIds.length === 0) {
        toast.info(isEn
          ? 'No approved returns pending settlement (approve returns on the Returns page first)'
          : '没有待结算的已批准退货(请先在退换货页批准)')
        return
      }
      const result = await apiPost<{ created?: number; creditNotes?: unknown[] }>(
        '/api/credit-notes/generate-from-returns', { tripIds })
      const n = result.created ?? (result.creditNotes?.length ?? 0)
      toast.success(isEn ? `Generated ${n} credit note(s) from returns` : `已从退货生成 ${n} 张信用票`)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Generation failed' : '生成失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <OdooControlPanel
        breadcrumb={isEn ? ['Finance', 'Credit Notes'] : ['财务', '信用票']}
        permanentActions={[
          { label: isEn ? 'New credit note' : '新建贷记单', onClick: openNewCreditNote, primary: true },
          { label: isEn ? 'Backfill legacy returns' : '补生成旧退货贷记单', onClick: generateFromReturns, primary: true },
          exportAction,
        ]}
        searchValue={search}
        onSearch={v => { setSearch(v); setPage(1) }}
        {...controlPanelProps}
        activeFilters={[
          ...chips,
          ...(statusFilter ? [{ label: `${isEn ? 'Status' : '状态'}：${STATUS_LABEL[statusFilter]}`, onRemove: () => setStatusFilter('') }] : []),
        ]}
        filterOptions={[
          { label: isEn ? 'Draft' : '草稿', value: 'DRAFT' },
          { label: isEn ? 'Confirmed' : '已确认', value: 'CONFIRMED' },
          { label: isEn ? 'Settled' : '已结算', value: 'SETTLED' },
          { label: isEn ? 'Cancelled' : '已作废', value: 'CANCELLED' },
        ]}
        onFilterSelect={v => { setStatusFilter(prev => prev === v ? '' : v as CnStatus); setPage(1) }}
        onClearAll={clearAllFilters}
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
                <th className="text-left px-4 py-3 font-medium text-gray-600">{isEn ? 'No.' : '单号'}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{isEn ? 'Customer' : '客户'}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{isEn ? 'Source Invoice' : '来源发票'}</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Status' : '状态'}</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">{isEn ? 'Amount (Inc. Tax)' : '含税金额'}</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">{isEn ? 'Remaining' : '剩余可用'}</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Lines' : '行数'}</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Refund Date' : '退款日期'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {pageRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-gray-400">
                    {isEn
                      ? 'No credit notes · create a blank draft or approve a return to generate one automatically'
                      : '暂无贷记单 · 可新建空白草稿，或在退换货审核通过后自动生成'}
                  </td>
                </tr>
              )}
              {pageRows.map(cn => (
                <tr key={cn.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => openDetail(cn)}>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{cn.name}</td>
                  <td className="px-4 py-3 text-gray-800">{cn.customerName}</td>
                  <td className="px-4 py-3 text-xs">{cn.sourceInvoice ? <a className="font-mono text-[#714B67] hover:underline" href={`${prefix}/classic/finance/invoices/${cn.sourceInvoice.id}`} onClick={e => e.stopPropagation()}>{cn.sourceInvoice.name}</a> : '—'}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[cn.status]}`}>
                      {STATUS_LABEL[cn.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-900">€{Number(cn.totalIncTax).toFixed(2)}</td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {['CONFIRMED', 'SETTLED'].includes(cn.status) && cn.amountRemaining != null ? `€${Number(cn.amountRemaining).toFixed(2)}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-center text-gray-600">{cn.lines.length}</td>
                  <td className="px-4 py-3 text-center text-xs text-gray-500">
                    {new Date(cn.creditDate).toLocaleDateString('en-GB')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader><DialogTitle>{isEn ? 'New blank credit note' : '新建空白贷记单'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-gray-500">{isEn ? 'Choose a customer. The draft starts with no invoice lines.' : '选择客户后创建空白草稿，不会复制发票或退货明细。'}</p>
            <input autoFocus value={customerSearch} onChange={e => { setCustomerSearch(e.target.value); setNewCustomer(null) }} placeholder={isEn ? 'Search customers…' : '搜索客户…'} className="w-full rounded border px-3 py-2" />
            <div className="max-h-64 overflow-y-auto rounded border divide-y">
              {customers.filter(c => c.name.toLowerCase().includes(customerSearch.trim().toLowerCase())).slice(0, 60).map(customer => <button key={customer.id} className={`block w-full px-3 py-2 text-left text-sm hover:bg-purple-50 ${newCustomer?.id === customer.id ? 'bg-purple-50 font-semibold' : ''}`} onClick={() => { setNewCustomer(customer); setCustomerSearch(customer.name) }}>{customer.name}</button>)}
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setNewOpen(false)}>{isEn ? 'Cancel' : '取消'}</Button><Button disabled={!newCustomer || busy} onClick={createBlankDraft}>{isEn ? 'Create blank draft' : '创建空白草稿'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
