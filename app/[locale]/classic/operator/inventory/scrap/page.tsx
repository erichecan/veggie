'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { formatDateTime, formatDateOnly } from '@/lib/format-date'
import { SCRAP_REASON_LABEL, SCRAP_REASON_LABEL_EN } from '@/lib/scrap-reasons'

const PURPLE = '#875A7B'
const BORDER = '#d4b8d0'

interface ScrapRecord {
  id: string
  productId: string
  productName: string
  qty: number | string
  note?: string | null
  sourceRef?: string | null
  lotId?: string | null
  lot?: { lotNumber: string; arrivedAt: string; sourceRef?: string | null } | null
  movedAt?: string
  createdAt: string
}

interface ProductOption {
  id: string
  name: string
  qtyOnHand?: number | string
  templateId?: string
  template?: { type: string }
}

interface LotOption {
  id: string
  lotNumber: string
  currentQty: number | string
  arrivedAt: string
  sourceRef?: string | null
  bestBefore?: string | null
}

const SCRAP_REASON_KEYS = [
  'CUSTOMER_RETURN_EXPIRED',
  'CUSTOMER_RETURN_DAMAGED',
  'WAREHOUSE_EXPIRY',
  'WAREHOUSE_DAMAGE',
  'OTHER',
] as const

export default function ScrapPage() {
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [records, setRecords] = useState<ScrapRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [showDialog, setShowDialog] = useState(false)
  const [products, setProducts] = useState<ProductOption[]>([])
  const [submitting, setSubmitting] = useState(false)

  // Form state
  const [selectedProductId, setSelectedProductId] = useState('')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('WAREHOUSE_EXPIRY')
  const [notes, setNotes] = useState('')
  const [productSearch, setProductSearch] = useState('')

  // Lot state
  const [lots, setLots] = useState<LotOption[]>([])
  const [selectedLotId, setSelectedLotId] = useState('')
  const [lotsLoading, setLotsLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<ScrapRecord[]>('/api/scrap?limit=200')
      setRecords(Array.isArray(data) ? data : [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // 选择商品后，加载该商品的可用批次
  useEffect(() => {
    if (!selectedProductId) {
      setLots([])
      setSelectedLotId('')
      return
    }
    let cancelled = false
    setLotsLoading(true)
    apiGet<LotOption[]>(`/api/lots?productId=${selectedProductId}&status=AVAILABLE`)
      .then(data => {
        if (cancelled) return
        setLots(Array.isArray(data) ? data : [])
        setSelectedLotId('')
      })
      .catch(() => {
        if (!cancelled) setLots([])
      })
      .finally(() => { if (!cancelled) setLotsLoading(false) })
    return () => { cancelled = true }
  }, [selectedProductId])

  async function openDialog() {
    setShowDialog(true)
    setSelectedProductId('')
    setQty('')
    setReason('WAREHOUSE_EXPIRY')
    setNotes('')
    setProductSearch('')
    setSelectedLotId('')
    setLots([])
    try {
      const prods = await apiGet<ProductOption[]>('/api/products?status=ACTIVE')
      const physicalProducts = (Array.isArray(prods) ? prods : []).filter(
        p => p.template?.type === 'PRODUCT'
      )
      setProducts(physicalProducts)
    } catch {
      toast.error(isEn ? 'Failed to load product list' : '加载商品列表失败')
    }
  }

  const selectedProduct = products.find(p => p.id === selectedProductId)
  const selectedLot = lots.find(l => l.id === selectedLotId)
  const filteredProducts = products.filter(p =>
    !productSearch || p.name.toLowerCase().includes(productSearch.toLowerCase())
  )

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedProductId || !qty) return
    setSubmitting(true)
    try {
      await apiPost('/api/scrap', {
        productId: selectedProductId,
        productName: selectedProduct?.name ?? '',
        qty: Number(qty),
        reason,
        notes,
        lotId: selectedLotId || undefined,
      })
      toast.success(isEn ? 'Scrap record created' : '报废记录已创建')
      setShowDialog(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Creation failed' : '创建失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <button onClick={() => router.push(`${prefix}/classic/operator/inventory`)} className="hover:underline">
          {isEn ? 'Inventory' : '库存管理'}
        </button>
        <span>/</span>
        <span style={{ color: PURPLE }}>{isEn ? 'Scrap Management' : '报废管理'}</span>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold" style={{ color: PURPLE }}>{isEn ? 'Scrap Management' : '报废管理'}</h1>
        <button
          onClick={openDialog}
          className="px-4 py-2 rounded text-sm font-medium text-white"
          style={{ background: PURPLE }}
        >
          {isEn ? '+ New Scrap' : '+ 新建报废'}
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: BORDER }}>
        <div
          className="grid gap-3 px-4 py-2.5 text-xs font-semibold border-b"
          style={{ borderColor: BORDER, color: PURPLE, background: '#faf5fb', gridTemplateColumns: '1fr 100px 100px 100px 1fr 90px' }}
        >
          <span>{isEn ? 'Product' : '商品名称'}</span>
          <span>{isEn ? 'Scrap No.' : '报废编号'}</span>
          <span>{isEn ? 'Lot' : '关联批次'}</span>
          <span className="text-right">{isEn ? 'Qty' : '数量'}</span>
          <span>{isEn ? 'Note / Reason' : '备注/原因'}</span>
          <span>{isEn ? 'Time' : '时间'}</span>
        </div>

        {loading && <div className="py-12 text-center text-sm text-gray-400">{isEn ? 'Loading...' : '加载中...'}</div>}

        {!loading && records.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-400">{isEn ? 'No scrap records' : '暂无报废记录'}</div>
        )}

        {!loading && records.map((r) => (
          <div
            key={r.id}
            className="grid gap-3 px-4 py-3 border-b last:border-b-0 items-center"
            style={{ borderColor: '#f0e4ee', gridTemplateColumns: '1fr 100px 100px 100px 1fr 90px' }}
          >
            <span className="text-sm font-medium text-gray-800">{r.productName}</span>
            <span className="text-xs font-mono text-gray-500">{r.sourceRef ?? '—'}</span>
            <span className="text-xs font-mono text-purple-600">
              {r.lot?.lotNumber ?? '—'}
            </span>
            <span className="text-sm font-mono text-right font-semibold text-red-500">
              {Math.abs(Number(r.qty)).toFixed(2)}
            </span>
            <span className="text-xs text-gray-500 truncate">{r.note ?? '—'}</span>
            <span className="text-xs text-gray-400">{formatDateTime(r.movedAt ?? r.createdAt)}</span>
          </div>
        ))}
      </div>

      {/* Create Dialog */}
      {showDialog && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center" onClick={() => setShowDialog(false)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-semibold mb-4" style={{ color: PURPLE }}>{isEn ? 'New Scrap' : '新建报废'}</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Product selector */}
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">{isEn ? 'Select Product' : '选择商品'}</label>
                <input
                  type="text"
                  value={productSearch}
                  onChange={e => { setProductSearch(e.target.value); setSelectedProductId('') }}
                  placeholder={isEn ? 'Search product...' : '搜索商品...'}
                  className="w-full border rounded px-3 py-2 text-sm outline-none"
                  style={{ borderColor: BORDER }}
                />
                {productSearch && !selectedProductId && (
                  <div className="border rounded mt-1 max-h-40 overflow-y-auto" style={{ borderColor: BORDER }}>
                    {filteredProducts.length === 0 && (
                      <div className="px-3 py-2 text-xs text-gray-400">{isEn ? 'No matching products' : '无匹配商品'}</div>
                    )}
                    {filteredProducts.slice(0, 20).map(p => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => { setSelectedProductId(p.id); setProductSearch(p.name) }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-purple-50 flex justify-between"
                      >
                        <span>{p.name}</span>
                        <span className="text-xs text-gray-400">{isEn ? 'Stock' : '库存'}: {Number(p.qtyOnHand ?? 0).toFixed(1)}</span>
                      </button>
                    ))}
                  </div>
                )}
                {selectedProduct && (
                  <p className="text-xs text-gray-400 mt-1">{isEn ? 'Current stock' : '当前库存'}: {Number(selectedProduct.qtyOnHand ?? 0).toFixed(1)}</p>
                )}
              </div>

              {/* Lot selector */}
              {selectedProductId && (
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">
                    {isEn ? 'Lot' : '关联批次'}
                    <span className="text-gray-400 font-normal ml-1">{isEn ? '(optional, select the receiving lot to scrap)' : '（可选，选择要报废的入库批次）'}</span>
                  </label>
                  {lotsLoading && <p className="text-xs text-gray-400">{isEn ? 'Loading lots...' : '加载批次中...'}</p>}
                  {!lotsLoading && lots.length === 0 && (
                    <p className="text-xs text-gray-400">{isEn ? 'No available lot records for this product (historical receipts did not generate lots)' : '该商品暂无可用批次记录（历史入库未生成批次）'}</p>
                  )}
                  {!lotsLoading && lots.length > 0 && (
                    <div className="border rounded max-h-36 overflow-y-auto" style={{ borderColor: BORDER }}>
                      {/* 不选批次选项 */}
                      <button
                        type="button"
                        onClick={() => setSelectedLotId('')}
                        className={`w-full text-left px-3 py-2 text-sm flex justify-between items-center border-b ${!selectedLotId ? 'bg-purple-50' : 'hover:bg-gray-50'}`}
                        style={{ borderColor: '#f0e4ee' }}
                      >
                        <span className="text-gray-400">{isEn ? 'No specific lot' : '不指定批次'}</span>
                      </button>
                      {lots.map(lot => (
                        <button
                          key={lot.id}
                          type="button"
                          onClick={() => setSelectedLotId(lot.id)}
                          className={`w-full text-left px-3 py-2 text-sm flex justify-between items-center border-b last:border-b-0 ${selectedLotId === lot.id ? 'bg-purple-50' : 'hover:bg-gray-50'}`}
                          style={{ borderColor: '#f0e4ee' }}
                        >
                          <div>
                            <span className="font-mono text-purple-700 font-medium">{lot.lotNumber}</span>
                            <span className="text-gray-400 ml-2 text-xs">
                              {isEn ? 'Received' : '入库'} {formatDateOnly(lot.arrivedAt)}
                              {lot.sourceRef ? ` / ${lot.sourceRef}` : ''}
                            </span>
                            {lot.bestBefore && (
                              <span className="text-orange-500 ml-2 text-xs">
                                {isEn ? 'Best before' : '保质期'} {formatDateOnly(lot.bestBefore)}
                              </span>
                            )}
                          </div>
                          <span className="text-xs font-mono text-gray-600">
                            {isEn ? 'Remaining' : '余'} {Number(lot.currentQty).toFixed(1)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {selectedLot && (
                    <p className="text-xs mt-1" style={{ color: PURPLE }}>
                      {isEn
                        ? `Selected: ${selectedLot.lotNumber} (remaining ${Number(selectedLot.currentQty).toFixed(1)})`
                        : `已选: ${selectedLot.lotNumber}（余量 ${Number(selectedLot.currentQty).toFixed(1)}）`}
                    </p>
                  )}
                </div>
              )}

              {/* Qty */}
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">{isEn ? 'Scrap Qty' : '报废数量'}</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={selectedLot ? Number(selectedLot.currentQty) : undefined}
                  value={qty}
                  onChange={e => setQty(e.target.value)}
                  placeholder={selectedLot ? (isEn ? `Max ${Number(selectedLot.currentQty).toFixed(1)}` : `最多 ${Number(selectedLot.currentQty).toFixed(1)}`) : (isEn ? 'Enter quantity' : '输入数量')}
                  className="w-full border rounded px-3 py-2 text-sm outline-none"
                  style={{ borderColor: BORDER }}
                  required
                />
              </div>

              {/* Reason */}
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">{isEn ? 'Scrap Reason' : '报废原因'}</label>
                <select
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  className="w-full border rounded px-3 py-2 text-sm outline-none"
                  style={{ borderColor: BORDER }}
                >
                  {SCRAP_REASON_KEYS.map(key => (
                    <option key={key} value={key}>{isEn ? SCRAP_REASON_LABEL_EN[key] : SCRAP_REASON_LABEL[key]}</option>
                  ))}
                </select>
              </div>

              {/* Notes */}
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">{isEn ? 'Notes' : '备注'}</label>
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder={isEn ? 'Additional notes (optional)' : '补充说明（可选）'}
                  rows={2}
                  className="w-full border rounded px-3 py-2 text-sm outline-none resize-none"
                  style={{ borderColor: BORDER }}
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowDialog(false)}
                  className="px-4 py-2 rounded text-sm text-gray-600 border"
                  style={{ borderColor: BORDER }}
                >
                  {isEn ? 'Cancel' : '取消'}
                </button>
                <button
                  type="submit"
                  disabled={!selectedProductId || !qty || submitting}
                  className="px-4 py-2 rounded text-sm font-medium text-white disabled:opacity-50"
                  style={{ background: PURPLE }}
                >
                  {submitting ? (isEn ? 'Submitting...' : '提交中...') : (isEn ? 'Confirm Scrap' : '确认报废')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
