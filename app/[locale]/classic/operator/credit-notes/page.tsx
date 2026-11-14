'use client'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'
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
import CreditNoteAllocations from '@/components/classic/CreditNoteAllocations'

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

  const [notes, setNotes] = useState<CreditNote[]>([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<CnStatus | ''>('')
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<CreditNote | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingDraft, setEditingDraft] = useState(false)
  const [draftLines, setDraftLines] = useState<CreditNoteLine[]>([])
  const [draftNotes, setDraftNotes] = useState('')
  const [draftDate, setDraftDate] = useState('')

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

  async function changeStatus(cn: CreditNote, status: CnStatus, labelZh: string, labelEn: string) {
    const label = isEn ? labelEn : labelZh
    setBusy(true)
    try {
      await apiPut(`/api/credit-notes/${cn.id}`, { status })
      toast.success(`${cn.name} ${label}`)
      setDetail(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? `Failed to ${label.toLowerCase()}` : `${label}失败`))
    } finally {
      setBusy(false)
    }
  }

  async function removeDraft(cn: CreditNote) {
    if (!window.confirm(isEn ? `Confirm delete draft ${cn.name}?` : `确认删除草稿 ${cn.name}?`)) return
    setBusy(true)
    try {
      await apiDelete(`/api/credit-notes/${cn.id}`)
      toast.success(isEn ? 'Deleted' : '已删除')
      setDetail(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to delete' : '删除失败'))
    } finally {
      setBusy(false)
    }
  }

  function openDetail(cn: CreditNote) {
    setDetail(cn)
    setEditingDraft(false)
    setDraftLines(cn.lines.map(line => ({ ...line })))
    setDraftNotes(cn.notes ?? '')
    setDraftDate(cn.creditDate.slice(0, 10))
  }

  async function saveDraftEdits() {
    if (!detail) return
    setBusy(true)
    try {
      await apiPut(`/api/credit-notes/${detail.id}`, {
        creditDate: draftDate,
        notes: draftNotes,
        lines: draftLines.map(({ productId, productName, quantity, unitPrice, taxRate, reason, sourceOrderId, sourceTripId, sourceReturnId, sequence }) => ({
          productId, productName, quantity, unitPrice, taxRate, reason, sourceOrderId, sourceTripId, sourceReturnId, sequence,
        })),
      })
      const updated = await apiGet<CreditNote>(`/api/credit-notes/${detail.id}`)
      setDetail(updated)
      setDraftLines(updated.lines)
      setDraftNotes(updated.notes ?? '')
      setDraftDate(updated.creditDate.slice(0, 10))
      setEditingDraft(false)
      load()
      toast.success(isEn ? 'Draft updated' : '草稿已更新')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to update draft' : '更新草稿失败'))
    } finally {
      setBusy(false)
    }
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
                      ? 'No credit notes · create one from an invoice or approve a return to generate a draft automatically'
                      : '暂无贷记单 · 可从发票手动创建，或在退换货审核通过后自动生成草稿'}
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

      <Dialog open={!!detail} onOpenChange={open => { if (!open) setDetail(null) }}>
        <DialogContent className="max-w-2xl">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3">
                  <span className="font-mono">{detail.name}</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[detail.status]}`}>
                    {STATUS_LABEL[detail.status]}
                  </span>
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2 text-gray-600">
                  <span>{isEn ? 'Customer' : '客户'}：<b className="text-gray-900">{detail.customerName}</b></span>
                  {detail.sourceInvoice && <span>{isEn ? 'Source invoice' : '来源发票'}：<a className="font-mono text-[#714B67] hover:underline" href={`${prefix}/classic/finance/invoices/${detail.sourceInvoice.id}`}>{detail.sourceInvoice.name}</a></span>}
                  {editingDraft ? (
                    <label className="flex items-center gap-2">{isEn ? 'Credit note date' : '贷记单日期'}<input type="date" value={draftDate} onChange={e => setDraftDate(e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-gray-900" /></label>
                  ) : <span>{isEn ? 'Credit Note Date' : '贷记单日期'}：{new Date(detail.creditDate).toLocaleDateString('en-GB')}</span>}
                </div>

                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="text-left px-3 py-2 text-gray-500">{isEn ? 'Product' : '商品'}</th>
                        <th className="text-right px-3 py-2 text-gray-500">{isEn ? 'Qty' : '数量'}</th>
                        <th className="text-right px-3 py-2 text-gray-500">{isEn ? 'Unit Price' : '单价'}</th>
                        <th className="text-right px-3 py-2 text-gray-500">{isEn ? 'Subtotal (Inc. Tax)' : '含税小计'}</th>
                        <th className="text-left px-3 py-2 text-gray-500">{isEn ? 'Reason' : '原因'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {(editingDraft ? draftLines : detail.lines).map((l, index) => (
                        <tr key={l.id}>
                          <td className="px-3 py-2 text-gray-800">{l.productName}</td>
                          <td className="px-3 py-2 text-right">{editingDraft ? <input aria-label={isEn ? 'Quantity' : '数量'} type="number" min="0.001" step="0.001" value={l.quantity} onChange={e => setDraftLines(rows => rows.map((row, i) => i === index ? { ...row, quantity: Number(e.target.value) } : row))} className="w-20 rounded border border-gray-300 px-1 py-1 text-right" /> : Number(l.quantity)}</td>
                          <td className="px-3 py-2 text-right">{editingDraft ? <input aria-label={isEn ? 'Unit price' : '单价'} type="number" min="0" step="0.01" value={l.unitPrice} onChange={e => setDraftLines(rows => rows.map((row, i) => i === index ? { ...row, unitPrice: Number(e.target.value) } : row))} className="w-24 rounded border border-gray-300 px-1 py-1 text-right" /> : `€${Number(l.unitPrice).toFixed(2)}`}</td>
                          <td className="px-3 py-2 text-right font-medium">€{(editingDraft ? Number(l.quantity) * Number(l.unitPrice) * (1 + Number(l.taxRate)) : Number(l.subtotalIncTax)).toFixed(2)}</td>
                          <td className="px-3 py-2 text-gray-500">{[l.reason, l.sourceOrderCode ? `${isEn ? 'Order' : '订单'} ${l.sourceOrderCode}` : null].filter(Boolean).join(' · ') || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-gray-50 border-t border-gray-200">
                      <tr>
                        <td colSpan={3} className="px-3 py-2 font-medium text-gray-600">{isEn ? 'Total' : '合计'}</td>
                        <td className="px-3 py-2 text-right font-bold text-gray-900">€{(editingDraft ? draftLines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.unitPrice) * (1 + Number(line.taxRate)), 0) : Number(detail.totalIncTax)).toFixed(2)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {editingDraft ? (
                  <label className="block text-xs text-gray-500">{isEn ? 'Reason / Notes' : '原因 / 备注'}<textarea value={draftNotes} onChange={e => setDraftNotes(e.target.value)} maxLength={1000} rows={2} className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-800" /></label>
                ) : detail.notes && <p className="text-xs text-gray-500">{isEn ? 'Notes' : '备注'}：{detail.notes}</p>}

                <CreditNoteAllocations
                  key={detail.id}
                  creditNoteId={detail.id}
                  isEn={isEn}
                  onChanged={() => {
                    load()
                    // 抵扣用完会自动变「已结算」，弹窗里的状态徽标跟着刷新
                    apiGet<CreditNote>(`/api/credit-notes/${detail.id}`).then(d => setDetail(cur => cur && cur.id === d.id ? { ...cur, status: d.status } : cur)).catch(() => {})
                  }}
                />
              </div>

              <DialogFooter className="gap-2">
                {detail.status === 'DRAFT' && (
                  <>
                    {editingDraft ? (
                      <>
                        <Button variant="outline" disabled={busy} onClick={() => { setEditingDraft(false); setDraftLines(detail.lines); setDraftNotes(detail.notes ?? ''); setDraftDate(detail.creditDate.slice(0, 10)) }}>{isEn ? 'Discard edits' : '放弃修改'}</Button>
                        <Button variant="outline" disabled={busy} onClick={saveDraftEdits}>{isEn ? 'Save draft' : '保存草稿'}</Button>
                      </>
                    ) : <Button variant="outline" disabled={busy} onClick={() => setEditingDraft(true)}>{isEn ? 'Edit draft' : '编辑草稿'}</Button>}
                    <Button variant="outline" disabled={busy} onClick={() => removeDraft(detail)}>{isEn ? 'Delete' : '删除'}</Button>
                    <Button variant="outline" disabled={busy} onClick={() => changeStatus(detail, 'CANCELLED', '已作废', 'Cancelled')}>{isEn ? 'Cancel' : '作废'}</Button>
                    <Button disabled={busy} onClick={() => changeStatus(detail, 'CONFIRMED', '已确认', 'Confirmed')}>{isEn ? 'Confirm' : '确认'}</Button>
                  </>
                )}
                {detail.status === 'CONFIRMED' && (
                  <>
                    <Button variant="outline" disabled={busy} onClick={() => changeStatus(detail, 'CANCELLED', '已作废', 'Cancelled')}>{isEn ? 'Cancel' : '作废'}</Button>
                  </>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
