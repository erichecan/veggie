'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { toast } from 'sonner'
import { routing } from '@/i18n/routing'
import { apiDelete, apiGet, apiPut } from '@/lib/api'
import { Button } from '@/components/ui/button'
import ProductSearchInput from '@/components/classic/ProductSearchInput'
import CreditNoteAllocations from '@/components/classic/CreditNoteAllocations'

type Status = 'DRAFT' | 'CONFIRMED' | 'SETTLED' | 'CANCELLED'
interface Product { id: string; name: string; internalRef?: string | null; listPrice?: number; price?: number; standardPrice?: number }
interface Line {
  id: string
  productId: string
  productName: string
  quantity: number
  unitPrice: number
  taxRate: number
  reason?: string | null
  sourceOrderId?: string | null
  sourceTripId?: string | null
  sourceReturnId?: string | null
  sequence: number
}
interface Note {
  id: string; name: string; customerId: string; customerName: string; creditDate: string
  currency: string; subtotalExTax: number; totalTax: number; totalIncTax: number
  amountRemaining?: number; status: Status; notes?: string | null; lines: Line[]
  sourceInvoice?: { id: string; name: string } | null
}
const statusLabel: Record<Status, { zh: string; en: string }> = {
  DRAFT: { zh: '草稿', en: 'Draft' }, CONFIRMED: { zh: '已确认', en: 'Confirmed' },
  SETTLED: { zh: '已结算', en: 'Settled' }, CANCELLED: { zh: '已作废', en: 'Cancelled' },
}

