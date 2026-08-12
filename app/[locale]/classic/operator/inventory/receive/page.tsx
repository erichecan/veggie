'use client'
import { useEffect, useMemo, useState, useCallback, Suspense, Fragment } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { formatDateOnly } from '@/lib/format-date'
import { arrivalDelay, describeArrivalDelay, describeArrivalDelayEn } from '@/lib/receipt-linkage'
import {
  FRESHNESS_GRADES, FRESHNESS_LABELS, PESTICIDE_RESULTS, PESTICIDE_LABELS,
  QC_REJECT_REASONS, QC_REJECT_REASON_LABELS,
  parseStoredQc, lineVerdict, validateQcLines, formatQcSummary,
  type QcRecord, type QcRejectReason,
} from '@/lib/purchase/qc'

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
  condition?: 'ok' | 'damaged' | 'rejected'
  /** 质检记录（台账 F4）：可留空 */
  qc?: QcRecord | null
  rejectReason?: QcRejectReason | null
}

interface GoodsReceiptHistoryRow {
  id: string
  name: string
  arrivedAt: string
  receivedBy?: string | null
  notes?: string | null
  /// 列表接口不返回 photos（它们是 base64，23 条就 6 MB），只给数量；展开时按需拉
  photoCount?: number
  photos?: string[]
  lines: GoodsReceiptLine[]
  purchaseOrder?: { id: string; name: string; supplierId: string; expectedDate?: string | null } | null
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
  /** 质检三项（台账 F4）——全部可留空，留空即"这行没做质检" */
  qcWeight: string
  qcFreshness: string
  qcPesticide: string
  qcNote: string
  /** 拒收：不入库、不计已收数量，必须给原因 */
  rejectQty: string
  rejectReason: string
}

const EMPTY_DRAFT: LineDraft = {
  goodQty: '', badQty: '', bestBefore: '',
  qcWeight: '', qcFreshness: '', qcPesticide: '', qcNote: '',
  rejectQty: '', rejectReason: '',
}

/**
 * 输入中的质检草稿 → 质检记录。
 * 用**宽松**解析（parseStoredQc）而不是写入端的严格版：边打字边校验会在
 * 输入到一半时弹错。真正的把关在提交时（validateQcLines）和服务端。
 */
