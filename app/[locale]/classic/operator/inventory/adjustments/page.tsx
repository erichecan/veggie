'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { rankByRelevance } from '@/lib/search-rank'
import { formatDateTime, formatDateOnly } from '@/lib/format-date'

const PURPLE = '#875A7B'
const BORDER = '#d4b8d0'

interface StockMove {
  id: string
  productId: string
  productName: string
  type: 'IN' | 'OUT' | 'ADJUSTMENT' | 'RETURN' | 'SCRAP'
  qty: string | number
  note?: string | null
  sourceType?: string | null
  sourceId?: string | null
  sourceRef?: string | null
  lotId?: string | null
  lot?: { lotNumber: string; bestBefore?: string | null } | null
  createdAt: string
}

const TYPE_LABEL_ZH: Record<string, string> = {
  IN: '入库',
  OUT: '出库',
  ADJUSTMENT: '库存调整',
  RETURN: '退货',
  SCRAP: '报废',
}

const TYPE_LABEL_EN: Record<string, string> = {
  IN: 'Stock In',
  OUT: 'Stock Out',
  ADJUSTMENT: 'Adjustment',
  RETURN: 'Return',
  SCRAP: 'Scrap',
}

const TYPE_COLOR: Record<string, string> = {
  IN: 'bg-green-50 text-green-700',
  OUT: 'bg-orange-50 text-orange-700',
  ADJUSTMENT: 'bg-blue-50 text-blue-700',
  RETURN: 'bg-purple-50 text-purple-700',
  SCRAP: 'bg-red-50 text-red-700',
}

const SOURCE_HREF: Record<string, string> = {
  PURCHASE_ORDER: '/classic/operator/purchases',
  ORDER: '/classic/operator/orders',
  GOODS_RECEIPT: '/classic/operator/inventory/receipts',
  SCRAP: '/classic/operator/inventory/scrap',
}

const TYPE_TABS = [
  { key: 'all', labelZh: '全部', labelEn: 'All' },
  { key: 'IN', labelZh: '入库', labelEn: 'Stock In' },
  { key: 'OUT', labelZh: '出库', labelEn: 'Stock Out' },
  { key: 'ADJUSTMENT', labelZh: '库存调整', labelEn: 'Adjustment' },
  { key: 'RETURN', labelZh: '退货', labelEn: 'Return' },
  { key: 'SCRAP', labelZh: '报废', labelEn: 'Scrap' },
]

const PAGE_SIZE = 100

