'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import { toast } from 'sonner'
import { useAbility, hasPermission } from '@/lib/permissions'
import type { Order } from '@/lib/types'

type RequestLine = { orderLineId: string; productId: string; productName: string; quantity: number; unitPrice: number; taxRate: number; discountAmount: number; subtotalExTax: number; taxAmount: number; subtotalIncTax: number; reason: string }
type RequestRow = { redReturn?: boolean; returnEvidence?: { quantity: number; approvedQuantity: number; warehouseAcceptedQuantity: number; warehouseNote?: string; salesNote?: string; disposition: string; photo?: string; sourceTrip?: { driverName?: string; vehiclePlate?: string } };  id: string; name: string; customerName: string; sourceOrderId: string; sourceReturnId?: string | null; sourceOrderCode?: string; requestDate: string; reason: string; lines: RequestLine[]; totalIncTax: number; status: string; requestedByName?: string | null; reviewNote?: string | null; creditNoteId?: string | null }

export default function CreditNoteRequestsPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const ability = useAbility()
  const canRequest = hasPermission(ability, 'sales.order.update')
  const canReview = hasPermission(ability, 'finance.credit_note.read') && hasPermission(ability, 'finance.credit_note.create')
  const [rows, setRows] = useState<RequestRow[]>([])
  const [query, setQuery] = useState('')
  const [orders, setOrders] = useState<Order[]>([])
  const [order, setOrder] = useState<Order | null>(null)
  const [reason, setReason] = useState('')
  const [selected, setSelected] = useState<Record<string, { quantity: number; discountAmount: number }>>({})
  const complaint = useRef<{ key: string; id: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setRows(await apiGet<RequestRow[]>(canReview ? '/api/credit-note-requests' : '/api/credit-note-requests/mine')) }
    catch (e) { toast.error(e instanceof Error ? e.message : '加载贷记申请失败') }
  }, [canReview])
  useEffect(() => { load() }, [load])

  async function searchOrders() {
    if (!query.trim()) return
    try {
      const result = await apiGet<{ data: Order[] }>(`/api/orders?colCode=${encodeURIComponent(query.trim())}&include_lines=true&pageSize=20`)
      setOrders(result.data ?? [])
    } catch (e) { toast.error(e instanceof Error ? e.message : '搜索订单失败') }
  }

  async function submitRequest() {
    if (!order || !reason.trim()) { toast.error(isEn ? 'Select an order and enter the reason' : '请选择订单并填写申请原因'); return }
    const lines = (order.lines ?? []).filter(line => selected[line.id]?.quantity > 0).map(line => ({ orderLineId: line.id, quantity: selected[line.id].quantity, discountAmount: selected[line.id].discountAmount }))
    if (!lines.length) { toast.error(isEn ? 'Select at least one product' : '至少选择一项商品'); return }
    setBusy(true)
    try {
      await apiPost('/api/credit-note-requests', { orderId: order.id, reason: reason.trim(), lines })
      toast.success(isEn ? 'Credit request submitted to Finance' : '已提交会计审核')
      setOrder(null); setOrders([]); setQuery(''); setReason(''); setSelected({})
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : '提交失败') }
    finally { setBusy(false) }
  }

  async function issueHistoricalComplaint() {
    if (!order || !reason.trim()) { toast.error(isEn ? 'Select the order and enter the complaint' : '请选择原订单并填写客诉原因'); return }
    const ids = Object.keys(selected).filter(id => selected[id]?.quantity > 0)
    if (ids.length !== 1) { toast.error(isEn ? 'Select one invoice line' : '请选择一条原发票对应商品'); return }
    const input = window.prompt(isEn ? 'Credit amount before tax (€)' : '贷记金额（未税，€）')
    if (input === null) return
    const amount = Number(input)
    if (!/^\d+(?:\.\d{1,2})?$/.test(input.trim()) || !(amount > 0)) { toast.error(isEn ? 'Enter a valid positive amount' : '请输入有效贷记金额'); return }
    const key = JSON.stringify([order.id, ids[0], reason.trim(), amount])
    if (complaint.current?.key !== key) complaint.current = { key, id: crypto.randomUUID() }
    setBusy(true)
    try {
      const note = await apiPost<{ name: string }>('/api/credit-notes', {
        action: 'historical_complaint', orderId: order.id, orderLineId: ids[0],
        reason: reason.trim(), creditAmountExTax: amount, complaintId: complaint.current.id,
      })
      complaint.current = null
      toast.success(`${isEn ? 'Credit note issued' : '贷记单已开具'} ${note.name}`)
      setOrder(null); setOrders([]); setQuery(''); setReason(''); setSelected({})
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '开具贷记单失败')
    } finally {
      setBusy(false)
    }
  }

  async function decide(row: RequestRow, action: 'approve' | 'reject') {
    const amountInput = row.redReturn ? window.prompt(isEn ? 'Credit amount before tax (€)' : '贷记金额（未税，€）') : null
    if (row.redReturn && amountInput === null) return
    const creditAmountExTax = row.redReturn ? Number(amountInput) : undefined
    if (row.redReturn && (!/^\d+(?:\.\d{1,2})?$/.test(amountInput?.trim() ?? '') || !(Number(creditAmountExTax) > 0))) {
      toast.error(isEn ? 'Enter a positive amount with up to two decimal places' : '请输入大于零的金额，最多两位小数')
      return
    }
    const reviewNote = row.redReturn ? '' : window.prompt(isEn ? 'Review note (optional)' : '审核备注（可选）') ?? ''
    if (action === 'reject' && !reviewNote.trim()) { toast.error(isEn ? 'A reason is required to reject' : '拒绝时请填写原因'); return }
    setBusy(true)
    try {
      const result = await apiPut<{ creditNote?: { id: string; name: string } }>(`/api/credit-note-requests/${row.id}`, { action, reviewNote, creditAmountExTax })
      toast.success(action === 'approve' ? `${isEn ? 'Request confirmed' : '申请已确认'} ${result.creditNote?.name ?? ''}` : (isEn ? 'Request rejected' : '已拒绝申请'))
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : '处理失败') }
    finally { setBusy(false) }
  }

  const statusLabel = (status: string) => ({ PENDING: isEn ? 'Pending review' : '待会计审核', APPROVED: isEn ? 'Approved' : '已批准', REJECTED: isEn ? 'Rejected' : '已拒绝' }[status] ?? status)
  const statusColor = (status: string) => status === 'PENDING' ? 'bg-amber-100 text-amber-800' : status === 'APPROVED' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'

  return <main className="min-h-screen bg-gray-50 p-4 md:p-6">
    <div className="mx-auto max-w-7xl space-y-5">
      <header><h1 className="text-xl font-semibold text-gray-900">{isEn ? 'Credit Note Requests' : 'Credit Note 申请'}</h1><p className="mt-1 text-sm text-gray-500">{isEn ? 'Returned goods: Finance sets the credit amount for invoiced returns. Sales posts scrap after warehouse verification.' : '实物退货：已过账退货由会计定额开具贷记单。仓库核实后，销售处理报废。'}</p></header>

      {(canRequest || canReview) && <section className="rounded-lg border bg-white p-4 space-y-4">
        <h2 className="font-medium">{isEn ? 'Order adjustments' : '销售申请与历史单客诉贷记'}</h2>
        {!order ? <>
          <div className="flex gap-2"><input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') searchOrders() }} placeholder={isEn ? 'Search order number' : '搜索销售订单号'} className="min-w-0 flex-1 rounded border px-3 py-2 text-sm" /><button onClick={searchOrders} className="rounded bg-[#875A7B] px-4 py-2 text-sm text-white">{isEn ? 'Search' : '搜索'}</button></div>
          {orders.map(o => <button key={o.id} onClick={() => { setOrder(o); setSelected({}) }} className="block w-full rounded border px-3 py-2 text-left text-sm hover:bg-purple-50"><b>{o.code}</b><span className="ml-3 text-gray-600">{o.restaurantName}</span><span className="ml-3 text-gray-400">{o.deliveryDate}</span></button>)}
        </> : <>
          <div className="flex items-center justify-between rounded bg-gray-50 p-3 text-sm"><div><b>{order.code}</b><span className="ml-3">{order.restaurantName}</span></div><button onClick={() => setOrder(null)} className="text-[#714B67]">{isEn ? 'Change order' : '更换订单'}</button></div>
          <label className="block text-sm">{isEn ? 'Reason (price / quality)' : '申请原因（价格／质量等）'}<textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} className="mt-1 w-full rounded border px-3 py-2" /></label>
          <div className="overflow-x-auto rounded border"><table className="w-full min-w-[680px] text-sm"><thead className="bg-gray-50"><tr><th className="p-2 text-left">{isEn ? 'Select / Product' : '选择／商品'}</th><th className="p-2 text-right">{isEn ? 'Order qty' : '订单数量'}</th><th className="p-2 text-right">{isEn ? 'Request qty' : '申请数量'}</th><th className="p-2 text-right">{isEn ? 'Unit price' : '单价'}</th><th className="p-2 text-right">{isEn ? 'Discount €' : '折扣金额 €'}</th></tr></thead><tbody className="divide-y">{(order.lines ?? []).map(line => { const value = selected[line.id]; return <tr key={line.id}><td className="p-2"><label className="flex items-center gap-2"><input type="checkbox" checked={!!value} onChange={e => setSelected(s => ({ ...s, [line.id]: e.target.checked ? { quantity: Number(line.orderedQty), discountAmount: 0 } : undefined as never }))} />{line.productName}</label></td><td className="p-2 text-right">{line.orderedQty}</td><td className="p-2 text-right"><input disabled={!value} type="number" min="0.001" max={Number(line.orderedQty)} step="0.001" value={value?.quantity ?? ''} onChange={e => setSelected(s => ({ ...s, [line.id]: { ...value!, quantity: Number(e.target.value) } }))} className="w-24 rounded border px-2 py-1 text-right" /></td><td className="p-2 text-right">€{Number(line.unitPrice).toFixed(2)}</td><td className="p-2 text-right"><input disabled={!value} type="number" min="0" step="0.01" value={value?.discountAmount ?? ''} onChange={e => setSelected(s => ({ ...s, [line.id]: { ...value!, discountAmount: Number(e.target.value) } }))} className="w-24 rounded border px-2 py-1 text-right" /></td></tr> })}</tbody></table></div>
          <div className="flex flex-wrap justify-end gap-2">{canReview && <button disabled={busy} onClick={issueHistoricalComplaint} className="rounded border px-4 py-2 text-sm">{isEn ? 'Issue historical complaint credit' : '开具历史单客诉贷记'}</button>}{canRequest && <button disabled={busy} onClick={submitRequest} className="rounded bg-[#875A7B] px-4 py-2 text-sm text-white disabled:opacity-50">{isEn ? 'Submit for Finance review' : '提交会计审核'}</button>}</div>
        </>}
      </section>}

      <section className="rounded-lg border bg-white overflow-hidden"><div className="border-b bg-[#f3eff5] px-4 py-3 font-medium">{canReview ? (isEn ? 'Review queue' : '会计审核队列') : (isEn ? 'My submitted requests' : '我的申请')}</div><div className="overflow-x-auto"><table className="w-full min-w-[850px] text-sm"><thead className="bg-gray-50 text-gray-600"><tr><th className="p-3 text-left">{isEn ? 'Request' : '申请单号'}</th><th className="p-3 text-left">{isEn ? 'Customer / Order' : '客户／订单'}</th><th className="p-3 text-left">{isEn ? 'Reason' : '原因'}</th><th className="p-3 text-right">{isEn ? 'Amount' : '申请金额'}</th><th className="p-3 text-center">{isEn ? 'Status' : '状态'}</th><th className="p-3 text-left">{isEn ? 'Submitted by' : '申请人'}</th><th className="p-3 text-right">{isEn ? 'Action' : '处理'}</th></tr></thead><tbody className="divide-y">{rows.map(row => <tr key={row.id}><td className="p-3 font-mono">{row.name}<div className="text-xs text-gray-400">{new Date(row.requestDate).toLocaleDateString('en-GB')}</div></td><td className="p-3">{row.customerName}<div className="text-xs text-gray-400">{row.sourceOrderCode ?? row.sourceOrderId}</div></td><td className="p-3">{row.reason}{row.returnEvidence && <div className="mt-1 space-y-1 text-xs text-gray-600"><div>{isEn ? 'Received / credit qty: ' : '仓库实收 / 批准退货：'}{row.returnEvidence.warehouseAcceptedQuantity} / {row.returnEvidence.approvedQuantity} · {row.returnEvidence.disposition}</div><div>{row.returnEvidence.warehouseNote}</div><div>{row.returnEvidence.salesNote}</div><div>{row.returnEvidence.sourceTrip?.driverName} {row.returnEvidence.sourceTrip?.vehiclePlate}</div>{row.returnEvidence.photo && <a href={row.returnEvidence.photo} target="_blank" rel="noreferrer" className="underline">{isEn ? 'Return photo' : '退货照片'}</a>}</div>}<details className="mt-1 text-xs text-gray-500"><summary className="cursor-pointer">{isEn ? `${row.lines?.length ?? 0} item(s) — view details` : `${row.lines?.length ?? 0} 项商品 — 查看明细`}</summary><div className="mt-1 space-y-1">{row.lines?.map((line, index) => <div key={`${row.id}-${index}`} className="flex justify-between gap-3"><span>{line.productName} × {line.quantity}{line.discountAmount > 0 ? ` · ${isEn ? 'discount' : '折扣'} €${Number(line.discountAmount).toFixed(2)}` : ''}</span><span>€{Number(line.subtotalIncTax).toFixed(2)}</span></div>)}</div></details></td><td className="p-3 text-right font-medium">{row.redReturn && row.status === 'PENDING' ? (isEn ? 'Set by Finance' : '会计定额') : `€${Number(row.totalIncTax).toFixed(2)}`}</td><td className="p-3 text-center"><span className={`rounded-full px-2 py-1 text-xs ${statusColor(row.status)}`}>{statusLabel(row.status)}</span>{row.reviewNote && <div className="mt-1 text-xs text-gray-500">{row.reviewNote}</div>}</td><td className="p-3">{row.requestedByName ?? '—'}</td><td className="p-3 text-right">{canReview && row.status === 'PENDING' ? <span className="inline-flex gap-2">{!row.redReturn && <button disabled={busy} onClick={() => decide(row, 'reject')} className="rounded border px-2 py-1 text-red-700">{isEn ? 'Reject' : '拒绝'}</button>}<button disabled={busy} onClick={() => decide(row, 'approve')} className="rounded bg-[#875A7B] px-2 py-1 text-white">{row.redReturn ? (isEn ? 'Issue credit note' : '开具贷记单') : row.sourceReturnId ? (isEn ? 'Confirm return' : '确认退货') : (isEn ? 'Approve & create draft' : '批准并生成草稿')}</button></span> : row.creditNoteId ? <a className="text-[#714B67] underline" href={`${locale === routing.defaultLocale ? '' : `/${locale}`}/classic/operator/credit-notes/${row.creditNoteId}`}>{isEn ? 'Open credit note' : '查看贷记单'}</a> : '—'}</td></tr>)}</tbody></table>{!rows.length && <p className="p-10 text-center text-sm text-gray-400">{isEn ? 'No requests yet' : '暂无申请'}</p>}</div></section>
    </div>
  </main>
}
