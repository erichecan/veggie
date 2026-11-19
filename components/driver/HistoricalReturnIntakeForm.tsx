'use client'
import { useState } from 'react'
import { apiPost } from '@/lib/api'
import { toast } from 'sonner'

export default function HistoricalReturnIntakeForm({ tripId, customerId, photo, lateNote, isLate, isEn, onSaved }: { tripId: string; customerId: string; photo: string | null; lateNote: string; isLate: boolean; isEn: boolean; onSaved: () => void }) {
  const [form, setForm] = useState({ productName: '', spec: '', uomLabel: '', quantity: '', reason: '' })
  const [busy, setBusy] = useState(false)
  return <details className="rounded border border-amber-200 p-3"><summary className="cursor-pointer text-sm font-medium">{isEn ? 'Original order unknown? Register goods for warehouse matching' : '不知道原订单？先登记商品，交仓库匹配'}</summary><div className="mt-2 space-y-2">{(['productName','spec','uomLabel','quantity','reason'] as const).map(key => <label key={key} className="block text-sm">{({ productName: isEn ? 'Product name' : '商品名', spec: isEn ? 'Specification' : '规格', uomLabel: isEn ? 'Unit' : '单位', quantity: isEn ? 'Quantity' : '数量', reason: isEn ? 'Reason' : '原因' })[key]}<input value={form[key]} type={key === 'quantity' ? 'number' : 'text'} min={key === 'quantity' ? '0.001' : undefined} step={key === 'quantity' ? '0.001' : undefined} onChange={e => setForm({ ...form, [key]: e.target.value })} className="w-full rounded border p-2" /></label>)}<p className="text-xs text-amber-700">{isEn ? 'Use the photo controls below. Goods remain on hold until warehouse matches the source order; no automatic refund.' : '使用下方拍照功能。匹配来源前仅登记待核实实物，不自动退款或入可售库存。'}</p><button disabled={busy} className="min-h-11 rounded border bg-amber-50 px-3 text-sm" onClick={async () => {
    if (!photo || Object.values(form).some(value => !value.trim()) || !(Number(form.quantity) > 0) || (isLate && !lateNote.trim())) { toast.error(isEn ? 'Complete all fields, take a photo and provide a late report reason if required' : '请完整填写商品信息、拍照；补报时填写补报原因'); return }
    setBusy(true)
    try { await apiPost(`/api/trips/${tripId}/returns`, { restaurantId: customerId, returns: [{ ...form, returnKind: 'HISTORICAL', quantity: Number(form.quantity), photo, lateReportNote: lateNote || undefined }] }); toast.success(isEn ? 'Registered for warehouse matching' : '已登记，等待仓库匹配原单'); onSaved() } catch (error) { toast.error(error instanceof Error ? error.message : 'Failed') } finally { setBusy(false) }
  }}>{isEn ? 'Register unmatched goods' : '登记待匹配货物'}</button></div></details>
}
