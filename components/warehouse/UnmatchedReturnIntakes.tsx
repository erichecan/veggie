'use client'
import { useEffect, useState } from 'react'
import { apiGet, apiPut } from '@/lib/api'
import type { Order } from '@/lib/types'
import { toast } from 'sonner'
import { useRefetchOnFocus } from '@/lib/hooks/use-refetch-on-focus'

type Intake = { id: string; customerId: string; customerName: string; productName: string; spec: string; uomLabel: string; quantity: number; reason?: string; photo?: string; sourceTrip: { driverName?: string; vehiclePlate?: string } }
export default function UnmatchedReturnIntakes({ isEn, canVerify, onSaved }: { isEn: boolean; canVerify: boolean; onSaved: () => void }) {
  const [rows, setRows] = useState<Intake[]>([])
  const [selected, setSelected] = useState<Intake | null>(null)
  const [code, setCode] = useState(''), [note, setNote] = useState(''), [quantity, setQuantity] = useState('')
  const [order, setOrder] = useState<Order | null>(null), [lineId, setLineId] = useState('')
  const [busy, setBusy] = useState(false)
  async function load() { try { setRows(await apiGet<Intake[]>('/api/order-returns?intakes=1')) } catch (error) { toast.error(error instanceof Error ? error.message : 'Failed') } }
  useEffect(() => { load() }, [])
  useRefetchOnFocus([load])
  async function act(action: 'link' | 'reject') {
    if (!selected || !note.trim()) { toast.error(isEn ? 'A warehouse note is required' : '请填写核实说明'); return }
    setBusy(true)
    try { await apiPut(`/api/order-returns/intakes/${selected.id}`, { action, note, orderId: order?.id, orderLineId: lineId, quantity: Number(quantity) }); setSelected(null); await load(); onSaved() } catch (error) { toast.error(error instanceof Error ? error.message : 'Failed') } finally { setBusy(false) }
  }
  return <section className="mb-3 rounded border border-amber-200 bg-amber-50 p-3 space-y-2"><h3 className="font-semibold text-sm">{isEn ? 'Historical goods awaiting source matching' : '历史退货：待匹配原单'} ({rows.length})</h3>{rows.map(row => <button key={row.id} className="block w-full rounded border bg-white p-2 text-left text-sm" onClick={() => { setSelected(row); setCode(''); setNote(''); setQuantity(String(row.quantity)); setOrder(null); setLineId('') }}>{row.customerName} · {row.productName} · {row.spec} × {row.quantity} {row.uomLabel}<span className="block text-xs text-gray-500">{row.sourceTrip.driverName} / {row.sourceTrip.vehiclePlate || '—'}</span></button>)}{selected && <div className="rounded border bg-white p-3 space-y-2"><p className="text-sm">{selected.productName} · {selected.spec} · {selected.reason}</p>{selected.photo && <a className="text-sm underline" href={selected.photo} target="_blank" rel="noreferrer">{isEn ? 'View photo' : '查看照片'}</a>}<input aria-label={isEn ? 'Original order number' : '原订单号'} placeholder="D-261109-007" value={code} onChange={e => { setCode(e.target.value); setOrder(null); setLineId('') }} className="w-full rounded border p-2 text-sm" /><button disabled={busy} className="rounded border px-3 py-2 text-sm" onClick={async () => {
    setBusy(true)
    try { const data = await apiGet<{ data: Order[] }>(`/api/orders?colCode=${encodeURIComponent(code.trim())}&include_lines=true&pageSize=20`); const found = data.data.find(row => row.restaurantId === selected.customerId && row.code?.toLowerCase() === code.trim().toLowerCase()); if (!found) throw new Error(isEn ? 'No original order found for this customer' : '未找到该客户的原订单'); setOrder(found) } catch (error) { toast.error(error instanceof Error ? error.message : 'Failed') } finally { setBusy(false) }
  }}>{isEn ? 'Find original order' : '查找原订单'}</button>{order && <><select aria-label={isEn ? 'Original order line' : '原订单行'} value={lineId} onChange={e => setLineId(e.target.value)} className="w-full rounded border p-2 text-sm"><option value="">{isEn ? 'Select source line' : '选择原订单行'}</option>{order.lines?.map(line => <option key={line.id} value={line.id}>{line.productName} · {line.spec} · {line.uomName} · {line.deliveredQty}</option>)}</select><label className="block text-sm">{isEn ? 'Return quantity IN ORIGINAL ORDER UNIT (check conversion)' : '原订单单位下的退货数量（请核对单位换算）'}<input type="number" min="0.001" step="0.001" value={quantity} onChange={e => setQuantity(e.target.value)} className="w-full rounded border p-2" /></label></>}<textarea aria-label={isEn ? 'Warehouse matching note' : '仓库匹配说明'} placeholder={isEn ? 'Source/quality/unit verification, or rejection reason' : '来源、质量、单位核对说明；拒绝时填写原因'} value={note} onChange={e => setNote(e.target.value)} className="w-full rounded border p-2 text-sm" /><div className="flex flex-wrap gap-2">{canVerify && <><button disabled={busy || !lineId} onClick={() => act('link')} className="rounded border px-3 py-2 text-sm">{isEn ? 'Link and start warehouse check' : '匹配原单，进入仓库验收'}</button><button disabled={busy} onClick={() => act('reject')} className="rounded border px-3 py-2 text-sm text-red-700">{isEn ? 'Reject / not our goods' : '拒绝 / 非本公司货物'}</button></>}<button onClick={() => setSelected(null)} className="rounded border px-3 py-2 text-sm">{isEn ? 'Close' : '关闭'}</button></div></div>}</section>
}
