'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'

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

const TYPE_LABEL: Record<string, string> = {
  IN: '入库',
  OUT: '出库',
  ADJUSTMENT: '库存调整',
  RETURN: '退货',
  SCRAP: '报废',
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
  { key: 'all', label: '全部' },
  { key: 'IN', label: '入库' },
  { key: 'OUT', label: '出库' },
  { key: 'ADJUSTMENT', label: '库存调整' },
  { key: 'RETURN', label: '退货' },
  { key: 'SCRAP', label: '报废' },
]

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const PAGE_SIZE = 100

export default function InventoryAdjustmentsPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
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

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<StockMove[]>(`/api/stock-moves?limit=${PAGE_SIZE}`)
      setMoves(Array.isArray(data) ? data : [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setSearch(searchInput)
  }

  function resetAdjust() {
    setProdSearch(''); setSelProduct(null); setDirection('in'); setAdjQty(''); setAdjNote('')
  }

  async function openAdjust() {
    setShowAdjust(true)
    if (products.length === 0) {
      try {
        const d = await apiGet<ProductLite[]>('/api/products')
        setProducts(Array.isArray(d) ? d : [])
      } catch {
        toast.error('加载商品列表失败')
      }
    }
  }

  async function submitAdjust() {
    if (!selProduct) { toast.error('请先选择商品'); return }
    const n = Number(adjQty)
    if (!Number.isFinite(n) || n <= 0) { toast.error('请输入大于 0 的调整数量'); return }
    const qty = direction === 'in' ? n : -n
    setSubmitting(true)
    try {
      await apiPost('/api/stock-moves', {
        productId: selProduct.id,
        productName: selProduct.name,
        qty,
        type: 'ADJUSTMENT',
        note: adjNote.trim() || (direction === 'in' ? '手动盘盈' : '手动盘亏'),
      })
      toast.success('库存调整成功')
      setShowAdjust(false)
      resetAdjust()
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '调整失败')
    } finally {
      setSubmitting(false)
    }
  }

  const prodMatches = prodSearch.trim()
    ? products.filter(p => p.name.toLowerCase().includes(prodSearch.trim().toLowerCase())).slice(0, 8)
    : []

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
          库存管理
        </button>
        <span>/</span>
        <span style={{ color: PURPLE }}>库存流水</span>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold" style={{ color: PURPLE }}>库存流水记录</h1>
        <button onClick={openAdjust} className="px-4 py-1.5 rounded text-sm font-medium text-white" style={{ background: PURPLE }}>
          + 手动调整
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
            {tab.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder="搜索商品名称或备注..."
          className="border rounded px-3 py-1.5 text-sm flex-1 outline-none"
          style={{ borderColor: BORDER }}
        />
        <button type="submit" className="px-4 py-1.5 rounded text-sm font-medium text-white" style={{ background: PURPLE }}>
          搜索
        </button>
        {search && (
          <button type="button" onClick={() => { setSearch(''); setSearchInput('') }} className="px-3 py-1.5 rounded text-sm text-gray-500 border" style={{ borderColor: BORDER }}>
            清除
          </button>
        )}
      </form>

      <div className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: BORDER }}>
        <div className="grid gap-3 px-4 py-2.5 text-xs font-semibold border-b"
          style={{ borderColor: BORDER, color: PURPLE, background: '#faf5fb', gridTemplateColumns: '1fr 80px 100px 110px 100px 1fr 120px' }}>
          <span>商品名称</span>
          <span>类型</span>
          <span className="text-right">数量</span>
          <span>批号</span>
          <span>源单据</span>
          <span>备注</span>
          <span>时间</span>
        </div>

        {loading && <div className="py-12 text-center text-sm text-gray-400">加载中…</div>}

        {!loading && filtered.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-400">暂无流水记录</div>
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
              <span className="text-xs font-mono text-gray-500 truncate" title={move.lot?.bestBefore ? `保质期: ${new Date(move.lot.bestBefore).toLocaleDateString('zh-CN')}` : undefined}>
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
              <span className="text-xs text-gray-400">{fmtDate(move.createdAt)}</span>
            </div>
          )
        })}
      </div>

      <p className="text-xs text-gray-400">显示最近 {PAGE_SIZE} 条记录</p>

      {showAdjust && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (!submitting) { setShowAdjust(false); resetAdjust() } }}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: BORDER }}>
              <h2 className="text-base font-semibold" style={{ color: PURPLE }}>手动库存调整</h2>
              <button onClick={() => { setShowAdjust(false); resetAdjust() }} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
            </div>
            <div className="px-5 py-4 space-y-4">
              {/* 商品选择 */}
              <div>
                <label className="text-xs text-gray-500 block mb-1">商品 *</label>
                {selProduct ? (
                  <div className="flex items-center justify-between border rounded px-3 py-2 text-sm" style={{ borderColor: BORDER }}>
                    <span>
                      <span className="font-medium">{selProduct.name}</span>
                      <span className="text-xs text-gray-400 ml-2">当前库存：{selProduct.qtyOnHand ?? 0}{selProduct.uomName ? ' ' + selProduct.uomName : ''}</span>
                    </span>
                    <button onClick={() => { setSelProduct(null); setProdSearch('') }} className="text-xs text-purple-600 hover:underline shrink-0 ml-2">更换</button>
                  </div>
                ) : (
                  <div className="relative">
                    <input autoFocus value={prodSearch} onChange={e => setProdSearch(e.target.value)} placeholder="搜索商品名称…" className="border rounded px-3 py-2 text-sm w-full outline-none" style={{ borderColor: BORDER }} />
                    {prodMatches.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full bg-white border rounded shadow-lg max-h-56 overflow-y-auto" style={{ borderColor: BORDER }}>
                        {prodMatches.map(p => (
                          <button key={p.id} onClick={() => { setSelProduct(p); setProdSearch('') }} className="block w-full text-left px-3 py-2 text-sm hover:bg-purple-50">
                            <span className="font-medium">{p.name}</span>
                            <span className="text-xs text-gray-400 ml-2">库存 {p.qtyOnHand ?? 0}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {/* 方向 */}
              <div>
                <label className="text-xs text-gray-500 block mb-1">调整方向 *</label>
                <div className="flex gap-2">
                  <button onClick={() => setDirection('in')} className="flex-1 px-3 py-2 rounded text-sm font-medium border" style={direction === 'in' ? { background: '#dcfce7', borderColor: '#16a34a', color: '#15803d' } : { borderColor: BORDER, color: '#6b7280' }}>盘盈（+ 增加）</button>
                  <button onClick={() => setDirection('out')} className="flex-1 px-3 py-2 rounded text-sm font-medium border" style={direction === 'out' ? { background: '#fee2e2', borderColor: '#dc2626', color: '#b91c1c' } : { borderColor: BORDER, color: '#6b7280' }}>盘亏（− 减少）</button>
                </div>
              </div>
              {/* 数量 */}
              <div>
                <label className="text-xs text-gray-500 block mb-1">调整数量 *</label>
                <input type="number" min="0" step="any" value={adjQty} onChange={e => setAdjQty(e.target.value)} placeholder="输入数量（正数）" className="border rounded px-3 py-2 text-sm w-full outline-none" style={{ borderColor: BORDER }} />
                {selProduct && Number(adjQty) > 0 && (
                  <p className="text-xs text-gray-400 mt-1">
                    调整后库存：{selProduct.qtyOnHand ?? 0} → <span className="font-semibold" style={{ color: PURPLE }}>{(selProduct.qtyOnHand ?? 0) + (direction === 'in' ? 1 : -1) * Number(adjQty)}</span>
                  </p>
                )}
              </div>
              {/* 原因 */}
              <div>
                <label className="text-xs text-gray-500 block mb-1">调整原因 / 备注</label>
                <input value={adjNote} onChange={e => setAdjNote(e.target.value)} placeholder="如：盘点差异、损耗、期初录入…" className="border rounded px-3 py-2 text-sm w-full outline-none" style={{ borderColor: BORDER }} />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: BORDER }}>
              <button onClick={() => { setShowAdjust(false); resetAdjust() }} className="px-4 py-2 text-sm rounded border" style={{ borderColor: BORDER, color: '#6b7280' }}>取消</button>
              <button onClick={submitAdjust} disabled={submitting} className="px-4 py-2 text-sm rounded text-white font-medium disabled:opacity-50" style={{ background: PURPLE }}>{submitting ? '提交中…' : '确认调整'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
