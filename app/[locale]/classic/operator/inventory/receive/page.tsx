'use client'
import { useEffect, useMemo, useState, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { formatDateOnly } from '@/lib/format-date'

const PURPLE = '#875A7B'

interface POLine {
  id: string
  productId: string
  productName: string
  uomId?: string | null
  orderedQty: number
  receivedQty: number
  unitCost: number
  bestBefore?: string | null
}

interface PurchaseOrder {
  id: string
  name: string
  status: string
  supplierId: string
  supplierName?: string
  orderDate: string
  expectedDate?: string | null
  lines: POLine[]
}

interface Supplier {
  id: string
  name: string
}

interface Uom {
  id: string
  name: string
}

interface GoodsReceiptLine {
  productId: string
  productName: string
  qty: number
  condition?: 'ok' | 'damaged'
}

interface GoodsReceiptHistoryRow {
  id: string
  name: string
  arrivedAt: string
  receivedBy?: string | null
  notes?: string | null
  photos?: string[]
  lines: GoodsReceiptLine[]
  purchaseOrder?: { id: string; name: string; supplierId: string } | null
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function toInputDate(iso?: string | null) {
  if (!iso) return ''
  try { return new Date(iso).toISOString().slice(0, 10) } catch { return '' }
}

/** 单张照片体积上限：base64 直存数据库（复用司机退货证据同一套轻量方案），不适合大文件 */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024

interface LineDraft {
  goodQty: string
  badQty: string
  bestBefore: string
}

export default function ReceivePage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  return (
    <Suspense fallback={<div className="py-16 text-center text-gray-400 text-sm">{isEn ? 'Loading...' : '加载中...'}</div>}>
      <ReceivePageInner />
    </Suspense>
  )
}

function ReceivePageInner() {
  const searchParams = useSearchParams()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [pos, setPos] = useState<PurchaseOrder[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [uoms, setUoms] = useState<Uom[]>([])
  const [listLoading, setListLoading] = useState(true)

  const [selectedPo, setSelectedPo] = useState<PurchaseOrder | null>(null)
  const [poLoading, setPoLoading] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({})
  const [arrivedAt, setArrivedAt] = useState(today())
  const [notes, setNotes] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  const [viewMode, setViewMode] = useState<'pending' | 'history'>('pending')
  const [history, setHistory] = useState<GoodsReceiptHistoryRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [expandedGrId, setExpandedGrId] = useState<string | null>(null)

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const data = await apiGet<{ items: GoodsReceiptHistoryRow[]; total: number }>('/api/goods-receipts?limit=100')
      setHistory(data.items ?? [])
    } catch {
      toast.error(isEn ? 'Failed to load receipt history' : '加载收货记录失败')
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => { if (viewMode === 'history') loadHistory() }, [viewMode, loadHistory])

  const loadList = useCallback(async () => {
    setListLoading(true)
    try {
      const data = await apiGet<PurchaseOrder[] | { items: PurchaseOrder[] }>('/api/purchase-orders?status=CONFIRMED')
      setPos(Array.isArray(data) ? data : (data.items ?? []))
    } catch {
      toast.error(isEn ? 'Failed to load pending purchase orders' : '加载待收货采购单失败')
    } finally {
      setListLoading(false)
    }
  }, [])

  useEffect(() => { loadList() }, [loadList])

  useEffect(() => {
    apiGet<{ items: Supplier[] } | Supplier[]>('/api/customers?isVendor=true&limit=200')
      .then(d => setSuppliers(Array.isArray(d) ? d : (d.items ?? [])))
      .catch(() => {})
    apiGet<Uom[]>('/api/uoms').then(setUoms).catch(() => {})
  }, [])

  const uomMap = useMemo(() => new Map(uoms.map(u => [u.id, u.name])), [uoms])
  const supplierMap = useMemo(() => new Map(suppliers.map(s => [s.id, s.name])), [suppliers])

  async function openPo(poId: string) {
    setPoLoading(true)
    try {
      const po = await apiGet<PurchaseOrder>(`/api/purchase-orders/${poId}`)
      setSelectedPo(po)
      const nextDrafts: Record<string, LineDraft> = {}
      for (const l of po.lines) {
        const remaining = Math.max(0, Number(l.orderedQty) - Number(l.receivedQty))
        nextDrafts[l.id] = {
          goodQty: remaining > 0 ? String(remaining) : '',
          badQty: '',
          bestBefore: toInputDate(l.bestBefore),
        }
      }
      setDrafts(nextDrafts)
      setArrivedAt(today())
      setNotes('')
      setPhotos([])
    } catch {
      toast.error(isEn ? 'Failed to load purchase order details' : '加载采购单详情失败')
    } finally {
      setPoLoading(false)
    }
  }

  // 深链：从采购单详情页「确认收货」按钮跳转过来时带 ?poId=，自动选中
  useEffect(() => {
    const poId = searchParams.get('poId')
    if (poId) openPo(poId)
  }, [searchParams])

  function updateDraft(lineId: string, field: keyof LineDraft, value: string) {
    setDrafts(prev => ({ ...prev, [lineId]: { ...prev[lineId], [field]: value } }))
  }

  function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    for (const file of files) {
      if (file.size > MAX_PHOTO_BYTES) {
        toast.error(isEn ? `${file.name} exceeds 5MB, please compress before uploading` : `${file.name} 超过 5MB，请压缩后再上传`)
        continue
      }
      const reader = new FileReader()
      reader.onload = () => setPhotos(prev => [...prev, reader.result as string])
      reader.readAsDataURL(file)
    }
  }

  function removePhoto(idx: number) {
    setPhotos(prev => prev.filter((_, i) => i !== idx))
  }

  const totalGood = useMemo(() => {
    if (!selectedPo) return 0
    return selectedPo.lines.reduce((s, l) => s + (Number(drafts[l.id]?.goodQty) || 0), 0)
  }, [selectedPo, drafts])

  const totalBad = useMemo(() => {
    if (!selectedPo) return 0
    return selectedPo.lines.reduce((s, l) => s + (Number(drafts[l.id]?.badQty) || 0), 0)
  }, [selectedPo, drafts])

  async function handleSubmit() {
    if (!selectedPo) return
    const lines: Array<{ productId: string; productName: string; qty: number; uomId?: string | null; condition: 'ok' | 'damaged'; bestBefore?: string | null }> = []
    for (const l of selectedPo.lines) {
      const d = drafts[l.id]
      if (!d) continue
      const good = Number(d.goodQty) || 0
      const bad = Number(d.badQty) || 0
      if (good > 0) {
        lines.push({ productId: l.productId, productName: l.productName, qty: good, uomId: l.uomId, condition: 'ok', bestBefore: d.bestBefore || null })
      }
      if (bad > 0) {
        lines.push({ productId: l.productId, productName: l.productName, qty: bad, uomId: l.uomId, condition: 'damaged' })
      }
    }
    if (lines.length === 0) {
      toast.error(isEn ? 'Please enter a received quantity for at least one line' : '请至少填写一行的收货数量')
      return
    }
    setSubmitting(true)
    try {
      await apiPost('/api/goods-receipts', {
        purchaseOrderId: selectedPo.id,
        arrivedAt,
        notes: notes || null,
        photos,
        lines,
      })
      toast.success(isEn ? 'Goods receipt recorded' : '收货成功')
      setSelectedPo(null)
      loadList()
      if (viewMode === 'history') loadHistory()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to record goods receipt' : '收货失败'))
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls = 'border border-gray-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:border-blue-400'
  const numInputCls = `${inputCls} text-right [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`

  if (selectedPo) {
    const supplierName = supplierMap.get(selectedPo.supplierId) ?? selectedPo.supplierName ?? selectedPo.supplierId

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <button onClick={() => setSelectedPo(null)} className="text-sm hover:underline" style={{ color: PURPLE }}>
              {isEn ? '← Back to pending list' : '← 返回待收货列表'}
            </button>
            <h2 className="text-lg font-semibold text-gray-800 mt-1">
              {isEn ? 'Receive' : '收货'} · {selectedPo.name} <span className="text-sm font-normal text-gray-500">{supplierName}</span>
            </h2>
          </div>
        </div>

        {poLoading ? (
          <div className="py-16 text-center text-gray-400 text-sm">{isEn ? 'Loading...' : '加载中...'}</div>
        ) : (
          <>
            {/* 头部信息 */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">{isEn ? 'Arrival Date' : '到货日期'}</label>
                <input type="date" value={arrivedAt} onChange={e => setArrivedAt(e.target.value)} className={`w-full ${inputCls}`} />
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-gray-500 mb-1">{isEn ? 'Source verification notes (vehicle / driver / supplier info, etc.)' : '来源核对备注（车辆/司机/供应商信息等）'}</label>
                <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder={isEn ? 'e.g. White van, driver Zhang San, matches supplier delivery note' : '例如：白色厢式货车，司机张三，与供应商送货单一致'}
                  className={`w-full ${inputCls}`} />
              </div>
            </div>

            {/* 明细行 */}
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-3 py-2.5">{isEn ? 'Product' : '商品'}</th>
                    <th className="text-right px-3 py-2.5">{isEn ? 'Ordered' : '订购'}</th>
                    <th className="text-right px-3 py-2.5">{isEn ? 'Received' : '已收'}</th>
                    <th className="text-right px-3 py-2.5">{isEn ? 'Good (this receipt)' : '本次良品'}</th>
                    <th className="text-right px-3 py-2.5">{isEn ? 'Damaged (this receipt)' : '本次损坏'}</th>
                    <th className="text-left px-3 py-2.5">{isEn ? 'Best Before' : '保质期'}</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedPo.lines.map(l => {
                    const d = drafts[l.id] ?? { goodQty: '', badQty: '', bestBefore: '' }
                    const remaining = Math.max(0, Number(l.orderedQty) - Number(l.receivedQty))
                    return (
                      <tr key={l.id} className="border-b border-gray-100">
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-gray-800">{l.productName}</div>
                          <div className="text-xs text-gray-400">{isEn ? `Remaining: ${remaining}` : `剩余待收 ${remaining}`} {uomMap.get(l.uomId ?? '') ?? ''}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right text-gray-600">{Number(l.orderedQty)}</td>
                        <td className="px-3 py-2.5 text-right text-gray-600">{Number(l.receivedQty)}</td>
                        <td className="px-3 py-2.5 text-right">
                          <input type="number" step="0.001" min="0" value={d.goodQty}
                            onChange={e => updateDraft(l.id, 'goodQty', e.target.value)}
                            className={numInputCls} style={{ width: '90px' }} />
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <input type="number" step="0.001" min="0" value={d.badQty}
                            onChange={e => updateDraft(l.id, 'badQty', e.target.value)}
                            className={numInputCls} style={{ width: '90px' }} />
                        </td>
                        <td className="px-3 py-2.5">
                          <input type="date" value={d.bestBefore}
                            onChange={e => updateDraft(l.id, 'bestBefore', e.target.value)}
                            className={inputCls} style={{ width: '150px' }} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="px-4 py-3 bg-gray-50 text-sm text-gray-600 flex items-center gap-4">
                <span>{isEn ? `Total this receipt: Good ${totalGood}` : `本次合计：良品 ${totalGood}`}{totalBad > 0 && <span className="text-red-600">{isEn ? ` · Damaged ${totalBad}` : ` · 损坏 ${totalBad}`}</span>}</span>
                {totalBad > 0 && (
                  <span className="text-xs text-amber-600">{isEn ? `Damaged items are not stocked in and will be recorded as scrap (${'Damaged on arrival (transport/supplier liability)'}), to help track losses and claim against the supplier` : `损坏部分不入库，会记一笔报废留痕（${'到货即损坏（运输/供应商责任）'}），方便追损耗/找供应商索赔`}</span>
                )}
              </div>
            </div>

            {/* 取证照片 */}
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <label className="block text-xs text-gray-500 mb-2">{isEn ? 'Evidence photos (vehicle / outer packaging / unboxing count / damage detail, etc., max 5MB each)' : '取证照片（车辆/外包装/开箱点数/破损细节等，单张不超过 5MB）'}</label>
              <div className="flex items-center gap-3 flex-wrap">
                {photos.map((src, i) => (
                  <div key={i} className="relative">
                    <img src={src} alt={isEn ? `Receipt photo ${i + 1}` : `收货照片 ${i + 1}`} className="w-20 h-20 rounded object-cover border border-gray-200" />
                    <button onClick={() => removePhoto(i)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center">
                      ×
                    </button>
                  </div>
                ))}
                <label className="w-20 h-20 rounded border border-dashed border-gray-300 flex items-center justify-center text-gray-400 text-2xl cursor-pointer hover:border-gray-400">
                  +
                  <input type="file" accept="image/*" multiple className="hidden" onChange={handlePhotoUpload} />
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setSelectedPo(null)}
                className="px-4 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">
                {isEn ? 'Cancel' : '取消'}
              </button>
              <button onClick={handleSubmit} disabled={submitting}
                className="px-5 py-2 rounded text-sm font-medium text-white disabled:opacity-50"
                style={{ background: PURPLE }}>
                {submitting ? (isEn ? 'Submitting...' : '提交中...') : (isEn ? 'Confirm Receipt' : '确认收货')}
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => setViewMode('pending')}
            className="px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
            style={viewMode === 'pending' ? { background: '#fff', color: PURPLE, boxShadow: '0 1px 2px rgba(0,0,0,.06)' } : { color: '#6b7280' }}>
            {isEn ? 'Pending' : '待收货'}
          </button>
          <button
            onClick={() => setViewMode('history')}
            className="px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
            style={viewMode === 'history' ? { background: '#fff', color: PURPLE, boxShadow: '0 1px 2px rgba(0,0,0,.06)' } : { color: '#6b7280' }}>
            {isEn ? 'Receipt History' : '收货记录'}
          </button>
        </div>
        <span className="text-sm text-gray-400">
          {viewMode === 'pending'
            ? (isEn ? `${pos.length} purchase order(s) pending receipt` : `${pos.length} 张采购单待收货`)
            : (isEn ? `${history.length} receipt record(s) total` : `共 ${history.length} 条收货记录`)}
        </span>
      </div>

      {viewMode === 'pending' ? (
        listLoading ? (
          <div className="py-16 text-center text-gray-400 text-sm">{isEn ? 'Loading...' : '加载中...'}</div>
        ) : pos.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">{isEn ? 'No purchase orders pending receipt' : '暂无待收货采购单'}</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {pos.map(po => {
              const supplierName = supplierMap.get(po.supplierId) ?? po.supplierName ?? po.supplierId
              const lineCount = po.lines.length
              const remainingLines = po.lines.filter(l => Number(l.receivedQty) < Number(l.orderedQty)).length
              return (
                <button key={po.id} onClick={() => openPo(po.id)}
                  className="text-left bg-white rounded-lg border border-gray-200 p-4 hover:border-gray-300 hover:shadow-sm transition-all">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold" style={{ color: PURPLE }}>{po.name}</span>
                    <span className="text-xs text-gray-400">{isEn ? `Expected arrival ${formatDateOnly(po.expectedDate) || '—'}` : `预计到货 ${formatDateOnly(po.expectedDate) || '—'}`}</span>
                  </div>
                  <div className="text-sm text-gray-700 mt-1">{supplierName}</div>
                  <div className="text-xs text-gray-400 mt-1">
                    {isEn
                      ? `Order date ${formatDateOnly(po.orderDate)} · ${lineCount} item(s), ${remainingLines} pending receipt`
                      : `订购日期 ${formatDateOnly(po.orderDate)} · ${lineCount} 个品项，${remainingLines} 个待收货`}
                  </div>
                </button>
              )
            })}
          </div>
        )
      ) : historyLoading ? (
        <div className="py-16 text-center text-gray-400 text-sm">{isEn ? 'Loading...' : '加载中...'}</div>
      ) : history.length === 0 ? (
        <div className="py-16 text-center text-gray-400 text-sm">{isEn ? 'No receipt records' : '暂无收货记录'}</div>
      ) : (
        <div className="space-y-2">
          {history.map(gr => {
            const supplierName = gr.purchaseOrder ? (supplierMap.get(gr.purchaseOrder.supplierId) ?? gr.purchaseOrder.supplierId) : '—'
            const goodLines = gr.lines.filter(l => (l.condition ?? 'ok') === 'ok')
            const badLines = gr.lines.filter(l => l.condition === 'damaged')
            const expanded = expandedGrId === gr.id
            return (
              <div key={gr.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <button
                  onClick={() => setExpandedGrId(expanded ? null : gr.id)}
                  className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-gray-50">
                  <div>
                    <span className="font-semibold text-gray-800">{gr.name}</span>
                    <span className="text-sm text-gray-500 ml-2">{gr.purchaseOrder?.name ?? '—'} · {supplierName}</span>
                    {badLines.length > 0 && (
                      <span className="text-xs text-red-600 ml-2">{isEn ? `${badLines.length} item(s) damaged` : `${badLines.length} 项有损坏`}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-400">
                    <span>{isEn ? `Arrived ${formatDateOnly(gr.arrivedAt)}` : `到货 ${formatDateOnly(gr.arrivedAt)}`}{gr.receivedBy ? ` · ${gr.receivedBy}` : ''}</span>
                    <span>{expanded ? (isEn ? 'Collapse ▲' : '收起 ▲') : (isEn ? 'Expand ▼' : '展开 ▼')}</span>
                  </div>
                </button>
                {expanded && (
                  <div className="px-4 pb-4 border-t border-gray-100 pt-3">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-gray-500">
                          <th className="text-left py-1">{isEn ? 'Product' : '商品'}</th>
                          <th className="text-right py-1">{isEn ? 'Good Qty' : '良品数量'}</th>
                          <th className="text-right py-1">{isEn ? 'Damaged Qty' : '损坏数量'}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gr.lines.map((l, i) => {
                          const isBad = l.condition === 'damaged'
                          return (
                            <tr key={`${l.productId}-${i}`} className="border-t border-gray-50">
                              <td className="py-1.5 text-gray-800">{l.productName}</td>
                              <td className="py-1.5 text-right text-gray-600">{!isBad ? Number(l.qty) : '—'}</td>
                              <td className="py-1.5 text-right">{isBad ? <span className="text-red-600">{Number(l.qty)}</span> : '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                      {(goodLines.length > 0 || badLines.length > 0) && (
                        <tfoot>
                          <tr className="border-t border-gray-200 font-medium">
                            <td className="py-1.5 text-gray-600">{isEn ? 'Total' : '合计'}</td>
                            <td className="py-1.5 text-right text-gray-700">{goodLines.reduce((s, l) => s + Number(l.qty), 0)}</td>
                            <td className="py-1.5 text-right text-red-600">{badLines.reduce((s, l) => s + Number(l.qty), 0) || '—'}</td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                    {gr.notes && <div className="text-xs text-gray-500 mt-2">{isEn ? `Notes: ${gr.notes}` : `备注：${gr.notes}`}</div>}
                    {(gr.photos?.length ?? 0) > 0 && (
                      <div className="flex gap-1.5 mt-2 flex-wrap">
                        {(gr.photos ?? []).map((src, i) => (
                          <img key={i} src={src} alt={isEn ? `${gr.name} photo ${i + 1}` : `${gr.name} 照片 ${i + 1}`} className="w-16 h-16 rounded object-cover border border-gray-200" />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
