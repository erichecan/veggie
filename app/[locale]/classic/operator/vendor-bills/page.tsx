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

  const [importOpen, setImportOpen] = useState(false)
  const [importSupplierId, setImportSupplierId] = useState('')
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{
    ok: boolean
    fileName: string
    stats: { total: number; exactMatch: number; fuzzyMatch: number; noMatch: number }
    lines: Array<{
      rawProductName: string; quantity: number; unitCost: number
      matchedProductId: string | null; matchedProductName: string | null
      confidence: 'exact' | 'fuzzy' | 'none'
    }>
    createdBill: { id: string; name: string } | null
  } | null>(null)

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

  function downloadCsvTemplate() {
    const content = '商品名称,数量,单价\n示例商品A,10,5.50\n示例商品B,20,3.20\n'
    const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '供应商账单导入模板.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleImport() {
    if (!importSupplierId) { toast.error('请选择供应商'); return }
    if (!importFile) { toast.error('请选择文件'); return }
    setImporting(true)
    try {
      const fd = new FormData()
      fd.append('file', importFile)
      fd.append('supplierId', importSupplierId)
      const token = localStorage.getItem('veggie_token')
      const res = await fetch('/api/vendor-bills/import', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setImportResult(data)
      if (data.createdBill) {
        toast.success(`已创建账单草稿 ${data.createdBill.name}`)
        load()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const newTotal = newLines.reduce((s, l) =>
    s + l.qty * l.unitCost * (1 + (l.taxRate || 0)), 0)

  return (
    <div>
      <OdooControlPanel
        breadcrumb={['采购', '供应商账单']}
        permanentActions={[
          { label: '新建账单', onClick: () => setCreateOpen(true), primary: true },
          { label: 'Import', onClick: () => { setImportOpen(true); setImportResult(null); setImportFile(null); setImportSupplierId('') } },
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

      {/* 导入供应商账单 */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>导入供应商账单</DialogTitle>
          </DialogHeader>

          {!importResult ? (
            <div className="space-y-4 text-sm">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">供应商</label>
                <select
                  value={importSupplierId}
                  onChange={e => setImportSupplierId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                >
                  <option value="">请选择供应商...</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-gray-500">文件（PDF / Excel / CSV，最大 10MB）</label>
                  <button
                    type="button"
                    onClick={downloadCsvTemplate}
                    className="text-xs font-medium hover:underline"
                    style={{ color: '#875A7B' }}
                  >
                    ↓ 下载 CSV 模板
                  </button>
                </div>
                <input
                  type="file"
                  accept=".pdf,.xlsx,.xls,.csv"
                  onChange={e => setImportFile(e.target.files?.[0] ?? null)}
                  className="w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-4 file:rounded file:border-0 file:text-sm file:font-medium file:bg-purple-50 file:text-purple-700 hover:file:bg-purple-100"
                />
                {importFile && (
                  <p className="mt-1 text-xs text-gray-400">{importFile.name} ({(importFile.size / 1024).toFixed(1)} KB)</p>
                )}
                <p className="mt-1 text-xs text-gray-400">表头列：商品名称、数量、单价（顺序不限，无表头时按前三列识别）</p>
              </div>
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-4 gap-3 text-center">
                <div className="bg-gray-50 rounded p-2">
                  <div className="text-lg font-semibold text-gray-800">{importResult.stats.total}</div>
                  <div className="text-xs text-gray-500">总行数</div>
                </div>
                <div className="bg-green-50 rounded p-2">
                  <div className="text-lg font-semibold text-green-700">{importResult.stats.exactMatch}</div>
                  <div className="text-xs text-green-600">精确匹配</div>
                </div>
                <div className="bg-yellow-50 rounded p-2">
                  <div className="text-lg font-semibold text-yellow-700">{importResult.stats.fuzzyMatch}</div>
                  <div className="text-xs text-yellow-600">模糊匹配</div>
                </div>
                <div className="bg-red-50 rounded p-2">
                  <div className="text-lg font-semibold text-red-600">{importResult.stats.noMatch}</div>
                  <div className="text-xs text-red-500">未匹配</div>
                </div>
              </div>

              {importResult.createdBill && (
                <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded px-3 py-2 text-sm">
                  <span className="text-green-700">已创建账单草稿：</span>
                  <span className="font-medium" style={{ color: '#875A7B' }}>{importResult.createdBill.name}</span>
                </div>
              )}

              <div className="max-h-[40vh] overflow-auto border border-gray-200 rounded">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="px-3 py-2 text-left font-medium text-gray-500">原始商品名</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-500">数量</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-500">单价</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-500">匹配结果</th>
                      <th className="px-3 py-2 text-center font-medium text-gray-500">置信度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importResult.lines.map((line, i) => (
                      <tr key={i} className="border-b border-gray-100">
                        <td className="px-3 py-1.5 text-gray-700">{line.rawProductName}</td>
                        <td className="px-3 py-1.5 text-right text-gray-700">{line.quantity}</td>
                        <td className="px-3 py-1.5 text-right text-gray-700">{line.unitCost.toFixed(2)}</td>
                        <td className="px-3 py-1.5 text-gray-600">{line.matchedProductName ?? '-'}</td>
                        <td className="px-3 py-1.5 text-center">
                          <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                            line.confidence === 'exact' ? 'bg-green-100 text-green-700' :
                            line.confidence === 'fuzzy' ? 'bg-yellow-100 text-yellow-700' :
                            'bg-red-100 text-red-600'
                          }`}>
                            {line.confidence === 'exact' ? '精确' : line.confidence === 'fuzzy' ? '模糊' : '未匹配'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <DialogFooter>
            {!importResult ? (
              <>
                <Button variant="outline" onClick={() => setImportOpen(false)}>取消</Button>
                <Button disabled={importing || !importSupplierId || !importFile} onClick={handleImport}>
                  {importing ? '导入中...' : '上传并解析'}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setImportOpen(false)}>关闭</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