export default function InventoryAdjustmentsPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale
  const TYPE_LABEL = isEn ? TYPE_LABEL_EN : TYPE_LABEL_ZH
  const [moves, setMoves] = useState<StockMove[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('all')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')

  // 手动库存调整
  type ProductLite = { id: string; name: string; qtyOnHand?: number; uomName?: string }
  const [showAdjust, setShowAdjust] = useState(false)
  const [products, setProducts] = useState<ProductLite[]>([])
  const [prodSearch, setProdSearch] = useState('')
  const [selProduct, setSelProduct] = useState<ProductLite | null>(null)
  const [direction, setDirection] = useState<'in' | 'out'>('in')
  const [adjQty, setAdjQty] = useState('')
  const [adjNote, setAdjNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [prodHighlight, setProdHighlight] = useState(0)
  const adjInputRef = useRef<HTMLInputElement>(null)
  const adjListRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<StockMove[]>(`/api/stock-moves?limit=${PAGE_SIZE}`)
      setMoves(Array.isArray(data) ? data : [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [isEn])

  useEffect(() => { load() }, [load])

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setSearch(searchInput)
  }

  function resetAdjust() {
    setProdSearch(''); setSelProduct(null); setDirection('in'); setAdjQty(''); setAdjNote(''); setProdHighlight(0)
  }

  function selectAdjProduct(p: ProductLite) {
    setSelProduct(p); setProdSearch(''); setProdHighlight(0)
  }

  function handleAdjKey(e: React.KeyboardEvent) {
    const items = prodMatches
    if (e.key === 'ArrowDown') { e.preventDefault(); setProdHighlight(i => Math.min(i + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setProdHighlight(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[prodHighlight]) selectAdjProduct(items[prodHighlight]) }
    else if (e.key === 'Escape') { e.preventDefault(); setProdSearch(''); setProdHighlight(0) }
  }

  async function openAdjust() {
    setShowAdjust(true)
    if (products.length === 0) {
      try {
        const d = await apiGet<ProductLite[]>('/api/products?slim=1')
        setProducts(Array.isArray(d) ? d : [])
      } catch {
        toast.error(isEn ? 'Failed to load product list' : '加载商品列表失败')
      }
    }
  }

  async function submitAdjust() {
    if (!selProduct) { toast.error(isEn ? 'Please select a product first' : '请先选择商品'); return }
    const n = Number(adjQty)
    if (!Number.isFinite(n) || n <= 0) { toast.error(isEn ? 'Please enter an adjustment quantity greater than 0' : '请输入大于 0 的调整数量'); return }
    const qty = direction === 'in' ? n : -n
    setSubmitting(true)
    try {
      await apiPost('/api/stock-moves', {
        productId: selProduct.id,
        productName: selProduct.name,
        qty,
        type: 'ADJUSTMENT',
        note: adjNote.trim() || (direction === 'in' ? (isEn ? 'Manual stock gain' : '手动盘盈') : (isEn ? 'Manual stock loss' : '手动盘亏')),
      })
      toast.success(isEn ? 'Stock adjusted successfully' : '库存调整成功')
      setShowAdjust(false)
      resetAdjust()
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Adjustment failed' : '调整失败'))
    } finally {
      setSubmitting(false)
    }
  }

  const prodMatches: ProductLite[] = prodSearch.trim()
    ? rankByRelevance(products, prodSearch, p => p.name).slice(0, 30)
    : []

  // 高亮项滚动到可视区
  useEffect(() => {
    const el = adjListRef.current?.querySelector(`[data-idx="${prodHighlight}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [prodHighlight])

  const filtered = moves.filter((m) => {
    if (activeTab !== 'all' && m.type !== activeTab) return false
    if (search) {
      const q = search.toLowerCase()
      return m.productName.toLowerCase().includes(q) || (m.note ?? '').toLowerCase().includes(q)
    }
    return true
  })

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <button onClick={() => router.push(`${prefix}/classic/operator/inventory`)} className="hover:underline">
          {isEn ? 'Inventory' : '库存管理'}
        </button>
        <span>/</span>
        <span style={{ color: PURPLE }}>{isEn ? 'Stock Moves' : '库存流水'}</span>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold" style={{ color: PURPLE }}>{isEn ? 'Stock Move Records' : '库存流水记录'}</h1>
        <button onClick={openAdjust} className="px-4 py-1.5 rounded text-sm font-medium text-white" style={{ background: PURPLE }}>
          {isEn ? '+ Manual Adjustment' : '+ 手动调整'}
        </button>
      </div>

      {/* Type tabs */}
      <div className="flex gap-1 border-b" style={{ borderColor: BORDER }}>
        {TYPE_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className="px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors"
            style={{
              borderColor: activeTab === tab.key ? PURPLE : 'transparent',
              color: activeTab === tab.key ? PURPLE : '#6b7280',
            }}
          >
            {isEn ? tab.labelEn : tab.labelZh}
          </button>
        ))}
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder={isEn ? 'Search product name or note...' : '搜索商品名称或备注...'}
          className="border rounded px-3 py-1.5 text-sm flex-1 outline-none"
          style={{ borderColor: BORDER }}
        />
        <button type="submit" className="px-4 py-1.5 rounded text-sm font-medium text-white" style={{ background: PURPLE }}>
          {isEn ? 'Search' : '搜索'}
        </button>
        {search && (
          <button type="button" onClick={() => { setSearch(''); setSearchInput('') }} className="px-3 py-1.5 rounded text-sm text-gray-500 border" style={{ borderColor: BORDER }}>
            {isEn ? 'Clear' : '清除'}
          </button>
        )}
      </form>

      <div className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: BORDER }}>
        <div className="grid gap-3 px-4 py-2.5 text-xs font-semibold border-b"
          style={{ borderColor: BORDER, color: PURPLE, background: '#faf5fb', gridTemplateColumns: '1fr 80px 100px 110px 100px 1fr 120px' }}>
          <span>{isEn ? 'Product' : '商品名称'}</span>
          <span>{isEn ? 'Type' : '类型'}</span>
          <span className="text-right">{isEn ? 'Qty' : '数量'}</span>
          <span>{isEn ? 'Lot No.' : '批号'}</span>
          <span>{isEn ? 'Source Doc' : '源单据'}</span>
          <span>{isEn ? 'Note' : '备注'}</span>
          <span>{isEn ? 'Time' : '时间'}</span>
        </div>

        {loading && <div className="py-12 text-center text-sm text-gray-400">{isEn ? 'Loading…' : '加载中…'}</div>}

        {!loading && filtered.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-400">{isEn ? 'No stock move records' : '暂无流水记录'}</div>
        )}

        {!loading && filtered.map((move) => {
          const sourceHrefBase = move.sourceType ? SOURCE_HREF[move.sourceType] : null
          const sourceHref = sourceHrefBase && move.sourceId
            ? `${prefix}${sourceHrefBase}/${move.sourceId}`
            : null
          return (
            <div
              key={move.id}
              className="grid gap-3 px-4 py-3 border-b last:border-b-0 items-center"
              style={{ borderColor: '#f0e4ee', gridTemplateColumns: '1fr 80px 100px 110px 100px 1fr 120px' }}
            >
              <span className="text-sm font-medium text-gray-800">{move.productName}</span>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium w-fit ${TYPE_COLOR[move.type] ?? 'bg-gray-100 text-gray-600'}`}>
                {TYPE_LABEL[move.type] ?? move.type}
              </span>
              <span className={`text-sm font-mono text-right font-semibold ${Number(move.qty) > 0 ? 'text-green-600' : 'text-red-500'}`}>
                {Number(move.qty) > 0 ? '+' : ''}{Number(move.qty).toFixed(2)}
              </span>
              <span className="text-xs font-mono text-gray-500 truncate" title={move.lot?.bestBefore ? `${isEn ? 'Best before' : '保质期'}: ${formatDateOnly(move.lot.bestBefore)}` : undefined}>
                {move.lot?.lotNumber ?? <span className="text-gray-300">—</span>}
              </span>
              <span className="text-xs truncate">
                {sourceHref ? (
                  <button
                    onClick={() => router.push(sourceHref)}
                    className="text-purple-700 hover:underline font-mono"
                  >
                    {move.sourceRef}
                  </button>
                ) : (
                  <span className="text-gray-400">{move.sourceRef ?? '—'}</span>
                )}
              </span>
              <span className="text-xs text-gray-500 truncate">{move.note ?? '—'}</span>
              <span className="text-xs text-gray-400">{formatDateTime(move.createdAt)}</span>
            </div>
          )
        })}
      </div>

      <p className="text-xs text-gray-400">{isEn ? `Showing the most recent ${PAGE_SIZE} records` : `显示最近 ${PAGE_SIZE} 条记录`}</p>

      {showAdjust && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (!submitting) { setShowAdjust(false); resetAdjust() } }}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: BORDER }}>
              <h2 className="text-base font-semibold" style={{ color: PURPLE }}>{isEn ? 'Manual Stock Adjustment' : '手动库存调整'}</h2>
              <button onClick={() => { setShowAdjust(false); resetAdjust() }} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
            </div>
            <div className="px-5 py-4 space-y-4">
              {/* 商品选择 */}
              <div>
                <label className="text-xs text-gray-500 block mb-1">{isEn ? 'Product *' : '商品 *'}</label>
                {selProduct ? (
                  <div className="flex items-center justify-between border rounded px-3 py-2 text-sm" style={{ borderColor: BORDER }}>
                    <span>
                      <span className="font-medium">{selProduct.name}</span>
                      <span className="text-xs text-gray-400 ml-2">{isEn ? 'Current stock: ' : '当前库存：'}{selProduct.qtyOnHand ?? 0}{selProduct.uomName ? ' ' + selProduct.uomName : ''}</span>
                    </span>
                    <button onClick={() => { setSelProduct(null); setProdSearch('') }} className="text-xs text-purple-600 hover:underline shrink-0 ml-2">{isEn ? 'Change' : '更换'}</button>
                  </div>
                ) : (
                  <div className="relative">
                    <input
                      ref={adjInputRef}
                      autoFocus
                      value={prodSearch}
                      onChange={e => { setProdSearch(e.target.value); setProdHighlight(0) }}
                      onKeyDown={handleAdjKey}
                      placeholder={isEn ? 'Search product name… (↑↓ to select, Enter to confirm)' : '搜索商品名称…（↑↓ 选择，回车确认）'}
                      className="border rounded px-3 py-2 text-sm w-full outline-none"
                      style={{ borderColor: BORDER }}
                    />
                    {prodMatches.length > 0 && (
                      <div ref={adjListRef} className="absolute z-10 mt-1 w-full bg-white border rounded shadow-lg max-h-56 overflow-y-auto" style={{ borderColor: BORDER }}>
                        {prodMatches.map((p, idx) => (
                          <div
                            key={p.id}
                            data-idx={idx}
                            onMouseEnter={() => setProdHighlight(idx)}
                            onMouseDown={e => { e.preventDefault(); selectAdjProduct(p) }}
                            className={`flex items-center justify-between px-3 py-2 text-sm cursor-pointer ${idx === prodHighlight ? 'bg-purple-100' : 'hover:bg-purple-50'}`}
                          >
                            <span className="font-medium truncate">{p.name}</span>
                            <span className="text-xs text-gray-400 ml-2 shrink-0">{isEn ? 'Stock ' : '库存 '}{p.qtyOnHand ?? 0}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {/* 方向 */}
              <div>
                <label className="text-xs text-gray-500 block mb-1">{isEn ? 'Adjustment Direction *' : '调整方向 *'}</label>
                <div className="flex gap-2">
                  <button onClick={() => setDirection('in')} className="flex-1 px-3 py-2 rounded text-sm font-medium border" style={direction === 'in' ? { background: '#dcfce7', borderColor: '#16a34a', color: '#15803d' } : { borderColor: BORDER, color: '#6b7280' }}>{isEn ? 'Gain (+ Increase)' : '盘盈（+ 增加）'}</button>
                  <button onClick={() => setDirection('out')} className="flex-1 px-3 py-2 rounded text-sm font-medium border" style={direction === 'out' ? { background: '#fee2e2', borderColor: '#dc2626', color: '#b91c1c' } : { borderColor: BORDER, color: '#6b7280' }}>{isEn ? 'Loss (− Decrease)' : '盘亏（− 减少）'}</button>
                </div>
              </div>
              {/* 数量 */}
              <div>
                <label className="text-xs text-gray-500 block mb-1">{isEn ? 'Adjustment Quantity *' : '调整数量 *'}</label>
                <input type="number" min="0" step="any" value={adjQty} onChange={e => setAdjQty(e.target.value)} placeholder={isEn ? 'Enter quantity (positive number)' : '输入数量（正数）'} className="border rounded px-3 py-2 text-sm w-full outline-none" style={{ borderColor: BORDER }} />
                {selProduct && Number(adjQty) > 0 && (
                  <p className="text-xs text-gray-400 mt-1">
                    {isEn ? 'Stock after adjustment: ' : '调整后库存：'}{selProduct.qtyOnHand ?? 0} → <span className="font-semibold" style={{ color: PURPLE }}>{(selProduct.qtyOnHand ?? 0) + (direction === 'in' ? 1 : -1) * Number(adjQty)}</span>
                  </p>
                )}
              </div>
              {/* 原因 */}
              <div>
                <label className="text-xs text-gray-500 block mb-1">{isEn ? 'Reason / Note' : '调整原因 / 备注'}</label>
                <input value={adjNote} onChange={e => setAdjNote(e.target.value)} placeholder={isEn ? 'e.g. count discrepancy, loss, opening balance…' : '如：盘点差异、损耗、期初录入…'} className="border rounded px-3 py-2 text-sm w-full outline-none" style={{ borderColor: BORDER }} />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: BORDER }}>
              <button onClick={() => { setShowAdjust(false); resetAdjust() }} className="px-4 py-2 text-sm rounded border" style={{ borderColor: BORDER, color: '#6b7280' }}>{isEn ? 'Cancel' : '取消'}</button>
              <button onClick={submitAdjust} disabled={submitting} className="px-4 py-2 text-sm rounded text-white font-medium disabled:opacity-50" style={{ background: PURPLE }}>{submitting ? (isEn ? 'Submitting…' : '提交中…') : (isEn ? 'Confirm Adjustment' : '确认调整')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
