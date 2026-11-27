'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'

interface CandidateOrder {
  id: string
  code: string | null
  restaurantName: string
  deliveryDate: string | null
  status: string
  lines: Array<{ id: string; productName: string; spec: string | null; uomName: string | null; remainingQty: number }>
}

async function compressPhoto(file: File) {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('无法读取照片'))
      image.src = url
    })
    const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法处理照片')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.78)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function DriverReturnRegistration({ isEn }: { isEn: boolean }) {
  const [query, setQuery] = useState('')
  const [orders, setOrders] = useState<CandidateOrder[]>([])
  const [orderId, setOrderId] = useState('')
  const [lineId, setLineId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [reason, setReason] = useState('')
  const [lateNote, setLateNote] = useState('')
  const [photo, setPhoto] = useState('')
  const [busy, setBusy] = useState(false)
  const [searching, setSearching] = useState(false)

  const selectedOrder = orders.find(order => order.id === orderId) ?? null
  const selectedLine = selectedOrder?.lines.find(line => line.id === lineId) ?? null

  async function search() {
    if (query.trim().length < 2) return toast.error(isEn ? 'Enter at least two characters' : '请输入至少两个字符的客户名称')
    setSearching(true)
    try {
      const rows = await apiGet<CandidateOrder[]>(`/api/driver/return-candidates?q=${encodeURIComponent(query.trim())}`)
      setOrders(rows)
      setOrderId(rows[0]?.id ?? '')
      setLineId('')
      setPhoto('')
      if (!rows.length) toast.info(isEn ? 'No returnable orders found for this customer' : '没有找到本人可登记退货的订单')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (isEn ? 'Search failed' : '查询订单失败'))
    } finally {
      setSearching(false)
    }
  }

  async function submit() {
    if (!selectedOrder || !selectedLine) return toast.error(isEn ? 'Choose an order and product' : '请选择订单和商品')
    if (!(Number(quantity) > 0) || Number(quantity) > selectedLine.remainingQty) return toast.error(isEn ? 'Quantity exceeds the available return amount' : `数量须大于 0，且不超过 ${selectedLine.remainingQty}`)
    if (!reason.trim() || !photo) return toast.error(isEn ? 'A reason and photo are required' : '请填写退货原因并上传现场照片')
    if (['COMPLETED', 'LOCKED'].includes(selectedOrder.status) && !lateNote.trim()) return toast.error(isEn ? 'Explain why this return is being reported late' : '历史订单补报时请填写补报原因')
    setBusy(true)
    try {
      await apiPost('/api/driver/returns', {
        orderId: selectedOrder.id, orderLineId: selectedLine.id,
        quantity: Number(quantity), reason: reason.trim(), photo,
        lateReportNote: lateNote.trim() || undefined,
      })
      toast.success(isEn ? 'Return submitted for warehouse verification' : '退货已提交，等待仓库核实')
      setOrders([]); setOrderId(''); setLineId(''); setQuantity('1'); setReason(''); setLateNote(''); setPhoto('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (isEn ? 'Registration failed' : '登记失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mb-4 overflow-hidden rounded-xl border border-orange-200 bg-white shadow-sm" aria-label={isEn ? 'Register a return' : '登记退货'}>
      <div className="border-b border-orange-100 bg-orange-50 px-4 py-3">
        <h2 className="font-semibold text-orange-950">{isEn ? 'Register a return by customer' : '按客户查找并登记退货'}</h2>
        <p className="mt-1 text-xs text-orange-800">{isEn ? 'Only your delivered orders are searchable. Warehouse verification is required before any financial or stock changes.' : '只查询分配给本司机的已出车订单；登记后由仓库核实，确认前不会改库存或财务。'}</p>
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <div className="flex gap-2 sm:col-span-2">
          <input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void search() } }} placeholder={isEn ? 'Customer name' : '客户名称'} className="min-h-11 min-w-0 flex-1 rounded-lg border border-gray-300 px-3 text-sm" />
          <button type="button" onClick={search} disabled={searching} className="min-h-11 rounded-lg bg-gray-800 px-4 text-sm font-medium text-white disabled:opacity-50">{searching ? '…' : (isEn ? 'Search' : '查找订单')}</button>
        </div>
        {orders.length > 0 && <>
          <label className="text-xs font-medium text-gray-600">{isEn ? 'Candidate order' : '候选订单'}
            <select value={orderId} onChange={event => { setOrderId(event.target.value); setLineId('') }} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900">
              {orders.map(order => <option key={order.id} value={order.id}>{order.restaurantName} · {order.code ?? order.id.slice(-8)} · {order.deliveryDate ?? '—'}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-gray-600">{isEn ? 'Order line' : '订单商品'}
            <select value={lineId} onChange={event => setLineId(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900">
              <option value="">{isEn ? 'Select a product' : '选择商品'}</option>
              {selectedOrder?.lines.map(line => <option key={line.id} value={line.id}>{line.productName}{line.spec ? ` · ${line.spec}` : ''} · 可退 {line.remainingQty} {line.uomName ?? ''}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-gray-600">{isEn ? 'Return quantity' : '退货数量'}
            <input type="number" min="0.001" step="0.001" max={selectedLine?.remainingQty} value={quantity} onChange={event => setQuantity(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 text-base" />
          </label>
          <label className="text-xs font-medium text-gray-600">{isEn ? 'Reason' : '退货原因'}
            <input value={reason} onChange={event => setReason(event.target.value)} maxLength={500} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 text-sm" placeholder={isEn ? 'Describe the issue' : '如：客户拒收、质量问题'} />
          </label>
          {selectedOrder && ['COMPLETED', 'LOCKED'].includes(selectedOrder.status) && <label className="text-xs font-medium text-gray-600 sm:col-span-2">{isEn ? 'Why report late?' : '补报原因'}
            <input value={lateNote} onChange={event => setLateNote(event.target.value)} maxLength={500} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 text-sm" />
          </label>}
          <label className="text-xs font-medium text-gray-600 sm:col-span-2">{isEn ? 'Evidence photo (required)' : '现场照片（必填）'}
            <input type="file" accept="image/*" capture="environment" onChange={async event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              try { setPhoto(await compressPhoto(file)) } catch (error) { toast.error(error instanceof Error ? error.message : '照片处理失败') }
            }} className="mt-1 block w-full text-sm" />
            {photo && <img src={photo} alt={isEn ? 'Return evidence' : '退货现场照片'} className="mt-2 h-16 w-16 rounded border object-cover" />}
          </label>
          <button type="button" onClick={submit} disabled={busy} className="min-h-12 rounded-lg bg-orange-700 px-4 font-semibold text-white disabled:opacity-50 sm:col-span-2">{busy ? (isEn ? 'Submitting…' : '提交中…') : (isEn ? 'Register return' : '登记退货')}</button>
        </>}
      </div>
    </section>
  )
}
