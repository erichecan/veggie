'use client'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import OdooControlPanel from '@/components/classic/OdooControlPanel'

type VbStatus = 'DRAFT' | 'POSTED' | 'PAID' | 'CANCELLED'

interface VendorBillLine {
  productId?: string
  productName: string
  qty: number
  unitCost: number
  taxRate: number
  subtotalIncTax?: number
}

interface VendorBill {
  id: string
  name: string
  supplierId: string
  billDate: string
  dueDate?: string | null
  lines: VendorBillLine[]
  subtotalExTax: number
  totalTax: number
  totalIncTax: number
  amountPaid: number
  amountDue: number
  status: VbStatus
  notes?: string | null
}

interface Supplier { id: string; name: string }

const STATUS_LABEL: Record<VbStatus, string> = {
  DRAFT: '草稿',
  POSTED: '已入账',
  PAID: '已付款',
  CANCELLED: '已作废',
}

const STATUS_COLOR: Record<VbStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  POSTED: 'bg-blue-100 text-blue-700',
  PAID: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-red-100 text-red-600',
}

const EMPTY_LINE: VendorBillLine = { productName: '', qty: 1, unitCost: 0, taxRate: 0 }
const PAGE_SIZE = 20

export default function VendorBillsPage() {
  const [bills, setBills] = useState<VendorBill[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<VbStatus | ''>('')
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<VendorBill | null>(null)
  const [busy, setBusy] = useState(false)
  const [payAmount, setPayAmount] = useState('')

  const [createOpen, setCreateOpen] = useState(false)
  const [newSupplierId, setNewSupplierId] = useState('')
  const [newDueDate, setNewDueDate] = useState('')
  const [newNotes, setNewNotes] = useState('')
  const [newLines, setNewLines] = useState<VendorBillLine[]>([{ ...EMPTY_LINE }])

  const supplierName = useCallback(
    (id: string) => suppliers.find(s => s.id === id)?.name ?? id.slice(-8),
    [suppliers],
  )

  const load = useCallback(() => {
    apiGet<VendorBill[]>('/api/vendor-bills')
      .then(setBills)
      .catch(e => toast.error(e instanceof Error ? e.message : '加载账单失败'))
  }, [])

  useEffect(() => {
    load()
    apiGet<Supplier[]>('/api/customers?isVendor=true&limit=200')
      .then(setSuppliers)
      .catch(() => {})
  }, [load])

  const filtered = useMemo(() => {
    let rows = bills
    if (statusFilter) rows = rows.filter(b => b.status === statusFilter)
    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter(b =>
        b.name.toLowerCase().includes(q) || supplierName(b.supplierId).toLowerCase().includes(q))
    }
    return rows
  }, [bills, statusFilter, search, supplierName])

  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  async function changeStatus(bill: VendorBill, status: VbStatus, label: string) {
    setBusy(true)
    try {
      await apiPut(`/api/vendor-bills/${bill.id}`, { status })
      toast.success(`${bill.name} ${label}`)
      setDetail(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${label}失败`)
    } finally {
      setBusy(false)
    }
  }

  async function registerPayment(bill: VendorBill) {
    const add = Number(payAmount)
    if (!Number.isFinite(add) || add <= 0) {
      toast.error('请输入有效的付款金额')
      return
    }
    setBusy(true)
    try {
      const paid = Math.min(Number(bill.amountPaid) + add, Number(bill.totalIncTax))
      await apiPut(`/api/vendor-bills/${bill.id}`, { amountPaid: paid })
      toast.success(`已登记付款 €${add.toFixed(2)}`)
      setPayAmount('')
      setDetail(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '登记付款失败')
    } finally {
      setBusy(false)
    }
  }

  async function createBill() {
    if (!newSupplierId) { toast.error('请选择供应商'); return }
    const lines = newLines.filter(l => l.productName.trim() && l.qty > 0)
    if (lines.length === 0) { toast.error('至少填写一行有效明细'); return }
    setBusy(true)
    try {
      await apiPost('/api/vendor-bills', {
        supplierId: newSupplierId,
        dueDate: newDueDate || undefined,
        notes: newNotes || undefined,
        lines,
      })
      toast.success('账单已创建(草稿)')
      setCreateOpen(false)
      setNewSupplierId(''); setNewDueDate(''); setNewNotes(''); setNewLines([{ ...EMPTY_LINE }])
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  function setLine(i: number, patch: Partial<VendorBillLine>) {
    setNewLines(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l))
  }

  const newTotal = newLines.reduce((s, l) =>
    s + l.qty * l.unitCost * (1 + (l.taxRate || 0)), 0)

  return (
    <div>
      <OdooControlPanel
        breadcrumb={['采购', '供应商账单']}
        permanentActions={[
          { label: '新建账单', onClick: () => setCreateOpen(true), primary: true },
        ]}
        searchValue={search}
        onSearch={v => { setSearch(v); setPage(1) }}
        activeFilters={[
          ...(statusFilter ? [{ label: `状态：${STATUS_LABEL[statusFilter]}`, onRemove: () => setStatusFilter('') }] : []),
        ]}
        filterOptions={[
          { label: '草稿', value: 'DRAFT' },
          { label: '已入账', value: 'POSTED' },
          { label: '已付款', value: 'PAID' },
          { label: '已作废', value: 'CANCELLED' },
        ]}
        onFilterSelect={v => { setStatusFilter(prev => prev === v ? '' : v as VbStatus); setPage(1) }}
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
                <th className="text-left px-4 py-3 font-medium text-gray-600">单号</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">供应商</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">状态</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">含税总额</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">未付</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">账单日期</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">到期</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {pageRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-12 text-gray-400">
                    暂无供应商账单,点击「新建账单」登记应付
                  </td>
                </tr>
              )}
              {pageRows.map(b => (
                <tr key={b.id} className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => { setDetail(b); setPayAmount('') }}>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{b.name}</td>
                  <td className="px-4 py-3 text-gray-800">{supplierName(b.supplierId)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[b.status]}`}>
                      {STATUS_LABEL[b.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-900">€{Number(b.totalIncTax).toFixed(2)}</td>
                  <td className="px-4 py-3 text-right">
                    {Number(b.amountDue) > 0 && b.status !== 'CANCELLED'
                      ? <span className="font-medium text-red-600">€{Number(b.amountDue).toFixed(2)}</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-center text-xs text-gray-500">{new Date(b.billDate).toLocaleDateString('en-GB')}</td>
                  <td className="px-4 py-3 text-center text-xs text-gray-500">
                    {b.dueDate ? new Date(b.dueDate).toLocaleDateString('en-GB') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 详情 / 操作 */}
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
                  <span>供应商：<b className="text-gray-900">{supplierName(detail.supplierId)}</b></span>
                  <span>已付 €{Number(detail.amountPaid).toFixed(2)} / 未付 <b className="text-red-600">€{Number(detail.amountDue).toFixed(2)}</b></span>
                </div>

                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="text-left px-3 py-2 text-gray-500">商品</th>
                        <th className="text-right px-3 py-2 text-gray-500">数量</th>
                        <th className="text-right px-3 py-2 text-gray-500">单价</th>
                        <th className="text-right px-3 py-2 text-gray-500">税率</th>
                        <th className="text-right px-3 py-2 text-gray-500">含税小计</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {detail.lines.map((l, i) => (
                        <tr key={i}>
                          <td className="px-3 py-2 text-gray-800">{l.productName}</td>
                          <td className="px-3 py-2 text-right">{Number(l.qty)}</td>
                          <td className="px-3 py-2 text-right">€{Number(l.unitCost).toFixed(2)}</td>
                          <td className="px-3 py-2 text-right">{(Number(l.taxRate) * 100).toFixed(1)}%</td>
                          <td className="px-3 py-2 text-right font-medium">
                            €{Number(l.subtotalIncTax ?? l.qty * l.unitCost * (1 + l.taxRate)).toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-gray-50 border-t border-gray-200">
                      <tr>
                        <td colSpan={4} className="px-3 py-2 font-medium text-gray-600">含税合计</td>
                        <td className="px-3 py-2 text-right font-bold text-gray-900">€{Number(detail.totalIncTax).toFixed(2)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {detail.notes && <p className="text-xs text-gray-500">备注：{detail.notes}</p>}

                {detail.status === 'POSTED' && (
                  <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <span className="text-xs text-amber-700 whitespace-nowrap">登记付款 €</span>
                    <input
                      type="number" min="0.01" step="0.01"
                      value={payAmount}
                      onChange={e => setPayAmount(e.target.value)}
                      placeholder={Number(detail.amountDue).toFixed(2)}
                      className="w-32 border border-amber-300 rounded px-2 py-1 text-sm"
                    />
                    <Button size="sm" disabled={busy} onClick={() => registerPayment(detail)}>登记</Button>
                    <span className="text-[11px] text-amber-600 ml-auto">付清后自动转「已付款」</span>
                  </div>
                )}
              </div>

              <DialogFooter className="gap-2">
                {detail.status === 'DRAFT' && (
                  <>
                    <Button variant="outline" disabled={busy} onClick={() => changeStatus(detail, 'CANCELLED', '已作废')}>作废</Button>
                    <Button disabled={busy} onClick={() => changeStatus(detail, 'POSTED', '已入账')}>确认入账</Button>
                  </>
                )}
                {detail.status === 'POSTED' && (
                  <>
                    <Button variant="outline" disabled={busy} onClick={() => changeStatus(detail, 'CANCELLED', '已作废')}>作废</Button>
                    <Button disabled={busy} onClick={() => changeStatus(detail, 'PAID', '已全额付款')}>全额付清</Button>
                  </>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 新建账单 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>新建供应商账单</DialogTitle>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-gray-500">供应商 *</span>
                <select
                  value={newSupplierId}
                  onChange={e => setNewSupplierId(e.target.value)}
                  className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5"
                >
                  <option value="">请选择…</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-gray-500">到期日</span>
                <input
                  type="date" value={newDueDate}
                  onChange={e => setNewDueDate(e.target.value)}
                  className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5"
                />
              </label>
            </div>

            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-2 py-2 text-gray-500">商品名称 *</th>
                    <th className="text-right px-2 py-2 text-gray-500 w-20">数量</th>
                    <th className="text-right px-2 py-2 text-gray-500 w-24">单价 €</th>
                    <th className="text-right px-2 py-2 text-gray-500 w-20">税率 %</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {newLines.map((l, i) => (
                    <tr key={i}>
                      <td className="px-2 py-1.5">
                        <input value={l.productName} onChange={e => setLine(i, { productName: e.target.value })}
                          placeholder="如:大白菜 10kg 箱"
                          className="w-full border border-gray-200 rounded px-2 py-1" />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" min="0" step="1" value={l.qty}
                          onChange={e => setLine(i, { qty: Number(e.target.value) })}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-right" />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" min="0" step="0.01" value={l.unitCost}
                          onChange={e => setLine(i, { unitCost: Number(e.target.value) })}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-right" />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" min="0" step="0.5" value={l.taxRate * 100}
                          onChange={e => setLine(i, { taxRate: Number(e.target.value) / 100 })}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-right" />
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {newLines.length > 1 && (
                          <button onClick={() => setNewLines(prev => prev.filter((_, idx) => idx !== i))}
                            className="text-gray-400 hover:text-red-500">✕</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-t border-gray-200">
                <button onClick={() => setNewLines(prev => [...prev, { ...EMPTY_LINE }])}
                  className="text-xs text-purple-700 hover:underline">＋ 加一行</button>
                <span className="text-xs text-gray-600">含税合计:<b className="text-gray-900">€{newTotal.toFixed(2)}</b></span>
              </div>
            </div>

            <label className="block">
              <span className="text-xs text-gray-500">备注</span>
              <input value={newNotes} onChange={e => setNewNotes(e.target.value)}
                className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5" />
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button disabled={busy} onClick={createBill}>创建草稿</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
