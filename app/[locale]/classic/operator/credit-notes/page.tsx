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

type CnStatus = 'DRAFT' | 'CONFIRMED' | 'SETTLED' | 'CANCELLED'

interface CreditNoteLine {
  id: string
  productName: string
  quantity: number
  unitPrice: number
  taxRate: number
  subtotalIncTax: number
  reason?: string | null
}

interface CreditNote {
  id: string
  name: string
  customerName: string
  creditDate: string
  totalIncTax: number
  status: CnStatus
  notes?: string | null
  lines: CreditNoteLine[]
  createdAt: string
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

export default function CreditNotesPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const STATUS_LABEL = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH

  const [notes, setNotes] = useState<CreditNote[]>([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<CnStatus | ''>('')
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<CreditNote | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    apiGet<CreditNote[]>('/api/credit-notes')
      .then(setNotes)
      .catch(e => toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load credit notes' : '加载信用票失败')))
  }, [isEn])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    let rows = notes
    if (statusFilter) rows = rows.filter(n => n.status === statusFilter)
    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter(n =>
        n.name.toLowerCase().includes(q) || n.customerName.toLowerCase().includes(q))
    }
    return rows
  }, [notes, statusFilter, search])

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
          { label: isEn ? 'Generate from Returns' : '从退货生成', onClick: generateFromReturns, primary: true },
        ]}
        searchValue={search}
        onSearch={v => { setSearch(v); setPage(1) }}
        activeFilters={[
          ...(statusFilter ? [{ label: `${isEn ? 'Status' : '状态'}：${STATUS_LABEL[statusFilter]}`, onRemove: () => setStatusFilter('') }] : []),
        ]}
        filterOptions={[
          { label: isEn ? 'Draft' : '草稿', value: 'DRAFT' },
          { label: isEn ? 'Confirmed' : '已确认', value: 'CONFIRMED' },
          { label: isEn ? 'Settled' : '已结算', value: 'SETTLED' },
          { label: isEn ? 'Cancelled' : '已作废', value: 'CANCELLED' },
        ]}
        onFilterSelect={v => { setStatusFilter(prev => prev === v ? '' : v as CnStatus); setPage(1) }}
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
                <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Status' : '状态'}</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">{isEn ? 'Amount (Inc. Tax)' : '含税金额'}</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Lines' : '行数'}</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Refund Date' : '退款日期'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {pageRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-gray-400">
                    {isEn
                      ? 'No credit notes · approve returns on the Returns page, then click "Generate from Returns"'
                      : '暂无信用票 · 在退换货页批准退货后,点击「从退货生成」'}
                  </td>
                </tr>
              )}
              {pageRows.map(cn => (
                <tr key={cn.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setDetail(cn)}>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{cn.name}</td>
                  <td className="px-4 py-3 text-gray-800">{cn.customerName}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[cn.status]}`}>
                      {STATUS_LABEL[cn.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-900">€{Number(cn.totalIncTax).toFixed(2)}</td>
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
                <div className="flex justify-between text-gray-600">
                  <span>{isEn ? 'Customer' : '客户'}：<b className="text-gray-900">{detail.customerName}</b></span>
                  <span>{isEn ? 'Refund Date' : '退款日期'}：{new Date(detail.creditDate).toLocaleDateString('en-GB')}</span>
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
                      {detail.lines.map(l => (
                        <tr key={l.id}>
                          <td className="px-3 py-2 text-gray-800">{l.productName}</td>
                          <td className="px-3 py-2 text-right">{Number(l.quantity)}</td>
                          <td className="px-3 py-2 text-right">€{Number(l.unitPrice).toFixed(2)}</td>
                          <td className="px-3 py-2 text-right font-medium">€{Number(l.subtotalIncTax).toFixed(2)}</td>
                          <td className="px-3 py-2 text-gray-500">{l.reason ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-gray-50 border-t border-gray-200">
                      <tr>
                        <td colSpan={3} className="px-3 py-2 font-medium text-gray-600">{isEn ? 'Total' : '合计'}</td>
                        <td className="px-3 py-2 text-right font-bold text-gray-900">€{Number(detail.totalIncTax).toFixed(2)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {detail.notes && <p className="text-xs text-gray-500">{isEn ? 'Notes' : '备注'}：{detail.notes}</p>}
              </div>

              <DialogFooter className="gap-2">
                {detail.status === 'DRAFT' && (
                  <>
                    <Button variant="outline" disabled={busy} onClick={() => removeDraft(detail)}>{isEn ? 'Delete' : '删除'}</Button>
                    <Button variant="outline" disabled={busy} onClick={() => changeStatus(detail, 'CANCELLED', '已作废', 'Cancelled')}>{isEn ? 'Cancel' : '作废'}</Button>
                    <Button disabled={busy} onClick={() => changeStatus(detail, 'CONFIRMED', '已确认', 'Confirmed')}>{isEn ? 'Confirm' : '确认'}</Button>
                  </>
                )}
                {detail.status === 'CONFIRMED' && (
                  <>
                    <Button variant="outline" disabled={busy} onClick={() => changeStatus(detail, 'CANCELLED', '已作废', 'Cancelled')}>{isEn ? 'Cancel' : '作废'}</Button>
                    <Button disabled={busy} onClick={() => changeStatus(detail, 'SETTLED', '已结算', 'Settled')}>{isEn ? 'Mark Settled' : '标记已结算'}</Button>
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
