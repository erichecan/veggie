'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'
import { Pagination } from '@/components/ui/pagination'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useCsvExport } from '@/hooks/use-csv-export'
import { formatDateOnly, formatDateTime } from '@/lib/format-date'
import { DatePicker } from '@/components/ui/date-picker'
import { SearchableDropdown } from '@/components/shared/searchable-dropdown'
import { useRefetchOnFocus } from '@/lib/hooks/use-refetch-on-focus'

interface Statement {
  id: string
  customerId: string
  customerName: string
  periodStart: string
  periodEnd: string
  openingBalance: number
  totalSales: number
  totalPayments: number
  totalCredits: number
  closingBalance: number
  status: string
  createdAt: string
  sentAt: string | null
}

interface StatementOrderLine {
  id: string
  code: string | null
  status: string
  confirmationDate: string | null
  deliveryDate: string | null
  incTaxTotal: number
  invoices: Array<{ name: string; issueDate: string }>
}

interface StatementPaymentLine {
  id: string
  invoiceId: string
  invoiceName: string | null
  amount: number
  method: string | null
  paidAt: string | null
  note: string | null
  createdBy: string | null
  source: 'DRIVER_CASH' | 'MANUAL'
  confirmationId: string | null
}

interface StatementDetail extends Statement {
  orders: StatementOrderLine[]
  payments: StatementPaymentLine[]
  credits: Array<{ id: string; name: string; creditDate: string; amount: number; subtotalExTax: number; tax: number; notes: string | null; sourceOrderIds: string[] }>
  missingOrderIds: string[]
  reconciliation: {
    ok: boolean
    salesFromOrders: number
    salesDiff: number
    paymentsFromRecords: number
    paymentsDiff: number
    closingExpected: number
    closingDiff: number
    problems: string[]
  }
}

interface Customer {
  id: string
  name: string
}

const STATUS_LABEL_ZH: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  sent: '已发送',
}
const STATUS_LABEL_EN: Record<string, string> = {
  draft: 'Draft',
  confirmed: 'Confirmed',
  sent: 'Sent',
}
const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  confirmed: 'bg-blue-50 text-blue-700',
  sent: 'bg-green-50 text-green-700',
}

const STATUS_TABS_ZH = [
  { key: 'all', label: '全部' },
  { key: 'draft', label: '草稿' },
  { key: 'confirmed', label: '已确认' },
  { key: 'sent', label: '已发送' },
]
const STATUS_TABS_EN = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'sent', label: 'Sent' },
]

const PAGE_SIZE = 50