export default function CreditNoteDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const router = useRouter()
  const [note, setNote] = useState<Note | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<Line[]>([])
  const [notes, setNotes] = useState('')
  const [creditDate, setCreditDate] = useState('')

  const load = useCallback(async () => {
    try {
      const [cn, ps] = await Promise.all([
        apiGet<Note>(`/api/credit-notes/${id}`),
        apiGet<Product[]>('/api/products?status=ACTIVE&sellable=1&slim=1'),
      ])
      setNote(cn)
      setProducts(ps)
      setLines(cn.lines.map((line, i) => ({ ...line, sequence: line.sequence ?? i })))
      setNotes(cn.notes ?? '')
      setCreditDate(cn.creditDate.slice(0, 10))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load credit note' : '加载贷记单失败'))
    }
  }, [id, isEn])
  useEffect(() => { load() }, [load])

  const total = useMemo(() => lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0) * (1 + Number(line.taxRate || 0)), 0), [lines])
  const canEdit = note?.status === 'DRAFT'

  function addLine() {
    setLines(current => [...current, { id: `new-${Date.now()}-${Math.random()}`, productId: '', productName: '', quantity: 1, unitPrice: 0, taxRate: 0, reason: '', sequence: current.length }])
  }

  async function save() {
    if (!note) return
    setBusy(true)
    try {
      const saved = await apiPut<Note>(`/api/credit-notes/${note.id}`, {
        creditDate, notes,
        lines: lines.map(({ productId, productName, quantity, unitPrice, taxRate, reason, sourceOrderId, sourceTripId, sourceReturnId, sequence }) => ({ productId, productName, quantity, unitPrice, taxRate, reason, sourceOrderId, sourceTripId, sourceReturnId, sequence })),
      })
      setNote(saved)
      setLines(saved.lines.map((line, i) => ({ ...line, sequence: line.sequence ?? i })))
      setEditing(false)
      toast.success(isEn ? 'Draft saved' : '草稿已保存')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to save draft' : '保存草稿失败'))
    } finally { setBusy(false) }
  }

  async function changeStatus(status: 'CONFIRMED' | 'CANCELLED') {
    if (!note) return
    if (status === 'CONFIRMED' && (!lines.length || total <= 0)) {
      toast.error(isEn ? 'Add at least one line with an amount greater than zero before confirming.' : '确认前请至少添加一条金额大于零的商品明细。')
      return
    }
    if (status === 'CANCELLED' && !window.confirm(isEn ? `Cancel ${note.name}?` : `确认作废 ${note.name}？`)) return
    setBusy(true)
    try {
      if (editing) {
        await apiPut(`/api/credit-notes/${note.id}`, {
          creditDate, notes,
          lines: lines.map(({ productId, productName, quantity, unitPrice, taxRate, reason, sourceOrderId, sourceTripId, sourceReturnId, sequence }) => ({ productId, productName, quantity, unitPrice, taxRate, reason, sourceOrderId, sourceTripId, sourceReturnId, sequence })),
        })
      }
      const updated = await apiPut<Note>(`/api/credit-notes/${note.id}`, { status })
      setNote(updated)
      setEditing(false)
      toast.success(status === 'CONFIRMED' ? (isEn ? 'Credit note confirmed' : '贷记单已确认') : (isEn ? 'Credit note cancelled' : '贷记单已作废'))
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Operation failed' : '操作失败'))
    } finally { setBusy(false) }
  }

  async function removeDraft() {
    if (!note || !window.confirm(isEn ? `Delete draft ${note.name}?` : `确认删除草稿 ${note.name}？`)) return
    setBusy(true)
    try {
      await apiDelete(`/api/credit-notes/${note.id}`)
      toast.success(isEn ? 'Draft deleted' : '草稿已删除')
      router.push(`${prefix}/classic/operator/credit-notes`)
    } catch (e) { toast.error(e instanceof Error ? e.message : (isEn ? 'Delete failed' : '删除失败')) }
    finally { setBusy(false) }
  }

  if (!note) return <div className="p-6 text-sm text-gray-500">{isEn ? 'Loading credit note…' : '正在加载贷记单…'}</div>
  const editableNow = editing && canEdit
  const badge = note.status === 'CONFIRMED' ? 'bg-blue-100 text-blue-700' : note.status === 'SETTLED' ? 'bg-green-100 text-green-700' : note.status === 'CANCELLED' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'

  return <div className="min-h-full bg-gray-50 p-4 md:p-6">
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href={`${prefix}/classic/operator/credit-notes`} className="text-sm text-[#714B67] hover:underline">← {isEn ? 'Back to credit notes' : '返回贷记单列表'}</Link>
          <div className="mt-2 flex items-center gap-3"><h1 className="font-mono text-2xl font-semibold">{note.name}</h1><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${badge}`}>{statusLabel[note.status][isEn ? 'en' : 'zh']}</span></div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit && !editing && <Button variant="outline" onClick={() => setEditing(true)}>{isEn ? 'Edit draft' : '编辑草稿'}</Button>}
          {canEdit && editing && <><Button variant="outline" disabled={busy} onClick={() => { setEditing(false); setLines(note.lines); setNotes(note.notes ?? ''); setCreditDate(note.creditDate.slice(0, 10)) }}>{isEn ? 'Discard' : '放弃修改'}</Button><Button disabled={busy} onClick={save}>{isEn ? 'Save draft' : '保存草稿'}</Button></>}
          {canEdit && <><Button variant="outline" disabled={busy} onClick={removeDraft}>{isEn ? 'Delete' : '删除'}</Button><Button disabled={busy || editing} onClick={() => changeStatus('CONFIRMED')}>{isEn ? 'Confirm' : '确认贷记单'}</Button></>}
          {note.status === 'CONFIRMED' && <Button variant="outline" disabled={busy} onClick={() => changeStatus('CANCELLED')}>{isEn ? 'Cancel credit note' : '作废贷记单'}</Button>}
        </div>
      </div>

      <section className="grid gap-4 rounded-xl border bg-white p-5 md:grid-cols-2">
        <div><div className="text-xs uppercase text-gray-500">{isEn ? 'Customer' : '客户'}</div><div className="mt-1 font-semibold">{note.customerName}</div></div>
        <div><div className="text-xs uppercase text-gray-500">{isEn ? 'Credit note date' : '贷记单日期'}</div>{editableNow ? <input type="date" value={creditDate} onChange={e => setCreditDate(e.target.value)} className="mt-1 rounded border px-2 py-1" /> : <div className="mt-1">{new Date(note.creditDate).toLocaleDateString('en-GB')}</div>}</div>
        <div><div className="text-xs uppercase text-gray-500">{isEn ? 'Source invoice reference' : '来源发票参考'}</div>{note.sourceInvoice ? <Link className="mt-1 inline-block font-mono text-[#714B67] hover:underline" href={`${prefix}/classic/finance/invoices/${note.sourceInvoice.id}`}>{note.sourceInvoice.name}</Link> : <div className="mt-1 text-gray-400">—</div>}</div>
        <div><div className="text-xs uppercase text-gray-500">{isEn ? 'Notes' : '备注'}</div>{editableNow ? <textarea value={notes} onChange={e => setNotes(e.target.value)} maxLength={1000} rows={2} className="mt-1 w-full rounded border px-2 py-1" /> : <div className="mt-1 whitespace-pre-wrap">{note.notes || '—'}</div>}</div>
      </section>

      <section className="overflow-hidden rounded-xl border bg-white">
        <div className="flex items-center justify-between border-b bg-[#f3eff5] px-5 py-3"><h2 className="font-semibold">{isEn ? 'Credit note lines' : '贷记单明细'}</h2>{editableNow && <Button variant="outline" size="sm" onClick={addLine}>+ {isEn ? 'Add a product' : '添加商品'}</Button>}</div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] text-sm">
            <thead className="border-b bg-gray-50 text-xs text-gray-500"><tr><th className="px-4 py-3 text-left">{isEn ? 'Product' : '商品'}</th><th className="px-4 py-3 text-right">{isEn ? 'Qty' : '数量'}</th><th className="px-4 py-3 text-right">{isEn ? 'Unit price' : '单价'}</th><th className="px-4 py-3 text-right">{isEn ? 'Tax %' : '税率 %'}</th><th className="px-4 py-3 text-right">{isEn ? 'Total incl. tax' : '含税小计'}</th><th className="px-4 py-3 text-left">{isEn ? 'Reason' : '原因'}</th>{editableNow && <th />}</tr></thead>
            <tbody className="divide-y divide-gray-100">
              {lines.map((line, index) => <tr key={line.id}>
                <td className="min-w-64 px-4 py-3">{editableNow ? <ProductSearchInput<Product> value={line.productName} onChange={value => setLines(rows => rows.map((row, i) => i === index ? { ...row, productName: value, productId: '' } : row))} onSelect={product => setLines(rows => rows.map((row, i) => i === index ? { ...row, productId: product.id, productName: product.name } : row))} products={products} placeholder={isEn ? 'Search products…' : '搜索商品…'} inputClassName="w-full rounded border px-2 py-1.5" portalDropdown /> : line.productName}</td>
                <td className="px-4 py-3 text-right">{editableNow ? <input aria-label="Quantity" type="number" min="0.001" step="0.001" value={line.quantity} onChange={e => setLines(rows => rows.map((row, i) => i === index ? { ...row, quantity: Number(e.target.value) } : row))} className="w-24 rounded border px-2 py-1 text-right" /> : line.quantity}</td>
                <td className="px-4 py-3 text-right">{editableNow ? <input aria-label="Unit price" type="number" min="0" step="0.01" value={line.unitPrice} onChange={e => setLines(rows => rows.map((row, i) => i === index ? { ...row, unitPrice: Number(e.target.value) } : row))} className="w-28 rounded border px-2 py-1 text-right" /> : `€${Number(line.unitPrice).toFixed(2)}`}</td>
                <td className="px-4 py-3 text-right">{editableNow ? <input aria-label="Tax rate" type="number" min="0" step="0.01" value={Number(line.taxRate) * 100} onChange={e => setLines(rows => rows.map((row, i) => i === index ? { ...row, taxRate: Number(e.target.value) / 100 } : row))} className="w-20 rounded border px-2 py-1 text-right" /> : `${(Number(line.taxRate) * 100).toFixed(1)}%`}</td>
                <td className="px-4 py-3 text-right font-medium">€{(Number(line.quantity) * Number(line.unitPrice) * (1 + Number(line.taxRate))).toFixed(2)}</td>
                <td className="px-4 py-3">{editableNow ? <input value={line.reason ?? ''} onChange={e => setLines(rows => rows.map((row, i) => i === index ? { ...row, reason: e.target.value } : row))} className="w-full min-w-40 rounded border px-2 py-1" /> : (line.reason || '—')}</td>
                {editableNow && <td className="px-3 py-3"><button className="text-red-600" onClick={() => setLines(rows => rows.filter((_, i) => i !== index).map((row, i) => ({ ...row, sequence: i })))}>{isEn ? 'Remove' : '删除'}</button></td>}
              </tr>)}
              {lines.length === 0 && <tr><td colSpan={editableNow ? 7 : 6} className="px-4 py-12 text-center text-gray-400">{editableNow ? (isEn ? 'Blank draft. Add products when ready.' : '空白草稿，可按需添加商品明细。') : (isEn ? 'No lines' : '暂无明细')}</td></tr>}
            </tbody>
            <tfoot className="border-t bg-gray-50"><tr><td colSpan={editableNow ? 4 : 4} className="px-4 py-3 font-semibold">{isEn ? 'Total (incl. tax)' : '含税合计'}</td><td className="px-4 py-3 text-right text-base font-bold">€{(editableNow ? total : Number(note.totalIncTax)).toFixed(2)}</td><td colSpan={editableNow ? 2 : 1} /></tr></tfoot>
          </table>
        </div>
      </section>

      {!canEdit && <CreditNoteAllocations key={note.id} creditNoteId={note.id} isEn={isEn} onChanged={load} />}
    </div>
  </div>
}