function draftToQc(d: LineDraft): QcRecord | null {
  return parseStoredQc({
    weightKg: d.qcWeight, freshness: d.qcFreshness, pesticide: d.qcPesticide, note: d.qcNote,
  })
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
  /** 质检面板逐行展开：默认收起，保证「不做质检」的日常收货一步都没多 */
  const [qcOpen, setQcOpen] = useState<Record<string, boolean>>({})
  const [arrivedAt, setArrivedAt] = useState(today())
  const [notes, setNotes] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  const [viewMode, setViewMode] = useState<'pending' | 'history'>('pending')
  const [history, setHistory] = useState<GoodsReceiptHistoryRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [expandedGrId, setExpandedGrId] = useState<string | null>(null)
  /** 未关联采购单的入库（台账 E6）：绕过收货单直接进库存的流水 */
  const [unlinked, setUnlinked] = useState<{
    count: number; scanned: number; qty: number; truncated?: boolean
    items: Array<{ id: string; productName: string; qty: string | number; type: string; sourceType: string | null; note: string | null; movedAt: string }>
  } | null>(null)
  // 展开某条时才去取它的取证照片。列表接口刻意不带 photos —— 那些是 base64 data URI，
  // 23 条收货单里 photos 就占 6.02 MB（99%），而列表默认全是折叠的。
  const [grPhotos, setGrPhotos] = useState<Record<string, string[]>>({})

  async function loadPhotos(id: string) {
    if (grPhotos[id]) return
    try {
      const one = await apiGet<{ photos?: string[] }>(`/api/goods-receipts?id=${encodeURIComponent(id)}`)
      setGrPhotos(prev => ({ ...prev, [id]: one.photos ?? [] }))
    } catch { setGrPhotos(prev => ({ ...prev, [id]: [] })) }
  }

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

  // 未关联入库与收货历史同屏展示：只有把「没走采购单的货」摆在收货记录旁边，
  // 才看得出这个月到底有多少货是没有采购依据进来的
  useEffect(() => {
    if (viewMode !== 'history') return
    apiGet<NonNullable<typeof unlinked>>('/api/goods-receipts/unlinked?days=30&limit=50')
      .then(setUnlinked)
      .catch(() => setUnlinked(null))
  }, [viewMode])

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
          ...EMPTY_DRAFT,
          goodQty: remaining > 0 ? String(remaining) : '',
          bestBefore: toInputDate(l.bestBefore),
        }
      }
      setDrafts(nextDrafts)
      setQcOpen({})
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

  const totalRejected = useMemo(() => {
    if (!selectedPo) return 0
    return selectedPo.lines.reduce((s, l) => s + (Number(drafts[l.id]?.rejectQty) || 0), 0)
  }, [selectedPo, drafts])

  async function handleSubmit() {
    if (!selectedPo) return
    const lines: Array<{
      productId: string; productName: string; qty: number; uomId?: string | null
      condition: 'ok' | 'damaged' | 'rejected'; bestBefore?: string | null
      qc?: QcRecord | null; rejectReason?: string | null
    }> = []
    for (const l of selectedPo.lines) {
      const d = drafts[l.id]
      if (!d) continue
      const good = Number(d.goodQty) || 0
      const bad = Number(d.badQty) || 0
      const rejected = Number(d.rejectQty) || 0
      // 质检是**对这一行货**做的，一行可能被拆成良品/损坏/拒收三条提交行。
      // 质检记录只挂在其中第一条上 —— 抄三份的话，事后统计「质检了几行」会翻三倍，
      // 而改其中一条又会让三份互相矛盾。
      const qc = draftToQc(d)
      if (good > 0) {
        lines.push({ productId: l.productId, productName: l.productName, qty: good, uomId: l.uomId, condition: 'ok', bestBefore: d.bestBefore || null, qc })
      }
      if (bad > 0) {
        lines.push({ productId: l.productId, productName: l.productName, qty: bad, uomId: l.uomId, condition: 'damaged', qc: good > 0 ? null : qc })
      }
      if (rejected > 0) {
        lines.push({
          productId: l.productId, productName: l.productName, qty: rejected, uomId: l.uomId,
          condition: 'rejected', qc: good > 0 || bad > 0 ? null : qc,
          rejectReason: d.rejectReason || null,
        })
      }
    }
    if (lines.length === 0) {
      toast.error(isEn ? 'Please enter a received quantity for at least one line' : '请至少填写一行的收货数量')
      return
    }
    // 提交前先用**与服务端同一份**纯函数校验，错误当场指到具体商品；
    // 服务端仍会再校一遍（前端校验只是省一次往返，不是权威）
    const qcError = validateQcLines(lines)
    if (qcError) { toast.error(qcError); return }
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
                {/* 预计到货日就摆在实际到货日旁边（台账 E6）——收货现场当场就能看出早了还是晚了，
                    不用事后再去采购单里对一遍；准时率也才有可信的原始数据 */}
                {(() => {
                  const d = arrivalDelay(selectedPo.expectedDate, arrivedAt)
                  const text = isEn ? describeArrivalDelayEn(d) : describeArrivalDelay(d)
                  return (
                    <div className="mt-1 text-xs text-gray-500 flex items-center gap-1.5 flex-wrap">
                      <span>{isEn ? 'Expected' : '预计到货'} {formatDateOnly(selectedPo.expectedDate) || '—'}</span>
                      {text && (
                        <span className={`px-1.5 py-0.5 rounded ${
                          d.timing === 'LATE' ? 'bg-red-50 text-red-600'
                          : d.timing === 'EARLY' ? 'bg-blue-50 text-blue-600'
                          : 'bg-emerald-50 text-emerald-600'}`}>{text}</span>
                      )}
                      {!text && <span className="text-gray-400">{isEn ? '(PO has no expected date)' : '（采购单未填预计到货日）'}</span>}
                    </div>
                  )
                })()}
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
                    <th className="text-left px-3 py-2.5">{isEn ? 'QC' : '质检'}</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedPo.lines.map(l => {
                    const d = drafts[l.id] ?? EMPTY_DRAFT
                    const remaining = Math.max(0, Number(l.orderedQty) - Number(l.receivedQty))
                    const qc = draftToQc(d)
                    const rejectQty = Number(d.rejectQty) || 0
                    const verdict = lineVerdict(qc, rejectQty)
                    return (
                      <Fragment key={l.id}>
                      <tr className="border-b border-gray-100">
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
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <button type="button"
                              onClick={() => setQcOpen(prev => ({ ...prev, [l.id]: !prev[l.id] }))}
                              className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50">
                              {qcOpen[l.id] ? (isEn ? 'Close ▲' : '收起 ▲') : (isEn ? 'QC ▼' : '填质检 ▼')}
                            </button>
                            {verdict && (
                              <span className={`text-xs px-1.5 py-0.5 rounded ${verdict === 'FAIL' ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'}`}>
                                {verdict === 'FAIL' ? (isEn ? 'Failed' : '不合格') : (isEn ? 'Passed' : '合格')}
                              </span>
                            )}
                            {rejectQty > 0 && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700">
                                {isEn ? `Rejected ${rejectQty}` : `拒收 ${rejectQty}`}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                      {qcOpen[l.id] && (
                        <tr className="border-b border-gray-100 bg-gray-50/70">
                          <td colSpan={7} className="px-3 py-3">
                            <div className="flex flex-wrap gap-x-4 gap-y-3 items-end">
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">{isEn ? 'Measured weight (kg)' : '实测重量（kg）'}</label>
                                <input type="number" step="0.001" min="0" value={d.qcWeight}
                                  onChange={e => updateDraft(l.id, 'qcWeight', e.target.value)}
                                  placeholder={isEn ? 'blank = not weighed' : '留空=未称重'}
                                  className={numInputCls} style={{ width: '130px' }} />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">{isEn ? 'Freshness' : '新鲜度'}</label>
                                <select value={d.qcFreshness} onChange={e => updateDraft(l.id, 'qcFreshness', e.target.value)}
                                  className={inputCls} style={{ width: '130px' }}>
                                  <option value="">{isEn ? '— not graded —' : '— 未评级 —'}</option>
                                  {FRESHNESS_GRADES.map(g => (
                                    <option key={g} value={g}>{isEn ? FRESHNESS_LABELS[g].en : FRESHNESS_LABELS[g].zh}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">{isEn ? 'Pesticide residue' : '农残检测'}</label>
                                <select value={d.qcPesticide} onChange={e => updateDraft(l.id, 'qcPesticide', e.target.value)}
                                  className={inputCls} style={{ width: '130px' }}>
                                  <option value="">{isEn ? '— not recorded —' : '— 未记录 —'}</option>
                                  {PESTICIDE_RESULTS.map(r => (
                                    <option key={r} value={r}>{isEn ? PESTICIDE_LABELS[r].en : PESTICIDE_LABELS[r].zh}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="block text-xs text-red-600 mb-1">{isEn ? 'Reject qty' : '拒收数量'}</label>
                                <input type="number" step="0.001" min="0" value={d.rejectQty}
                                  onChange={e => updateDraft(l.id, 'rejectQty', e.target.value)}
                                  className={numInputCls} style={{ width: '110px' }} />
                              </div>
                              <div>
                                <label className="block text-xs text-red-600 mb-1">{isEn ? 'Reject reason (required)' : '拒收原因（必填）'}</label>
                                <select value={d.rejectReason} onChange={e => updateDraft(l.id, 'rejectReason', e.target.value)}
                                  className={inputCls} style={{ width: '160px' }}>
                                  <option value="">{isEn ? '— select —' : '— 请选择 —'}</option>
                                  {QC_REJECT_REASONS.map(r => (
                                    <option key={r} value={r}>{isEn ? QC_REJECT_REASON_LABELS[r].en : QC_REJECT_REASON_LABELS[r].zh}</option>
                                  ))}
                                </select>
                              </div>
                              <div className="flex-1 min-w-[220px]">
                                <label className="block text-xs text-gray-500 mb-1">{isEn ? 'QC note' : '质检备注'}</label>
                                <input type="text" value={d.qcNote} onChange={e => updateDraft(l.id, 'qcNote', e.target.value)}
                                  placeholder={isEn ? 'e.g. lab report pending, supplier notified' : '例如：复检报告待补，已通知供应商'}
                                  className={`w-full ${inputCls}`} />
                              </div>
                            </div>
                            <p className="text-xs text-gray-500 mt-2">
                              {isEn
                                ? 'All three checks are optional. Rejected goods are returned to the supplier: not stocked in, and NOT counted as received — the PO stays open so purchasing knows to chase it.'
                                : '三项质检均可留空。拒收 = 当场退回供应商：不入库，也不计入已收数量 —— 采购单因此保持未收齐，采购员才知道要追这批货。'}
                            </p>
                            {rejectQty > 0 && !d.rejectReason && (
                              <p className="text-xs text-red-600 mt-1">{isEn ? 'Please select a reject reason' : '请选择拒收原因'}</p>
                            )}
                            {d.qcPesticide === 'FAIL' && rejectQty <= 0 && !d.qcNote && (
                              <p className="text-xs text-amber-600 mt-1">
                                {isEn ? 'Pesticide exceeded but nothing rejected — please state why it is accepted in the QC note.' : '农残超标但未拒收 —— 请在质检备注写明让步接收的理由。'}
                              </p>
                            )}
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
              <div className="px-4 py-3 bg-gray-50 text-sm text-gray-600 flex items-center gap-4">
                <span>
                  {isEn ? `Total this receipt: Good ${totalGood}` : `本次合计：良品 ${totalGood}`}
                  {totalBad > 0 && <span className="text-red-600">{isEn ? ` · Damaged ${totalBad}` : ` · 损坏 ${totalBad}`}</span>}
                  {totalRejected > 0 && <span className="text-red-700">{isEn ? ` · Rejected ${totalRejected}` : ` · 拒收 ${totalRejected}`}</span>}
                </span>
                {totalRejected > 0 && (
                  <span className="text-xs text-red-700">
                    {isEn
                      ? 'Rejected goods are returned to the supplier: not stocked in and not counted as received.'
                      : '拒收部分退回供应商：不入库，也不计入已收数量。'}
                  </span>
                )}
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
      ) : (
        <div className="space-y-2">
          {/* 未关联采购单的入库（台账 E6 验收第三条）。
              ⚠️ 不是去 GoodsReceipt 表里找——purchaseOrderId 是非空外键，那张表永远查不出未关联；
              会漏的是绕过收货单直接进库存的流水（手工调整/导入/盘盈）：货进来了却没有采购依据。 */}
          {unlinked && (
            <div className={`rounded-lg border p-3 ${unlinked.count > 0 ? 'border-amber-300 bg-amber-50/60' : 'border-gray-200 bg-white'}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-gray-800">
                  {isEn ? 'Inbound without a purchase order (last 30 days)' : '未关联采购单的入库（近 30 天）'}
                </span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${unlinked.count > 0 ? 'bg-amber-200 text-amber-900' : 'bg-emerald-50 text-emerald-600'}`}>
                  {unlinked.count > 0
                    ? (isEn ? `${unlinked.count} of ${unlinked.scanned} inbound moves · ${unlinked.qty} units` : `${unlinked.scanned} 笔入库中有 ${unlinked.count} 笔 · 共 ${unlinked.qty} 件`)
                    : (isEn ? `All ${unlinked.scanned} inbound moves are linked` : `${unlinked.scanned} 笔入库全部有据可查`)}
                </span>
              </div>
              {unlinked.count > 0 && (
                <table className="w-full text-xs mt-2">
                  <thead>
                    <tr className="text-gray-500 border-b border-amber-200">
                      <th className="text-left py-1">{isEn ? 'Product' : '商品'}</th>
                      <th className="text-right py-1">{isEn ? 'Qty' : '数量'}</th>
                      <th className="text-left py-1 pl-3">{isEn ? 'Source' : '来源'}</th>
                      <th className="text-left py-1 pl-3">{isEn ? 'Date' : '日期'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unlinked.items.slice(0, 10).map(m => (
                      <tr key={m.id} className="border-b border-amber-100/60">
                        <td className="py-1 text-gray-800">{m.productName}</td>
                        <td className="py-1 text-right text-gray-700">{Number(m.qty)}</td>
                        <td className="py-1 pl-3 text-gray-500" title={m.note ?? ''}>{m.sourceType ?? (isEn ? '(none)' : '（无）')}</td>
                        <td className="py-1 pl-3 text-gray-500">{formatDateOnly(m.movedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {unlinked.count > 10 && (
                <p className="text-[11px] text-amber-800 mt-1">
                  {isEn ? `Showing first 10 of ${unlinked.count}` : `共 ${unlinked.count} 笔，此处只列前 10 笔`}
                  {unlinked.truncated ? (isEn ? ' (server returned a capped list; the count is the true total)' : '（接口只回了前若干条，计数是全量真实值）') : ''}
                </p>
              )}
            </div>
          )}

          {history.length === 0 && (
            <div className="py-12 text-center text-gray-400 text-sm">{isEn ? 'No receipt records' : '暂无收货记录'}</div>
          )}
          {history.map(gr => {
            const supplierName = gr.purchaseOrder ? (supplierMap.get(gr.purchaseOrder.supplierId) ?? gr.purchaseOrder.supplierId) : '—'
            const goodLines = gr.lines.filter(l => (l.condition ?? 'ok') === 'ok')
            const badLines = gr.lines.filter(l => l.condition === 'damaged')
            const rejectedLines = gr.lines.filter(l => l.condition === 'rejected')
            const expanded = expandedGrId === gr.id
            return (
              <div key={gr.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <button
                  onClick={() => {
                    const next = expanded ? null : gr.id
                    setExpandedGrId(next)
                    if (next && (gr.photoCount ?? 0) > 0) loadPhotos(next)
                  }}
                  className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-gray-50">
                  <div>
                    <span className="font-semibold text-gray-800">{gr.name}</span>
                    <span className="text-sm text-gray-500 ml-2">{gr.purchaseOrder?.name ?? '—'} · {supplierName}</span>
                    {badLines.length > 0 && (
                      <span className="text-xs text-red-600 ml-2">{isEn ? `${badLines.length} item(s) damaged` : `${badLines.length} 项有损坏`}</span>
                    )}
                    {rejectedLines.length > 0 && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 ml-2">
                        {isEn ? `${rejectedLines.length} item(s) rejected` : `${rejectedLines.length} 项拒收`}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-400">
                    <span>{isEn ? `Arrived ${formatDateOnly(gr.arrivedAt)}` : `到货 ${formatDateOnly(gr.arrivedAt)}`}{gr.receivedBy ? ` · ${gr.receivedBy}` : ''}</span>
                    {(() => {
                      const d = arrivalDelay(gr.purchaseOrder?.expectedDate, gr.arrivedAt)
                      const text = isEn ? describeArrivalDelayEn(d) : describeArrivalDelay(d)
                      if (!text) return null
                      return (
                        <span className={`px-1.5 py-0.5 rounded ${
                          d.timing === 'LATE' ? 'bg-red-50 text-red-600'
                          : d.timing === 'EARLY' ? 'bg-blue-50 text-blue-600'
                          : 'bg-emerald-50 text-emerald-600'}`}
                          title={isEn ? `Expected ${formatDateOnly(gr.purchaseOrder?.expectedDate)}` : `预计到货 ${formatDateOnly(gr.purchaseOrder?.expectedDate)}`}
                        >{text}</span>
                      )
                    })()}
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
                          <th className="text-right py-1">{isEn ? 'Rejected Qty' : '拒收数量'}</th>
                          <th className="text-left py-1 pl-3">{isEn ? 'QC' : '质检'}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gr.lines.map((l, i) => {
                          const cond = l.condition ?? 'ok'
                          const qc = parseStoredQc(l.qc)
                          const verdict = lineVerdict(qc, cond === 'rejected' ? Number(l.qty) : 0)
                          return (
                            <tr key={`${l.productId}-${i}`} className="border-t border-gray-50">
                              <td className="py-1.5 text-gray-800">{l.productName}</td>
                              <td className="py-1.5 text-right text-gray-600">{cond === 'ok' ? Number(l.qty) : '—'}</td>
                              <td className="py-1.5 text-right">{cond === 'damaged' ? <span className="text-red-600">{Number(l.qty)}</span> : '—'}</td>
                              <td className="py-1.5 text-right">{cond === 'rejected' ? <span className="text-red-700 font-medium">{Number(l.qty)}</span> : '—'}</td>
                              <td className="py-1.5 pl-3 text-gray-500">
                                {verdict && (
                                  <span className={`text-[11px] px-1.5 py-0.5 rounded mr-1.5 ${verdict === 'FAIL' ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'}`}>
                                    {verdict === 'FAIL' ? (isEn ? 'Failed' : '不合格') : (isEn ? 'Passed' : '合格')}
                                  </span>
                                )}
                                {formatQcSummary(qc, isEn ? 'en' : 'zh')}
                                {cond === 'rejected' && l.rejectReason && (
                                  <span className="text-red-600">
                                    {formatQcSummary(qc) ? ' · ' : ''}
                                    {isEn ? QC_REJECT_REASON_LABELS[l.rejectReason].en : QC_REJECT_REASON_LABELS[l.rejectReason].zh}
                                  </span>
                                )}
                                {qc?.checkedBy && <span className="text-gray-400"> · {qc.checkedBy}</span>}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                      {(goodLines.length > 0 || badLines.length > 0 || rejectedLines.length > 0) && (
                        <tfoot>
                          <tr className="border-t border-gray-200 font-medium">
                            <td className="py-1.5 text-gray-600">{isEn ? 'Total' : '合计'}</td>
                            <td className="py-1.5 text-right text-gray-700">{goodLines.reduce((s, l) => s + Number(l.qty), 0)}</td>
                            <td className="py-1.5 text-right text-red-600">{badLines.reduce((s, l) => s + Number(l.qty), 0) || '—'}</td>
                            <td className="py-1.5 text-right text-red-700">{rejectedLines.reduce((s, l) => s + Number(l.qty), 0) || '—'}</td>
                            <td />
                          </tr>
                        </tfoot>
                      )}
                    </table>
                    {gr.notes && <div className="text-xs text-gray-500 mt-2">{isEn ? `Notes: ${gr.notes}` : `备注：${gr.notes}`}</div>}
                    {(gr.photoCount ?? gr.photos?.length ?? 0) > 0 && (
                      <div className="flex gap-1.5 mt-2 flex-wrap">
                        {(grPhotos[gr.id] ?? gr.photos ?? []).map((src, i) => (
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