export default function StatementsPage() {
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const STATUS_LABEL = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH
  const STATUS_TABS = isEn ? STATUS_TABS_EN : STATUS_TABS_ZH

  const [items, setItems] = useState<Statement[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('all')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  // Create dialog
  const [showCreate, setShowCreate] = useState(false)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [formCustomerId, setFormCustomerId] = useState('')
  const [formStart, setFormStart] = useState('')
  const [formEnd, setFormEnd] = useState('')
  const [creating, setCreating] = useState(false)

  // Detail view
  const [detail, setDetail] = useState<Statement | null>(null)
  const [updating, setUpdating] = useState(false)
  /** 逐笔明细（台账 G1 验收：金额与订单明细可逐笔对上）—— 展开时才拉 */
  const [detailData, setDetailData] = useState<StatementDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const openDetail = useCallback(async (s: Statement) => {
    setDetail(s)
    setDetailData(null)
    setDetailLoading(true)
    try {
      setDetailData(await apiGet<StatementDetail>(`/api/statements/${s.id}?withDetail=1`))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load details' : '加载明细失败'))
    } finally {
      setDetailLoading(false)
    }
  }, [isEn])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (activeTab !== 'all') params.set('status', activeTab)
      params.set('page', String(page))
      params.set('pageSize', String(PAGE_SIZE))
      const data = await apiGet<{ items: Statement[]; total: number }>(`/api/statements?${params}`)
      setItems(data.items ?? [])
      setTotal(data.total ?? 0)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [activeTab, page, isEn])

  // 导出与列表同参（状态页签），服务端复用同一个 buildStatementsWhere
  const exportAction = useCsvExport({
    entity: 'statements',
    params: () => {
      const params = new URLSearchParams()
      if (activeTab !== 'all') params.set('status', activeTab)
      return params
    },
    fallbackFilename: isEn ? 'statements.csv' : '对账单.csv',
  })

  useEffect(() => { load() }, [load])

  // 对账单列表在别的 tab 改了之后，切回这个已打开的页面希望看到最新结果
  useRefetchOnFocus([load])

  useEffect(() => {
    apiGet<{ items: Customer[] }>('/api/customers?limit=500')
      .then(d => setCustomers(d.items ?? []))
      .catch(() => {})
  }, [])

  function handleTabChange(tab: string) {
    setActiveTab(tab)
    setPage(1)
  }

  async function handleCreate() {
    if (!formCustomerId || !formStart || !formEnd) {
      toast.error(isEn ? 'Please fill in all fields' : '请填写完整信息')
      return
    }
    setCreating(true)
    try {
      await apiPost('/api/statements', {
        customerId: formCustomerId,
        periodStart: formStart,
        periodEnd: formEnd,
      })
      toast.success(isEn ? 'Statement generated' : '对账单已生成')
      setShowCreate(false)
      setFormCustomerId('')
      setFormStart('')
      setFormEnd('')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to create' : '创建失败'))
    } finally {
      setCreating(false)
    }
  }

  async function handleStatusChange(id: string, newStatus: string) {
    setUpdating(true)
    try {
      const updated = await apiPut<Statement>(`/api/statements/${id}`, { status: newStatus })
      toast.success(isEn
        ? `Status updated to ${STATUS_LABEL[newStatus] ?? newStatus}`
        : `状态已更新为 ${STATUS_LABEL[newStatus] ?? newStatus}`)
      if (detail?.id === id) setDetail(updated)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to update' : '更新失败'))
    } finally {
      setUpdating(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(isEn ? 'Delete this statement?' : '确定删除此对账单？')) return
    try {
      await apiDelete(`/api/statements/${id}`)
      toast.success(isEn ? 'Deleted' : '已删除')
      setDetail(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to delete' : '删除失败'))
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Detail view
  if (detail) {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <OdooControlPanel
          breadcrumb={isEn ? ['Finance', 'Statements', detail.customerName] : ['财务', '对账单', detail.customerName]}
          permanentActions={[
            { label: isEn ? '← Back' : '← 返回', onClick: () => setDetail(null) },
            ...(detail.status === 'draft' ? [
              { label: isEn ? 'Confirm' : '确认', onClick: () => handleStatusChange(detail.id, 'confirmed'), primary: true },
              { label: isEn ? 'Delete' : '删除', onClick: () => handleDelete(detail.id) },
            ] : []),
            ...(detail.status === 'confirmed' ? [
              { label: isEn ? 'Send' : '发送', onClick: () => handleStatusChange(detail.id, 'sent'), primary: true },
              { label: isEn ? 'Revert to Draft' : '退回草稿', onClick: () => handleStatusChange(detail.id, 'draft') },
            ] : []),
          ]}
          searchValue=""
          onSearch={() => {}}
        />

        <div className="p-6 space-y-6">
          {/* Status badge */}
          <div className="flex items-center gap-3">
            <span className={`inline-block px-3 py-1 rounded text-sm font-medium ${STATUS_COLOR[detail.status] ?? 'bg-gray-100 text-gray-600'}`}>
              {STATUS_LABEL[detail.status] ?? detail.status}
            </span>
            {updating && <span className="text-xs text-gray-400">{isEn ? 'Updating...' : '更新中...'}</span>}
          </div>

          {/* Info cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <InfoCard label={isEn ? 'Customer' : '客户'} value={detail.customerName} />
            <InfoCard label={isEn ? 'Period' : '账期'} value={`${fmtDate(detail.periodStart)} ~ ${fmtDate(detail.periodEnd)}`} />
            <InfoCard label={isEn ? 'Created' : '创建时间'} value={fmtDateTime(detail.createdAt)} />
            {detail.sentAt && <InfoCard label={isEn ? 'Sent' : '发送时间'} value={fmtDateTime(detail.sentAt)} />}
          </div>
          {detailData && <div className="flex flex-wrap gap-2">
            <button onClick={() => downloadStatementCsv(detail, detailData, isEn)} className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">{isEn ? 'Download customer statement CSV' : '下载客户交易流水 CSV'}</button>
            <button onClick={() => printStatementPdf(detail, detailData, isEn)} className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">{isEn ? 'Print / Save PDF' : '打印 / 保存为 PDF'}</button>
          </div>}

          {/* Financial summary */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 font-medium text-gray-700">{isEn ? 'Financial Summary' : '财务汇总'}</div>
            <div className="divide-y divide-gray-100">
              <FinanceRow label={isEn ? 'Opening Balance' : '期初余额'} amount={detail.openingBalance} />
              <FinanceRow label={isEn ? '+ Sales This Period' : '+ 本期销售额'} amount={detail.totalSales} positive />
              <FinanceRow label={isEn ? '- Payments This Period' : '- 本期付款额'} amount={detail.totalPayments} negative />
              <FinanceRow label={isEn ? '- Credit Notes This Period' : '- 本期贷记单'} amount={detail.totalCredits} negative />
              <FinanceRow label={isEn ? 'Closing Balance' : '期末余额'} amount={detail.closingBalance} bold />
            </div>
          </div>

          {/* 逐笔明细 —— 验收要求「金额与订单明细可逐笔对上」。
              核对结果由服务端当场算（lib/finance/statement.reconcileStatement），
              页面不自己再算一遍：两边各算一次，差异出现时反而说不清谁对。 */}
          {detailLoading && <div className="text-sm text-gray-400">{isEn ? 'Loading details...' : '明细加载中...'}</div>}
          {detailData && (
            <>
              <div className={`rounded-lg border p-4 ${detailData.reconciliation.ok ? 'border-emerald-200 bg-emerald-50/50' : 'border-red-300 bg-red-50/60'}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-sm font-medium ${detailData.reconciliation.ok ? 'text-emerald-700' : 'text-red-700'}`}>
                    {detailData.reconciliation.ok
                      ? (isEn ? '✓ Reconciled with line items' : '✓ 与明细逐笔对上')
                      : (isEn ? '⚠ Does not reconcile with line items' : '⚠ 与明细对不上')}
                  </span>
                  <span className="text-xs text-gray-600">
                    {isEn
                      ? <>Order total €{detailData.reconciliation.salesFromOrders.toFixed(2)} ({detailData.orders.length} orders)
                        {' '}· Payment total €{detailData.reconciliation.paymentsFromRecords.toFixed(2)} ({detailData.payments.length} entries)</>
                      : <>订单明细合计 €{detailData.reconciliation.salesFromOrders.toFixed(2)}（{detailData.orders.length} 单）
                        · 收款流水合计 €{detailData.reconciliation.paymentsFromRecords.toFixed(2)}（{detailData.payments.length} 笔）</>}
                  </span>
                </div>
                {detailData.reconciliation.problems.map((p, i) => (
                  <p key={i} className="text-xs text-red-700 mt-1">{p}</p>
                ))}
                {detailData.missingOrderIds.length > 0 && (
                  <p className="text-xs text-red-700 mt-1">
                    {isEn
                      ? `${detailData.missingOrderIds.length} order(s) no longer exist (deleted after generation) — fewer line items than the statement total`
                      : `有 ${detailData.missingOrderIds.length} 张单据已不存在（生成后被删），明细条数比对账单少`}
                  </p>
                )}
              </div>

              <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-100 font-medium text-gray-700">
                  {isEn ? 'Orders This Period' : '本期订单明细'} <span className="text-xs font-normal text-gray-400">{isEn ? 'by delivery date' : '按配送日期'} · {isEn ? 'Invoice number/date shown when issued' : '同时显示发票号和开票日期'}</span>
                </div>
                {detailData.orders.length === 0 ? (
                  <div className="px-5 py-6 text-sm text-gray-400">{isEn ? 'No confirmed orders this period' : '本期没有已确认的订单'}</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-500 bg-gray-50 border-b border-gray-100">
                        <th className="text-left px-5 py-2">{isEn ? 'Order #' : '订单号'}</th>
                        <th className="text-left px-3 py-2">{isEn ? 'Confirmed' : '确认日期'}</th>
                        <th className="text-left px-3 py-2">{isEn ? 'Delivery Date' : '配送日期'}</th>
                        <th className="text-left px-3 py-2">{isEn ? 'Invoice #' : '发票号'}</th>
                        <th className="text-left px-3 py-2">{isEn ? 'Invoice Date' : '开票日期'}</th>
                        <th className="text-left px-3 py-2">{isEn ? 'Status' : '状态'}</th>
                        <th className="text-right px-5 py-2">{isEn ? 'Amount (Inc. Tax)' : '含税金额'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailData.orders.map(o => (
                        <tr key={o.id} className="border-b border-gray-50">
                          <td className="px-5 py-2 text-gray-800">{o.code ?? '—'}</td>
                          <td className="px-3 py-2 text-gray-600">{fmtDate(o.confirmationDate)}</td>
                          <td className="px-3 py-2 text-gray-600">{fmtDate(o.deliveryDate)}</td>
                          <td className="px-3 py-2 text-gray-600">{o.invoices.length ? o.invoices.map(i => i.name).join(', ') : (isEn ? 'Pending' : '待开票')}</td>
                          <td className="px-3 py-2 text-gray-600">{o.invoices.length ? o.invoices.map(i => fmtDate(i.issueDate)).join(', ') : '—'}</td>
                          <td className="px-3 py-2 text-gray-500">{o.status}</td>
                          <td className="px-5 py-2 text-right text-gray-800">€{Number(o.incTaxTotal).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-gray-200 font-medium">
                        <td className="px-5 py-2 text-gray-600" colSpan={6}>{isEn ? 'Total' : '合计'}</td>
                        <td className="px-5 py-2 text-right text-gray-800">€{detailData.reconciliation.salesFromOrders.toFixed(2)}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>

              <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-100 font-medium text-gray-700">{isEn ? 'Credit Notes This Period' : '本期贷记单'}</div>
                {detailData.credits.length === 0 ? <div className="px-5 py-5 text-sm text-gray-400">{isEn ? 'No credit notes this period' : '本期没有已确认的贷记单'}</div> : (
                  <table className="w-full text-sm"><thead><tr className="bg-gray-50 text-xs text-gray-500"><th className="text-left px-5 py-2">{isEn ? 'Credit Note #' : '贷记单号'}</th><th className="text-left px-3 py-2">{isEn ? 'Date' : '生效日期'}</th><th className="text-left px-3 py-2">{isEn ? 'Related Orders' : '关联订单'}</th><th className="text-left px-3 py-2">{isEn ? 'Reason' : '原因'}</th><th className="text-right px-3 py-2">{isEn ? 'Ex. tax' : '未税金额'}</th><th className="text-right px-3 py-2">{isEn ? 'Tax' : '税额'}</th><th className="text-right px-5 py-2">{isEn ? 'Inc. tax' : '含税贷项'}</th></tr></thead>
                    <tbody>{detailData.credits.map(c => <tr key={c.id} className="border-t border-gray-100"><td className="px-5 py-2">{c.name}</td><td className="px-3 py-2">{fmtDate(c.creditDate)}</td><td className="px-3 py-2">{c.sourceOrderIds.map(id => detailData.orders.find(o => o.id === id)?.code ?? id.slice(0, 8)).join(', ') || '—'}</td><td className="px-3 py-2">{c.notes ?? '—'}</td><td className="px-3 py-2 text-right">€{c.subtotalExTax.toFixed(2)}</td><td className="px-3 py-2 text-right">€{c.tax.toFixed(2)}</td><td className="px-5 py-2 text-right text-red-700">−€{c.amount.toFixed(2)}</td></tr>)}</tbody>
                    <tfoot><tr className="border-t font-medium"><td colSpan={6} className="px-5 py-2">{isEn ? 'Total credits' : '贷项合计'}</td><td className="px-5 py-2 text-right">−€{detail.totalCredits.toFixed(2)}</td></tr></tfoot></table>
                )}
              </div>

              <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-100 font-medium text-gray-700">
                  {isEn ? 'Payments This Period' : '本期收款明细'} <span className="text-xs font-normal text-gray-400">{isEn ? 'Driver cash and transfers are labeled separately' : '司机现金与汇款分开标注'}</span>
                </div>
                {detailData.payments.length === 0 ? (
                  <div className="px-5 py-6 text-sm text-gray-400">{isEn ? 'No payments this period' : '本期没有收款流水'}</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-500 bg-gray-50 border-b border-gray-100">
                        <th className="text-left px-5 py-2">{isEn ? 'Payment Date' : '收款日期'}</th>
                        <th className="text-left px-3 py-2">{isEn ? 'Applied to Invoice' : '核销到发票'}</th>
                        <th className="text-left px-3 py-2">{isEn ? 'Source' : '来源'}</th>
                        <th className="text-left px-3 py-2">{isEn ? 'Handled By' : '经手'}</th>
                        <th className="text-right px-5 py-2">{isEn ? 'Amount' : '金额'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailData.payments.map(p => (
                        <tr key={p.id} className="border-b border-gray-50">
                          <td className="px-5 py-2 text-gray-600">{fmtDate(p.paidAt)}</td>
                          <td className="px-3 py-2 text-gray-800">{p.invoiceName ?? p.invoiceId.slice(0, 8)}</td>
                          <td className="px-3 py-2">
                            {p.source === 'DRIVER_CASH' ? (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700" title={p.note ?? ''}>{isEn ? 'Driver cash handover' : '司机现金交账'}</span>
                            ) : (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">
                                {p.method === 'cash' ? (isEn ? 'Cash' : '现金') : p.method === 'transfer' ? (isEn ? 'Transfer' : '汇款') : (isEn ? 'Other' : '其他')}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-gray-500">{p.createdBy ?? '—'}</td>
                          <td className="px-5 py-2 text-right text-gray-800">€{Number(p.amount).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-gray-200 font-medium">
                        <td className="px-5 py-2 text-gray-600" colSpan={4}>{isEn ? 'Total' : '合计'}</td>
                        <td className="px-5 py-2 text-right text-gray-800">€{detailData.reconciliation.paymentsFromRecords.toFixed(2)}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  // List view
  return (
    <div className="flex flex-col h-full bg-gray-50">
      <OdooControlPanel
        breadcrumb={isEn ? ['Finance', 'Statements'] : ['财务', '对账单']}
        permanentActions={[
          { label: isEn ? 'Generate Statement' : '生成对账单', onClick: () => setShowCreate(true), primary: true },
          exportAction,
        ]}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={p => setPage(p)}
        searchValue=""
        onSearch={() => {}}
      />

      {/* Status tabs */}
      <div className="bg-white border-b border-gray-200 px-4 flex gap-0">
        {STATUS_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            className="px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap"
            style={{
              borderBottomColor: activeTab === tab.key ? '#875A7B' : 'transparent',
              color: activeTab === tab.key ? '#875A7B' : '#6b7280',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-400">
            <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: '#875A7B' }} />
            {isEn ? 'Loading...' : '加载中...'}
          </div>
        ) : items.length === 0 ? (
          <div className="py-24 text-center text-gray-400 text-sm">{isEn ? 'No statements' : '暂无对账单'}</div>
        ) : (
          <table className="w-full text-sm border-collapse bg-white">
            <thead>
              <tr className="border-b border-gray-200" style={{ background: '#f9f9f9' }}>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">{isEn ? 'Customer' : '客户'}</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">{isEn ? 'Period' : '账期'}</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">{isEn ? 'Opening Balance' : '期初余额'}</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">{isEn ? 'Sales' : '销售额'}</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">{isEn ? 'Payments' : '付款额'}</th>
                <th className="px-4 py-2.5 text-right font-medium text-gray-500 text-xs">{isEn ? 'Closing Balance' : '期末余额'}</th>
                <th className="px-4 py-2.5 text-center font-medium text-gray-500 text-xs">{isEn ? 'Status' : '状态'}</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 text-xs">{isEn ? 'Created' : '创建时间'}</th>
              </tr>
            </thead>
            <tbody>
              {items.map(s => (
                <tr
                  key={s.id}
                  onClick={() => openDetail(s)}
                  className="cursor-pointer border-b border-gray-100 hover:bg-blue-50 transition-colors"
                >
                  <td className="px-4 py-2.5 font-medium" style={{ color: '#875A7B' }}>{s.customerName}</td>
                  <td className="px-4 py-2.5 text-gray-600">
                    {fmtDate(s.periodStart)} ~ {fmtDate(s.periodEnd)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-gray-600">€{s.openingBalance.toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-right text-green-700">€{s.totalSales.toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-right text-blue-700">€{s.totalPayments.toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-gray-900">€{s.closingBalance.toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded-sm text-xs font-medium ${STATUS_COLOR[s.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {STATUS_LABEL[s.status] ?? s.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">
                    {fmtDateTime(s.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </div>

      {/* Create dialog */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-800">{isEn ? 'Generate Statement' : '生成对账单'}</h2>

            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Customer' : '客户'}</label>
              <SearchableDropdown
                options={[{ value: '', label: isEn ? 'Select a customer...' : '请选择客户...' }, ...customers.map(c => ({ value: c.id, label: c.name }))]}
                value={formCustomerId}
                onChange={setFormCustomerId}
                placeholder={isEn ? 'Select a customer...' : '请选择客户...'}
                searchPlaceholder={isEn ? 'Search customer…' : '搜索客户…'}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Start Date' : '开始日期'}</label>
                <DatePicker
                  value={formStart}
                  onChange={setFormStart}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'End Date' : '结束日期'}</label>
                <DatePicker
                  value={formEnd}
                  onChange={setFormEnd}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => { setShowCreate(false); setFormCustomerId(''); setFormStart(''); setFormEnd('') }}
                className="flex-1 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
              >
                {isEn ? 'Cancel' : '取消'}
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !formCustomerId || !formStart || !formEnd}
                className="flex-1 py-2 rounded text-sm font-medium text-white disabled:opacity-50"
                style={{ background: '#875A7B' }}
              >
                {creating ? (isEn ? 'Generating...' : '生成中...') : (isEn ? 'Generate' : '生成')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '-'
  return formatDateOnly(iso)
}

function fmtDateTime(iso: string) {
  if (!iso) return '-'
  return formatDateTime(iso)
}

function downloadStatementCsv(statement: Statement, detail: StatementDetail, isEn: boolean) {
  const rows: Array<Array<string | number>> = [
    [isEn ? 'Customer' : '客户', statement.customerName],
    [isEn ? 'Period' : '账期', `${fmtDate(statement.periodStart)} - ${fmtDate(statement.periodEnd)}`],
    [],
    [isEn ? 'Type' : '类型', isEn ? 'Transaction date' : '交易日期', isEn ? 'Order #' : '订单号', isEn ? 'Invoice #' : '发票号', isEn ? 'Invoice date' : '开票日期', isEn ? 'Credit note #' : '贷记单号', isEn ? 'Description' : '说明', isEn ? 'Tax base' : '未税金额', isEn ? 'Tax' : '税额', isEn ? 'Debit' : '借方', isEn ? 'Credit' : '贷方'],
    [isEn ? 'Opening balance' : '期初余额', '', '', '', '', '', '', '', '', statement.openingBalance.toFixed(2), ''],
    ...detail.orders.map(o => [isEn ? 'Sale' : '销售', fmtDate(o.deliveryDate), o.code ?? '—', o.invoices.map(i => i.name).join(' / ') || (isEn ? 'Pending invoice' : '待开票'), o.invoices.map(i => fmtDate(i.issueDate)).join(' / '), '', '', '', '', Number(o.incTaxTotal).toFixed(2), '']),
    ...detail.payments.map(p => [isEn ? 'Payment' : '收款', fmtDate(p.paidAt), '', p.invoiceName ?? '', '', '', p.note ?? p.method ?? '', '', '', '', Number(p.amount).toFixed(2)]),
    ...detail.credits.map(c => [isEn ? 'Credit note' : '贷记单', fmtDate(c.creditDate), c.sourceOrderIds.map(id => detail.orders.find(o => o.id === id)?.code ?? id.slice(0, 8)).join(' / '), '', '', c.name, c.notes ?? '', c.subtotalExTax.toFixed(2), c.tax.toFixed(2), '', Number(c.amount).toFixed(2)]),
    [],
    [isEn ? 'Closing balance' : '期末余额', '', '', '', '', '', '', '', '', statement.closingBalance.toFixed(2), ''],
  ]
  const csv = '\uFEFF' + rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `statement-${statement.customerName}-${statement.periodStart.slice(0, 10)}-${statement.periodEnd.slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function printStatementPdf(statement: Statement, detail: StatementDetail, isEn: boolean) {
  const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
  const transactions = [
    ...detail.orders.map(o => `<tr><td>${escape(fmtDate(o.deliveryDate))}</td><td>${escape(o.code ?? '—')}</td><td>${escape(o.invoices.map(i => i.name).join(', ') || (isEn ? 'Pending invoice' : '待开票'))}</td><td>${escape(o.invoices.map(i => fmtDate(i.issueDate)).join(', ') || '—')}</td><td>${isEn ? 'Sale' : '销售'}</td><td class="num">€${Number(o.incTaxTotal).toFixed(2)}</td><td></td></tr>`),
    ...detail.payments.map(p => `<tr><td>${escape(fmtDate(p.paidAt))}</td><td></td><td>${escape(p.invoiceName ?? '—')}</td><td></td><td>${isEn ? 'Payment' : '收款'}</td><td></td><td class="num">€${Number(p.amount).toFixed(2)}</td></tr>`),
    ...detail.credits.map(c => `<tr><td>${escape(fmtDate(c.creditDate))}</td><td>${escape(c.sourceOrderIds.map(id => detail.orders.find(o => o.id === id)?.code ?? id.slice(0, 8)).join(', '))}</td><td>${escape(c.name)}</td><td>—</td><td>${escape(c.notes ?? (isEn ? 'Credit note' : '贷记单'))} · ${isEn ? 'ex. tax' : '未税'} €${c.subtotalExTax.toFixed(2)} · ${isEn ? 'tax' : '税额'} €${c.tax.toFixed(2)}</td><td></td><td class="num">−€${c.amount.toFixed(2)}</td></tr>`),
  ].join('')
  const popup = window.open('', '_blank', 'width=1000,height=800')
  if (!popup) { toast.error(isEn ? 'Allow pop-ups to print this statement' : '请允许弹出窗口以打印对账单'); return }
  popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escape(statement.customerName)} ${escape(statement.periodStart.slice(0, 10))}</title><style>body{font:14px Arial,sans-serif;color:#172033;padding:32px}h1{font-size:22px}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{border-bottom:1px solid #ddd;padding:9px 7px;text-align:left}th{background:#f4f1f5}.num{text-align:right}.summary{margin-top:24px;width:380px;margin-left:auto}.summary div{display:flex;justify-content:space-between;padding:7px;border-bottom:1px solid #eee}@media print{body{padding:0}}</style></head><body><h1>${isEn ? 'Customer Statement' : '客户交易对账单'}</h1><div>${isEn ? 'Customer' : '客户'}: ${escape(statement.customerName)}</div><div>${isEn ? 'Period' : '账期'}: ${escape(fmtDate(statement.periodStart))} - ${escape(fmtDate(statement.periodEnd))}</div><table><thead><tr><th>${isEn ? 'Date' : '日期'}</th><th>${isEn ? 'Order #' : '订单号'}</th><th>${isEn ? 'Invoice / credit note' : '发票号 / 贷记单号'}</th><th>${isEn ? 'Invoice date' : '开票日期'}</th><th>${isEn ? 'Description' : '类型 / 说明'}</th><th class="num">${isEn ? 'Debit' : '借方'}</th><th class="num">${isEn ? 'Credit' : '贷方'}</th></tr></thead><tbody>${transactions || `<tr><td colspan="7">${isEn ? 'No transactions' : '无交易'}</td></tr>`}</tbody></table><div class="summary"><div><span>${isEn ? 'Opening balance' : '期初余额'}</span><b>€${statement.openingBalance.toFixed(2)}</b></div><div><span>${isEn ? 'Sales' : '销售'}</span><b>€${statement.totalSales.toFixed(2)}</b></div><div><span>${isEn ? 'Payments' : '收款'}</span><b>−€${statement.totalPayments.toFixed(2)}</b></div><div><span>${isEn ? 'Credit notes' : '贷记单'}</span><b>−€${statement.totalCredits.toFixed(2)}</b></div><div><span>${isEn ? 'Closing balance' : '期末余额'}</span><b>€${statement.closingBalance.toFixed(2)}</b></div></div><script>window.onload=()=>window.print()</script></body></html>`)
  popup.document.close()
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="text-sm font-medium text-gray-800">{value}</div>
    </div>
  )
}

function FinanceRow({ label, amount, positive, negative, bold }: {
  label: string; amount: number; positive?: boolean; negative?: boolean; bold?: boolean
}) {
  return (
    <div className={`flex items-center justify-between px-5 py-3 ${bold ? 'bg-gray-50' : ''}`}>
      <span className={`text-sm ${bold ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>{label}</span>
      <span className={`text-sm ${
        bold ? 'font-bold text-gray-900 text-base'
        : positive ? 'text-green-700'
        : negative ? 'text-blue-700'
        : 'text-gray-700'
      }`}>
        €{amount.toFixed(2)}
      </span>
    </div>
  )
}
