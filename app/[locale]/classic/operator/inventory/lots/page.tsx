'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { formatDateTime, formatDateOnly } from '@/lib/format-date'

const PURPLE = '#875A7B'
const BORDER = '#d4b8d0'

type Mode = 'LEDGER' | 'TRACE'

interface ProductOption {
  id: string
  name: string
  qtyOnHand?: number | string
  templateId?: string
  template?: { type: string }
}

interface LotRow {
  id: string
  lotNumber: string
  status: string
  initialQty: number | string
  currentQty: number | string
  arrivedAt: string
  bestBefore?: string | null
  sourceType: string
  sourceRef?: string | null
}

interface IntegrityInfo {
  productId: string
  qtyOnHand: number
  lotSumAvailable: number
  difference: number
}

interface TraceLot {
  id: string
  lotNumber: string
  status: string
  initialQty: number | string
  currentQty: number | string
  arrivedAt: string
  bestBefore?: string | null
  sourceType: string
  sourceRef?: string | null
  product: { id: string; name: string; spec?: string | null }
}

interface OrderSale {
  orderId: string | null
  orderCode: string | null
  restaurantName: string | null
  qty: number
  movedAt: string
}

interface OtherMove {
  type: string
  qty: number
  note?: string | null
  sourceType?: string | null
  sourceRef?: string | null
  movedAt: string
}

interface ProductReturn {
  type: 'RETURN'
  qty: number
  note?: string | null
  sourceRef?: string | null
  movedAt: string
  lotSpecific: false
}

interface TraceResult {
  lot: TraceLot
  orderSales: OrderSale[]
  otherMoves: OtherMove[]
  productReturns: ProductReturn[]
}

const MOVE_TYPE_LABEL_ZH: Record<string, string> = {
  IN: '入库',
  OUT: '出库',
  ADJUSTMENT: '调整',
  RETURN: '退货',
  SCRAP: '报废',
}

const MOVE_TYPE_LABEL_EN: Record<string, string> = {
  IN: 'Receipt',
  OUT: 'Issue',
  ADJUSTMENT: 'Adjustment',
  RETURN: 'Return',
  SCRAP: 'Scrap',
}

function expiryBadge(bestBefore: string | null | undefined, isEn: boolean): { label: string; color: string } | null {
  if (!bestBefore) return null
  const now = new Date()
  const d = new Date(bestBefore)
  if (isNaN(d.getTime())) return null
  const daysRemaining = Math.ceil((d.getTime() - now.getTime()) / 86400000)
  if (daysRemaining < 0) {
    return {
      label: isEn ? `Expired ${Math.abs(daysRemaining)}d ago` : `已过期 ${Math.abs(daysRemaining)} 天`,
      color: '#dc2626',
    }
  }
  if (daysRemaining <= 3) {
    return {
      label: isEn ? `${daysRemaining}d left` : `剩 ${daysRemaining} 天`,
      color: '#ea580c',
    }
  }
  return {
    label: isEn ? `${daysRemaining}d left` : `剩 ${daysRemaining} 天`,
    color: '#6b7280',
  }
}

