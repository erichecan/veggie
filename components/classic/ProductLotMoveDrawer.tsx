'use client'
/**
 * 商品页「Lot/Move」抽屉 —— 20261021 客户需求：「展示该产品的 lot/Move 的完整信息」
 * 两个 tab：库存流水（这个商品的每一笔「从 → 到」，同库存流水页同一张表）/ 批次（每个批次的来源、到货、BBD、
 * 初始量、余量）。点批次只看该批次的流水。版式同商品页收货历史抽屉（右侧滑出）。
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { apiGet } from '@/lib/api'
import { formatDateOnly } from '@/lib/format-date'
import StockMovesTable from '@/components/classic/StockMovesTable'

const ACCENT = '#875A7B'

interface LotRow {
  id: string
  lotNumber: string
  status: string
  initialQty: number | string
  currentQty: number | string
  arrivedAt: string
  bestBefore?: string | null
  sourceType?: string | null
  sourceRef?: string | null
  unitCost?: number | string | null
}

const qty = (v: unknown) => {
  const n = Number(v ?? 0)
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

export default function ProductLotMoveDrawer({ productId, productName, isEn, prefix, onClose }: {
  productId: string
  productName: string
  isEn: boolean
  prefix: string
  onClose: () => void
}) {
  const [tab, setTab] = useState<'moves' | 'lots'>('moves')
  const [lots, setLots] = useState<LotRow[] | null>(null)
  const [lotFilter, setLotFilter] = useState<LotRow | null>(null)
  const [moveTotal, setMoveTotal] = useState<number | null>(null)
  // 判断 BBD 是否已过期的基准时间：取批次加载回来那一刻（不在渲染里调 Date.now()）
  const [loadedAt, setLoadedAt] = useState(0)

  useEffect(() => {
    apiGet<LotRow[]>(`/api/lots?productId=${encodeURIComponent(productId)}&status=ALL&limit=500`)
      .then(rows => {
        setLots([...rows].sort((a, b) => new Date(b.arrivedAt).getTime() - new Date(a.arrivedAt).getTime()))
        setLoadedAt(Date.now())
      })
      .catch(() => setLots([]))
  }, [productId])

  const fullPage = `${prefix}/classic/operator/inventory/moves?productId=${encodeURIComponent(productId)}${lotFilter ? `&lotId=${encodeURIComponent(lotFilter.id)}` : ''}`

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <div
        className="absolute top-0 right-0 h-full w-full sm:w-[960px] max-w-full bg-white shadow-2xl border-l border-gray-200 flex flex-col"
        onClick={e => e.stopPropagation()}
        data-testid="lot-move-drawer"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 shrink-0">
          <h2 className="text-base font-semibold truncate" style={{ color: ACCENT }}>
            {isEn ? `Lots / Moves · ${productName}` : `批次 / 库存流水 · ${productName}`}
          </h2>
          <div className="flex items-center gap-3 shrink-0 ml-2">
            <Link href={fullPage} className="text-xs underline" style={{ color: ACCENT }}>
              {isEn ? 'Open in Stock Moves ↗' : '在库存流水页打开 ↗'}
            </Link>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
          </div>
        </div>

        <div className="flex gap-1 px-5 border-b border-gray-200 shrink-0">
          {([
            ['moves', isEn ? `Stock Moves${moveTotal != null ? ` (${moveTotal})` : ''}` : `库存流水${moveTotal != null ? `（${moveTotal}）` : ''}`],
            ['lots', isEn ? `Lots${lots ? ` (${lots.length})` : ''}` : `批次${lots ? `（${lots.length}）` : ''}`],
          ] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} data-testid={`lot-move-tab-${k}`}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${tab === k ? '' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
              style={tab === k ? { borderColor: ACCENT, color: ACCENT } : {}}>
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === 'moves' ? (
            <div className="space-y-2">
              {lotFilter && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="px-2 py-1 rounded bg-purple-50" style={{ color: ACCENT }}>
                    {isEn ? 'Lot' : '批次'} {lotFilter.lotNumber}
                  </span>
                  <button onClick={() => setLotFilter(null)} className="text-gray-500 underline">{isEn ? 'Show all lots' : '看全部批次'}</button>
                </div>
              )}
              <StockMovesTable
                filter={{ productId, lotId: lotFilter?.id }}
                isEn={isEn}
                pageSize={50}
                showProduct={false}
                onLoaded={lotFilter ? undefined : setMoveTotal}
                emptyText={isEn ? 'No stock moves for this product yet' : '这个商品还没有库存流水'}
              />
            </div>
          ) : lots === null ? (
            <p className="text-sm text-gray-400">{isEn ? 'Loading…' : '加载中…'}</p>
          ) : lots.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">{isEn ? 'No lots yet' : '还没有批次'}</p>
          ) : (
            <div className="overflow-x-auto border border-gray-200 rounded">
              <table className="w-full text-xs" data-testid="lot-table">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium">{isEn ? 'Lot' : '批次'}</th>
                    <th className="text-left px-2 py-1.5 font-medium">{isEn ? 'Source' : '来源单据'}</th>
                    <th className="text-left px-2 py-1.5 font-medium">{isEn ? 'Arrived' : '到货日期'}</th>
                    <th className="text-left px-2 py-1.5 font-medium">BBD</th>
                    <th className="text-right px-2 py-1.5 font-medium">{isEn ? 'Initial' : '初始数量'}</th>
                    <th className="text-right px-2 py-1.5 font-medium">{isEn ? 'Remaining' : '余量'}</th>
                    <th className="text-right px-2 py-1.5 font-medium">{isEn ? 'Unit Cost' : '单位成本'}</th>
                    <th className="text-center px-2 py-1.5 font-medium">{isEn ? 'Status' : '状态'}</th>
                    <th className="px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {lots.map(l => {
                    const available = l.status === 'AVAILABLE' && Number(l.currentQty) > 0
                    const expired = !!l.bestBefore && new Date(l.bestBefore).getTime() < loadedAt && available
                    return (
                      <tr key={l.id} className="hover:bg-gray-50">
                        <td className="px-2 py-1.5 font-mono text-gray-800">{l.lotNumber}</td>
                        <td className="px-2 py-1.5 font-mono text-gray-600">{l.sourceRef ?? l.sourceType ?? '—'}</td>
                        <td className="px-2 py-1.5 text-gray-600 whitespace-nowrap">{formatDateOnly(l.arrivedAt)}</td>
                        <td className={`px-2 py-1.5 whitespace-nowrap ${expired ? 'text-red-600 font-semibold' : 'text-gray-600'}`}>
                          {l.bestBefore ? formatDateOnly(l.bestBefore) : '—'}{expired ? (isEn ? ' (expired)' : '（已过期）') : ''}
                        </td>
                        <td className="px-2 py-1.5 text-right text-gray-600">{qty(l.initialQty)}</td>
                        <td className={`px-2 py-1.5 text-right font-semibold ${available ? 'text-gray-900' : 'text-gray-400'}`}>{qty(l.currentQty)}</td>
                        <td className="px-2 py-1.5 text-right text-gray-600">{l.unitCost != null ? `€${Number(l.unitCost).toFixed(2)}` : '—'}</td>
                        <td className="px-2 py-1.5 text-center">
                          <span className={`px-1.5 py-0.5 rounded text-[11px] ${available ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                            {available ? (isEn ? 'Available' : '可用') : (isEn ? 'Depleted' : '已耗尽')}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <button onClick={() => { setLotFilter(l); setTab('moves') }} className="underline whitespace-nowrap" style={{ color: ACCENT }}
                            data-testid={`lot-moves-${l.lotNumber}`}>
                            {isEn ? 'Moves' : '看流水'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
