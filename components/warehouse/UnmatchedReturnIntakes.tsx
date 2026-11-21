'use client'

import { useEffect, useState } from 'react'
import { apiGet, apiPut } from '@/lib/api'
import type { Customer, Order } from '@/lib/types'
import { toast } from 'sonner'
import { useRefetchOnFocus } from '@/lib/hooks/use-refetch-on-focus'

type Intake = {
  id: string
  sourceType: 'DRIVER' | 'WAREHOUSE'
  status: string
  reviewNote?: string | null
  customerId?: string | null
  customerName: string
  vehiclePlate?: string | null
  driverName?: string | null
  productName: string
  spec: string
  uomLabel: string
  quantity: number
  reason?: string | null
  photo?: string | null
  createdAt: string
  sourceTrip?: { driverName?: string | null; vehiclePlate?: string | null } | null
}

export default function UnmatchedReturnIntakes({ isEn, canReview, onSaved }: { isEn: boolean; canReview: boolean; onSaved: () => void }) {
  const [rows, setRows] = useState<Intake[]>([])
  const [selected, setSelected] = useState<Intake | null>(null)
  const [customerQuery, setCustomerQuery] = useState('')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [code, setCode] = useState('')
  const [note, setNote] = useState('')
  const [quantity, setQuantity] = useState('')
  const [order, setOrder] = useState<Order | null>(null)
  const [lineId, setLineId] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    try { setRows(await apiGet<Intake[]>('/api/order-returns?intakes=1')) }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Failed') }
  }
  useEffect(() => { void load() }, [])
  useRefetchOnFocus([load])

  async function searchCustomer() {
    if (!customerQuery.trim()) { setCustomers([]); return }
    setBusy(true)
    try {
      const data = await apiGet<{ data: Customer[] }>(`/api/customers?search=${encodeURIComponent(customerQuery.trim())}&slim=1&pageSize=20`)
      setCustomers(data.data)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Customer search failed') }
    finally { setBusy(false) }
  }

  async function searchOrder() {
    if (!selected || !customer || !code.trim()) return
    setBusy(true)
    try {
      const data = await apiGet<{ data: Order[] }>(`/api/orders?colCode=${encodeURIComponent(code.trim())}&include_lines=true&pageSize=20`)
      const found = data.data.find(row => row.restaurantId === customer.id && row.code?.toLowerCase() === code.trim().toLowerCase())
      if (!found) throw new Error(isEn ? 'No order found for this restaurant' : '没有找到该餐馆的订单，请检查订单号')
      setOrder(found)
      setLineId('')
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Order search failed') }
    finally { setBusy(false) }
  }

  async function act(action: 'identifyCustomer' | 'link' | 'reject') {
    if (!selected || !note.trim()) { toast.error(isEn ? 'Enter a Sales matching note' : '请填写销售匹配说明') ; return }
    if (action !== 'reject' && !customer) { toast.error(isEn ? 'Select the restaurant first' : '请先选择餐馆'); return }
    if (action === 'link' && (!order || !lineId || !(Number(quantity) > 0))) { toast.error(isEn ? 'Select the original order line and quantity' : '请选择原订单商品行并填写数量'); return }
    setBusy(true)
    try {
      await apiPut(`/api/order-returns/intakes/${selected.id}`, {
        action, note, customerId: customer?.id,
        orderId: order?.id, orderLineId: lineId, quantity: Number(quantity),
      })
      toast.success(action === 'link'
        ? (isEn ? 'Order matched; return is now in warehouse check' : '原订单已匹配，退货进入仓库核实')
        : action === 'identifyCustomer'
          ? (isEn ? 'Restaurant saved; awaiting order identification' : '餐馆已登记，记录保留在待匹配队列')
          : (isEn ? 'Intake rejected' : '已拒绝该登记'))
      setSelected(null)
      await load()
      onSaved()
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Failed') }
    finally { setBusy(false) }
  }

  function chooseIntake(row: Intake) {
    setSelected(row)
    setCustomerQuery(row.customerName === '待销售确认' ? '' : row.customerName)
    setCustomer(row.customerId ? { id: row.customerId, name: row.customerName } as Customer : null)
    setCustomers([])
    setCode('')
    setNote(row.reviewNote ?? '')
    setQuantity(String(row.quantity))
    setOrder(null)
    setLineId('')
  }

  return (
    <section className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
      <h3 className="text-sm font-semibold text-amber-900">{isEn ? 'Unreported goods — Sales matching' : '仓库漏报货物：销售匹配餐馆 / 原订单'} ({rows.length})</h3>
      <p className="text-xs text-amber-800">{isEn ? 'The warehouse records the plate and goods. Sales identifies the restaurant and, when possible, the original order. Customer-only entries remain pending until their source is known.' : '仓库先按车牌登记实物。销售选择餐馆；能确认时再匹配原订单。仅确认餐馆但暂时无法确认订单的记录会保留待匹配，不会提前生成 Credit Note。'}</p>
      {rows.length === 0 ? <p className="rounded border bg-white p-3 text-xs text-gray-500">{isEn ? 'No unmatched intake' : '暂无待匹配记录'}</p> : rows.map(row => (
        <button key={row.id} className="block w-full rounded border bg-white p-2 text-left text-sm hover:border-amber-400" onClick={() => chooseIntake(row)}>
          <span className="font-medium">{row.vehiclePlate || row.sourceTrip?.vehiclePlate || '—'} · {row.driverName || row.sourceTrip?.driverName || '—'}</span>
          <span className="mx-2 text-gray-400">{row.customerName || (isEn ? 'Restaurant unknown' : '餐馆待确认')}</span>
          <span>{row.productName} · {row.spec} · {row.quantity} {row.uomLabel}</span>
          <span className="ml-2 text-xs text-gray-500">{new Date(row.createdAt).toLocaleString('en-GB', { timeZone: 'Europe/Dublin' })}</span>
          {row.status === 'CUSTOMER_IDENTIFIED' && <span className="ml-2 text-xs text-amber-700">{isEn ? 'Restaurant identified — order needed' : '已确认餐馆，仍待匹配订单'}</span>}
        </button>
      ))}
      {selected && <div className="space-y-2 rounded border bg-white p-3">
        <div className="text-sm font-medium">{selected.vehiclePlate || selected.sourceTrip?.vehiclePlate || '—'} · {selected.productName} · {selected.spec} × {selected.quantity} {selected.uomLabel}</div>
        {selected.photo && <a className="text-xs underline" href={selected.photo} target="_blank" rel="noreferrer">{isEn ? 'View warehouse photo' : '查看仓库照片'}</a>}
        {selected.reason && <p className="text-xs text-gray-600">{isEn ? 'Warehouse note: ' : '仓库说明：'}{selected.reason}</p>}
        <div className="flex gap-2">
          <input value={customerQuery} onChange={event => { setCustomerQuery(event.target.value); setCustomer(null) }} onKeyDown={event => { if (event.key === 'Enter') void searchCustomer() }} placeholder={isEn ? 'Search restaurant' : '搜索/选择餐馆'} className="min-w-0 flex-1 rounded border p-2 text-sm" />
          <button disabled={busy} onClick={() => void searchCustomer()} className="rounded border px-3 text-sm">{isEn ? 'Search' : '搜索餐馆'}</button>
        </div>
        {customers.length > 0 && <div className="max-h-32 overflow-auto rounded border divide-y">{customers.map(item => <button key={item.id} onClick={() => { setCustomer(item); setCustomerQuery(item.name); setCustomers([]); setOrder(null); setLineId('') }} className="block w-full p-2 text-left text-sm hover:bg-gray-50">{item.name}</button>)}</div>}
        {customer && <div className="rounded bg-green-50 px-2 py-1 text-xs text-green-800">{isEn ? 'Restaurant' : '餐馆'}: {customer.name}</div>}
        {customer && <div className="flex gap-2">
          <input value={code} onChange={event => { setCode(event.target.value); setOrder(null); setLineId('') }} onKeyDown={event => { if (event.key === 'Enter') void searchOrder() }} placeholder={isEn ? 'Original order code (optional)' : '原订单号（可选）'} className="min-w-0 flex-1 rounded border p-2 text-sm" />
          <button disabled={busy || !code.trim()} onClick={() => void searchOrder()} className="rounded border px-3 text-sm">{isEn ? 'Find order' : '查找订单'}</button>
        </div>}
        {order && <>
          <div className="text-xs text-gray-600">{order.code} · {order.restaurantName}</div>
          <select value={lineId} onChange={event => setLineId(event.target.value)} className="w-full rounded border p-2 text-sm">
            <option value="">{isEn ? 'Select the original order item' : '选择原订单商品'}</option>
            {order.lines?.map(line => <option key={line.id} value={line.id}>{line.productName} · {line.spec} · {line.uomName}</option>)}
          </select>
          {lineId && <label className="block text-xs text-gray-600">{isEn ? 'Return quantity in the original order unit' : '原订单单位下的退货数量'}<input type="number" min="0.001" step="0.001" value={quantity} onChange={event => setQuantity(event.target.value)} className="mt-1 w-full rounded border p-2 text-sm" /></label>}
        </>}
        <textarea value={note} onChange={event => setNote(event.target.value)} placeholder={isEn ? 'Sales matching note (required)' : '销售匹配说明（必填）'} className="w-full rounded border p-2 text-sm" />
        {canReview && <div className="flex flex-wrap gap-2">
          <button disabled={busy || !customer} onClick={() => void act('identifyCustomer')} className="rounded border px-3 py-2 text-sm">{isEn ? 'Save restaurant; order unknown' : '仅登记餐馆，订单暂不确定'}</button>
          <button disabled={busy || !customer || !order || !lineId} onClick={() => void act('link')} className="rounded bg-[#875A7B] px-3 py-2 text-sm text-white">{isEn ? 'Match order and continue' : '匹配订单，进入退货审核'}</button>
          <button disabled={busy} onClick={() => void act('reject')} className="rounded border border-red-200 px-3 py-2 text-sm text-red-700">{isEn ? 'Reject intake' : '拒绝登记'}</button>
        </div>}
        <button onClick={() => setSelected(null)} className="text-xs text-gray-500 underline">{isEn ? 'Close' : '关闭'}</button>
      </div>}
    </section>
  )
}