export default function LotsPage() {
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const moveTypeLabel = isEn ? MOVE_TYPE_LABEL_EN : MOVE_TYPE_LABEL_ZH

  const [mode, setMode] = useState<Mode>('LEDGER')

  // ── Ledger mode state ──────────────────────────────────────────────
  const [products, setProducts] = useState<ProductOption[]>([])
  const [productsLoaded, setProductsLoaded] = useState(false)
  const [productSearch, setProductSearch] = useState('')
  const [selectedProductId, setSelectedProductId] = useState('')
  const [lots, setLots] = useState<LotRow[]>([])
  const [lotsLoading, setLotsLoading] = useState(false)
  const [integrity, setIntegrity] = useState<IntegrityInfo | null>(null)
  const [lotStatusFilter, setLotStatusFilter] = useState<'ALL' | 'AVAILABLE' | 'DEPLETED'>('ALL')

  // ── Trace mode state ───────────────────────────────────────────────
  const [lotNumberInput, setLotNumberInput] = useState('')
  const [traceLoading, setTraceLoading] = useState(false)
  const [traceResult, setTraceResult] = useState<TraceResult | null>(null)
  const [traceNotFound, setTraceNotFound] = useState(false)
  const [recentLots, setRecentLots] = useState<LotRow[]>([])

  const loadProducts = useCallback(async () => {
    try {
      const prods = await apiGet<ProductOption[]>('/api/products?status=ACTIVE')
      const physicalProducts = (Array.isArray(prods) ? prods : []).filter(
        p => p.template?.type === 'PRODUCT'
      )
      setProducts(physicalProducts)
    } catch {
      toast.error(isEn ? 'Failed to load product list' : '加载商品列表失败')
    } finally {
      setProductsLoaded(true)
    }
  }, [isEn])

  useEffect(() => { loadProducts() }, [loadProducts])

  // 追溯模式：默认拉一批最近入库的批次，供快速点选
  useEffect(() => {
    if (mode !== 'TRACE') return
    apiGet<LotRow[]>('/api/lots?status=ALL&limit=20')
      .then(data => setRecentLots(Array.isArray(data) ? data.slice().reverse() : []))
      .catch(() => setRecentLots([]))
  }, [mode])

  // 选择商品后加载批次 + 一致性核对
  useEffect(() => {
    if (!selectedProductId) {
      setLots([])
      setIntegrity(null)
      return
    }
    let cancelled = false
    setLotsLoading(true)
    Promise.all([
      apiGet<LotRow[]>(`/api/lots?productId=${selectedProductId}&status=ALL`),
      apiGet<IntegrityInfo>(`/api/lots/integrity?productId=${selectedProductId}`),
    ])
      .then(([lotData, integrityData]) => {
        if (cancelled) return
        setLots(Array.isArray(lotData) ? lotData : [])
        setIntegrity(integrityData ?? null)
      })
      .catch((e) => {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load lots' : '加载批次失败'))
          setLots([])
          setIntegrity(null)
        }
      })
      .finally(() => { if (!cancelled) setLotsLoading(false) })
    return () => { cancelled = true }
  }, [selectedProductId])

  const selectedProduct = products.find(p => p.id === selectedProductId)
  const filteredProducts = products.filter(p =>
    !productSearch || p.name.toLowerCase().includes(productSearch.toLowerCase())
  )
  const visibleLots = lots.filter(l => lotStatusFilter === 'ALL' || l.status === lotStatusFilter)

  async function runTrace(lotNumber: string) {
    const trimmed = lotNumber.trim()
    if (!trimmed) return
    setTraceLoading(true)
    setTraceNotFound(false)
    setTraceResult(null)
    try {
      const data = await apiGet<TraceResult>(`/api/lots/trace?lotNumber=${encodeURIComponent(trimmed)}`)
      setTraceResult(data)
    } catch (e) {
      if (e instanceof Error && /404|未找到/.test(e.message)) {
        setTraceNotFound(true)
      } else {
        toast.error(e instanceof Error ? e.message : (isEn ? 'Trace query failed' : '追溯查询失败'))
      }
    } finally {
      setTraceLoading(false)
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <button onClick={() => router.push(`${prefix}/classic/operator/inventory`)} className="hover:underline">
          {isEn ? 'Inventory' : '库存管理'}
        </button>
        <span>/</span>
        <span style={{ color: PURPLE }}>{isEn ? 'Product Lot Ledger' : '商品批次台账'}</span>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold" style={{ color: PURPLE }}>{isEn ? 'Product Lot Ledger' : '商品批次台账'}</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setMode('LEDGER')}
            className="px-4 py-2 rounded text-sm font-medium border"
            style={mode === 'LEDGER'
              ? { background: PURPLE, color: '#fff', borderColor: PURPLE }
              : { background: '#fff', color: PURPLE, borderColor: BORDER }}
          >
            {isEn ? 'Browse by Product' : '按商品浏览'}
          </button>
          <button
            onClick={() => setMode('TRACE')}
            className="px-4 py-2 rounded text-sm font-medium border"
            style={mode === 'TRACE'
              ? { background: PURPLE, color: '#fff', borderColor: PURPLE }
              : { background: '#fff', color: PURPLE, borderColor: BORDER }}
          >
            {isEn ? 'Trace by Lot Number' : '按批号追溯'}
          </button>
        </div>
      </div>

      {/* ══════════════════════ LEDGER MODE ══════════════════════ */}
      {mode === 'LEDGER' && (
        <div className="space-y-4">
          {/* Product picker */}
          <div className="bg-white rounded-lg border p-4" style={{ borderColor: BORDER }}>
            <label className="text-xs font-medium text-gray-600 mb-1 block">{isEn ? 'Select Product' : '选择商品'}</label>
            <input
              type="text"
              value={productSearch}
              onChange={e => { setProductSearch(e.target.value); setSelectedProductId('') }}
              placeholder={isEn ? 'Search products...' : '搜索商品...'}
              className="w-full border rounded px-3 py-2 text-sm outline-none"
              style={{ borderColor: BORDER }}
              disabled={!productsLoaded}
            />
            {productSearch && !selectedProductId && (
              <div className="border rounded mt-1 max-h-52 overflow-y-auto" style={{ borderColor: BORDER }}>
                {filteredProducts.length === 0 && (
                  <div className="px-3 py-2 text-xs text-gray-400">{isEn ? 'No matching products' : '无匹配商品'}</div>
                )}
                {filteredProducts.slice(0, 30).map(p => (
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
              <p className="text-xs text-gray-400 mt-1">
                {isEn ? 'Current stock (qtyOnHand)' : '当前商品库存 (qtyOnHand)'}: {Number(selectedProduct.qtyOnHand ?? 0).toFixed(2)}
              </p>
            )}
          </div>

          {selectedProductId && (
            <>
              {/* Integrity banner — informational, not alarming */}
              {integrity && (
                <div
                  className="rounded-lg border px-4 py-3 text-xs"
                  style={{
                    borderColor: Math.abs(integrity.difference) < 0.001 ? '#c7e8d0' : '#e6d9a8',
                    background: Math.abs(integrity.difference) < 0.001 ? '#f2fbf5' : '#fdf9ee',
                    color: '#555',
                  }}
                >
                  <span className="font-medium" style={{ color: PURPLE }}>
                    {isEn ? 'Consistency check (informational):' : '一致性核对（信息性）：'}
                  </span>{' '}
                  {isEn ? 'Stock qtyOnHand' : '商品库存 qtyOnHand'} = <b>{integrity.qtyOnHand.toFixed(2)}</b>
                  {isEn ? ', ' : '，'}
                  {isEn ? 'lot ledger available total' : '批次台账可用余量合计'} = <b>{integrity.lotSumAvailable.toFixed(2)}</b>
                  {Math.abs(integrity.difference) < 0.001 ? (
                    <span className="ml-2 text-green-600">{isEn ? '✓ Consistent' : '✓ 一致'}</span>
                  ) : (
                    <span className="ml-2">
                      {isEn
                        ? `Difference ${integrity.difference.toFixed(2)} (there is a known historical gap in lot tracking — some early receipts/issues did not generate lot records; this discrepancy is a known condition, not a data error, for reference only)`
                        : `差额 ${integrity.difference.toFixed(2)}（Lot 批次追踪存在已知历史缺口——部分早期入库/出库未生成批次记录，两者不一致属已知情况，非数据错误，仅供参考）`}
                    </span>
                  )}
                </div>
              )}

              {/* Lot status filter */}
              <div className="flex items-center gap-2">
                {(['ALL', 'AVAILABLE', 'DEPLETED'] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setLotStatusFilter(s)}
                    className="px-3 py-1 rounded text-xs font-medium border"
                    style={lotStatusFilter === s
                      ? { background: PURPLE, color: '#fff', borderColor: PURPLE }
                      : { background: '#fff', color: '#666', borderColor: BORDER }}
                  >
                    {s === 'ALL' ? (isEn ? 'All' : '全部') : s === 'AVAILABLE' ? (isEn ? 'Available' : '可用') : (isEn ? 'Depleted' : '已耗尽')}
                  </button>
                ))}
              </div>

              {/* Lots table */}
              <div className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: BORDER }}>
                <div
                  className="grid gap-3 px-4 py-2.5 text-xs font-semibold border-b"
                  style={{ borderColor: BORDER, color: PURPLE, background: '#faf5fb', gridTemplateColumns: '140px 80px 110px 90px 90px 120px 1fr' }}
                >
                  <span>{isEn ? 'Lot #' : '批号'}</span>
                  <span>{isEn ? 'Status' : '状态'}</span>
                  <span>{isEn ? 'Received' : '入库日期'}</span>
                  <span className="text-right">{isEn ? 'Initial Qty' : '初始量'}</span>
                  <span className="text-right">{isEn ? 'Remaining Qty' : '剩余量'}</span>
                  <span>{isEn ? 'Expiry' : '保质期'}</span>
                  <span>{isEn ? 'Source Doc' : '来源单据'}</span>
                </div>

                {lotsLoading && <div className="py-12 text-center text-sm text-gray-400">{isEn ? 'Loading...' : '加载中...'}</div>}

                {!lotsLoading && visibleLots.length === 0 && (
                  <div className="py-12 text-center text-sm text-gray-400">{isEn ? 'No lot records for this product' : '该商品暂无批次记录'}</div>
                )}

                {!lotsLoading && visibleLots.map(lot => {
                  const badge = expiryBadge(lot.bestBefore, isEn)
                  return (
                    <div
                      key={lot.id}
                      className="grid gap-3 px-4 py-3 border-b last:border-b-0 items-center"
                      style={{ borderColor: '#f0e4ee', gridTemplateColumns: '140px 80px 110px 90px 90px 120px 1fr' }}
                    >
                      <button
                        type="button"
                        onClick={() => { setMode('TRACE'); setLotNumberInput(lot.lotNumber); runTrace(lot.lotNumber) }}
                        className="text-xs font-mono text-left hover:underline"
                        style={{ color: PURPLE }}
                        title={isEn ? 'Click to trace this lot' : '点击追溯该批次'}
                      >
                        {lot.lotNumber}
                      </button>
                      <span
                        className="text-xs font-medium px-2 py-0.5 rounded-full w-fit"
                        style={lot.status === 'AVAILABLE'
                          ? { background: '#e7f6ec', color: '#16a34a' }
                          : { background: '#f1f1f1', color: '#888' }}
                      >
                        {lot.status === 'AVAILABLE' ? (isEn ? 'Available' : '可用') : (isEn ? 'Depleted' : '已耗尽')}
                      </span>
                      <span className="text-xs text-gray-600">{formatDateOnly(lot.arrivedAt)}</span>
                      <span className="text-sm font-mono text-right text-gray-600">{Number(lot.initialQty).toFixed(2)}</span>
                      <span className="text-sm font-mono text-right font-semibold" style={{ color: PURPLE }}>
                        {Number(lot.currentQty).toFixed(2)}
                      </span>
                      <span className="text-xs">
                        {badge ? <span style={{ color: badge.color, fontWeight: 500 }}>{badge.label}</span> : <span className="text-gray-300">—</span>}
                      </span>
                      <span className="text-xs text-gray-500 truncate">
                        {lot.sourceRef ?? lot.sourceType ?? '—'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {!selectedProductId && (
            <div className="bg-white rounded-lg border py-16 text-center text-sm text-gray-400" style={{ borderColor: BORDER }}>
              {isEn ? 'Search and select a product first to view its lot ledger' : '请先搜索并选择一个商品，查看其批次台账'}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════ TRACE MODE ══════════════════════ */}
      {mode === 'TRACE' && (
        <div className="space-y-4">
          <div className="bg-white rounded-lg border p-4" style={{ borderColor: BORDER }}>
            <label className="text-xs font-medium text-gray-600 mb-1 block">{isEn ? 'Trace by Lot Number' : '批号追溯'}</label>
            <form
              onSubmit={e => { e.preventDefault(); runTrace(lotNumberInput) }}
              className="flex gap-2"
            >
              <input
                type="text"
                value={lotNumberInput}
                onChange={e => setLotNumberInput(e.target.value)}
                placeholder={isEn ? 'Enter lot number, e.g. LOT-00918' : '输入批号，如 LOT-00918'}
                className="flex-1 border rounded px-3 py-2 text-sm outline-none font-mono"
                style={{ borderColor: BORDER }}
              />
              <button
                type="submit"
                disabled={!lotNumberInput.trim() || traceLoading}
                className="px-4 py-2 rounded text-sm font-medium text-white disabled:opacity-50"
                style={{ background: PURPLE }}
              >
                {traceLoading ? (isEn ? 'Searching...' : '查询中...') : (isEn ? 'Trace' : '追溯')}
              </button>
            </form>

            {recentLots.length > 0 && !traceResult && (
              <div className="mt-3">
                <p className="text-xs text-gray-400 mb-1.5">{isEn ? 'Or pick from recent lots:' : '或从最近批次中选择：'}</p>
                <div className="flex flex-wrap gap-1.5">
                  {recentLots.map(l => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => { setLotNumberInput(l.lotNumber); runTrace(l.lotNumber) }}
                      className="px-2 py-1 rounded text-xs font-mono border hover:bg-purple-50"
                      style={{ borderColor: BORDER, color: PURPLE }}
                    >
                      {l.lotNumber}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {traceNotFound && (
            <div className="bg-white rounded-lg border py-16 text-center text-sm text-gray-400" style={{ borderColor: BORDER }}>
              {isEn
                ? `Lot number "${lotNumberInput}" not found — please check the lot number`
                : `未找到批号「${lotNumberInput}」，请检查批号是否正确`}
            </div>
          )}

          {traceResult && (
            <div className="space-y-4">
              {/* Lot summary card */}
              <div className="bg-white rounded-lg border p-4" style={{ borderColor: BORDER }}>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <span className="text-sm font-mono font-semibold" style={{ color: PURPLE }}>
                      {traceResult.lot.lotNumber}
                    </span>
                    <span className="ml-2 text-sm text-gray-700">{traceResult.lot.product.name}</span>
                    {traceResult.lot.product.spec && (
                      <span className="ml-1 text-xs text-gray-400">({traceResult.lot.product.spec})</span>
                    )}
                  </div>
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded-full"
                    style={traceResult.lot.status === 'AVAILABLE'
                      ? { background: '#e7f6ec', color: '#16a34a' }
                      : { background: '#f1f1f1', color: '#888' }}
                  >
                    {traceResult.lot.status === 'AVAILABLE' ? (isEn ? 'Available' : '可用') : (isEn ? 'Depleted' : '已耗尽')}
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-4 text-xs">
                  <div>
                    <p className="text-gray-400">{isEn ? 'Received' : '入库日期'}</p>
                    <p className="text-gray-700 mt-0.5">{formatDateOnly(traceResult.lot.arrivedAt)}</p>
                  </div>
                  <div>
                    <p className="text-gray-400">{isEn ? 'Initial Qty / Remaining Qty' : '初始量 / 剩余量'}</p>
                    <p className="text-gray-700 mt-0.5">
                      {Number(traceResult.lot.initialQty).toFixed(2)} / {Number(traceResult.lot.currentQty).toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-400">{isEn ? 'Expiry' : '保质期'}</p>
                    <p className="text-gray-700 mt-0.5">{traceResult.lot.bestBefore ? formatDateOnly(traceResult.lot.bestBefore) : '—'}</p>
                  </div>
                  <div>
                    <p className="text-gray-400">{isEn ? 'Source Doc' : '来源单据'}</p>
                    <p className="text-gray-700 mt-0.5">{traceResult.lot.sourceRef ?? traceResult.lot.sourceType ?? '—'}</p>
                  </div>
                </div>
              </div>

              {/* Order sales table */}
              <div className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: BORDER }}>
                <div className="px-4 py-2.5 text-sm font-semibold border-b" style={{ borderColor: BORDER, color: PURPLE, background: '#faf5fb' }}>
                  {isEn ? 'Sold to (order issues)' : '卖给了谁（订单出库）'}
                </div>
                <div
                  className="grid gap-3 px-4 py-2 text-xs font-semibold border-b text-gray-500"
                  style={{ borderColor: '#f0e4ee', gridTemplateColumns: '1fr 140px 90px 140px' }}
                >
                  <span>{isEn ? 'Customer' : '客户'}</span>
                  <span>{isEn ? 'Order #' : '订单号'}</span>
                  <span className="text-right">{isEn ? 'Qty' : '数量'}</span>
                  <span>{isEn ? 'Issued At' : '出库时间'}</span>
                </div>
                {traceResult.orderSales.length === 0 && (
                  <div className="py-8 text-center text-sm text-gray-400">
                    {isEn
                      ? 'No order sales records (this lot has not yet been issued via an order, or lot-level issue data is limited in this environment — this is a known condition)'
                      : '暂无订单销售记录（该批次尚未通过订单出库，或本环境批次出库数据较少，属已知情况）'}
                  </div>
                )}
                {traceResult.orderSales.map((s, i) => (
                  <div
                    key={i}
                    className="grid gap-3 px-4 py-2.5 border-b last:border-b-0 items-center"
                    style={{ borderColor: '#f0e4ee', gridTemplateColumns: '1fr 140px 90px 140px' }}
                  >
                    <span className="text-sm text-gray-800">{s.restaurantName ?? '—'}</span>
                    <span className="text-xs font-mono text-gray-500">{s.orderCode ?? s.orderId ?? '—'}</span>
                    <span className="text-sm font-mono text-right font-semibold" style={{ color: PURPLE }}>
                      {s.qty.toFixed(2)}
                    </span>
                    <span className="text-xs text-gray-400">{formatDateTime(s.movedAt)}</span>
                  </div>
                ))}
              </div>

              {/* Other moves table */}
              <div className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: BORDER }}>
                <div className="px-4 py-2.5 text-sm font-semibold border-b" style={{ borderColor: BORDER, color: PURPLE, background: '#faf5fb' }}>
                  {isEn ? 'Other movements (scrap/adjustments etc., lot-level)' : '其他流水（报废/调整等，批次级）'}
                </div>
                <div
                  className="grid gap-3 px-4 py-2 text-xs font-semibold border-b text-gray-500"
                  style={{ borderColor: '#f0e4ee', gridTemplateColumns: '90px 90px 1fr 120px 140px' }}
                >
                  <span>{isEn ? 'Type' : '类型'}</span>
                  <span className="text-right">{isEn ? 'Qty' : '数量'}</span>
                  <span>{isEn ? 'Note/Source' : '备注/来源'}</span>
                  <span>{isEn ? 'Doc #' : '单据号'}</span>
                  <span>{isEn ? 'Time' : '时间'}</span>
                </div>
                {traceResult.otherMoves.length === 0 && (
                  <div className="py-8 text-center text-sm text-gray-400">{isEn ? 'No other lot-level movements' : '暂无其他批次级流水'}</div>
                )}
                {traceResult.otherMoves.map((m, i) => (
                  <div
                    key={i}
                    className="grid gap-3 px-4 py-2.5 border-b last:border-b-0 items-center"
                    style={{ borderColor: '#f0e4ee', gridTemplateColumns: '90px 90px 1fr 120px 140px' }}
                  >
                    <span className="text-xs font-medium text-gray-700">{moveTypeLabel[m.type] ?? m.type}</span>
                    <span className="text-sm font-mono text-right text-gray-600">{m.qty.toFixed(2)}</span>
                    <span className="text-xs text-gray-500 truncate">{m.note ?? '—'}</span>
                    <span className="text-xs font-mono text-gray-400">{m.sourceRef ?? '—'}</span>
                    <span className="text-xs text-gray-400">{formatDateTime(m.movedAt)}</span>
                  </div>
                ))}
              </div>

              {/* Product-level returns — supplementary, not lot-specific */}
              {traceResult.productReturns.length > 0 && (
                <div className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: BORDER }}>
                  <div className="px-4 py-2.5 text-sm font-semibold border-b" style={{ borderColor: BORDER, color: '#888', background: '#fafafa' }}>
                    {isEn
                      ? "This product's return records (for reference, not precise lot-level tracing — RETURN movements do not yet reliably carry a lot number)"
                      : '该商品的退货记录（供参考，非批次级精确追溯——RETURN 流水暂不可靠携带批号）'}
                  </div>
                  <div
                    className="grid gap-3 px-4 py-2 text-xs font-semibold border-b text-gray-500"
                    style={{ borderColor: '#f0e4ee', gridTemplateColumns: '90px 1fr 120px 140px' }}
                  >
                    <span className="text-right">{isEn ? 'Qty' : '数量'}</span>
                    <span>{isEn ? 'Note' : '备注'}</span>
                    <span>{isEn ? 'Doc #' : '单据号'}</span>
                    <span>{isEn ? 'Time' : '时间'}</span>
                  </div>
                  {traceResult.productReturns.map((r, i) => (
                    <div
                      key={i}
                      className="grid gap-3 px-4 py-2.5 border-b last:border-b-0 items-center"
                      style={{ borderColor: '#f0e4ee', gridTemplateColumns: '90px 1fr 120px 140px' }}
                    >
                      <span className="text-sm font-mono text-right text-gray-500">{r.qty.toFixed(2)}</span>
                      <span className="text-xs text-gray-500 truncate">{r.note ?? '—'}</span>
                      <span className="text-xs font-mono text-gray-400">{r.sourceRef ?? '—'}</span>
                      <span className="text-xs text-gray-400">{formatDateTime(r.movedAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!traceResult && !traceNotFound && (
            <div className="bg-white rounded-lg border py-16 text-center text-sm text-gray-400" style={{ borderColor: BORDER }}>
              {isEn ? 'Enter a lot number or pick from recent lots to view its full movement history' : '输入批号或从最近批次中选择，查看该批次的完整流转记录'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
