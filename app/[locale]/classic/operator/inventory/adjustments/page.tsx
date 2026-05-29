'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'

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
    </div>
  )
}
