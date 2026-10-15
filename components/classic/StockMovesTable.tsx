'use client'
/**
 * 库存流水表 —— 20261014（复式改造 L3）
 * 每行一笔「从 → 到」：采购单 Receipt 弹窗、销售订单、商品页、库存流水页共用。
 * 数据来自 GET /api/stock-moves?paged=1（lib/stock-ledger.ts 写入）。
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { formatDateTime } from '@/lib/format-date'

export interface StockMoveRow {
  id: string
  productId: string
  productName: string
  type: string
  qty: number | string
  uomQty?: number | string | null
  uomName?: string | null
  unitCost?: number | string | null
  value?: number | string | null
  note?: string | null
  sourceType?: string | null
  sourceId?: string | null
  sourceRef?: string | null
  movedAt: string
  createdBy?: string | null
  lot?: { lotNumber: string; bestBefore?: string | null } | null
  fromLocation?: { code: string; nameZh?: string | null } | null
  toLocation?: { code: string; nameZh?: string | null } | null
}

export interface StockMoveFilter {
  sourceId?: string
  sourceTypes?: string[]
  productId?: string
  lotId?: string
  location?: string
  type?: string
  from?: string
  to?: string
  q?: string
}

const TYPE_LABEL: Record<string, [string, string]> = {
  IN: ['入库', 'In'],
  OUT: ['出库', 'Out'],
  ADJUSTMENT: ['调整', 'Adjustment'],
  RETURN: ['退回', 'Return'],
  SCRAP: ['报废', 'Scrap'],
}

const loc = (l: StockMoveRow['fromLocation'], isEn: boolean) => (l ? (isEn ? l.code : l.nameZh || l.code) : '—')
const n = (v: unknown) => (v == null || v === '' ? null : Number(v))
const fmtQty = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''))

export function buildStockMoveQuery(f: StockMoveFilter, page: number, pageSize: number): string {
  const p = new URLSearchParams({ paged: '1', page: String(page), pageSize: String(pageSize) })
  if (f.sourceId) p.set('sourceId', f.sourceId)
  if (f.sourceTypes?.length) p.set('sourceTypes', f.sourceTypes.join(','))
  if (f.productId) p.set('productId', f.productId)
  if (f.lotId) p.set('lotId', f.lotId)
  if (f.location) p.set('location', f.location)
  if (f.type) p.set('type', f.type)
  if (f.from) p.set('from', f.from)
  if (f.to) p.set('to', f.to)
  if (f.q) p.set('q', f.q)
  return `/api/stock-moves?${p.toString()}`
}

export default function StockMovesTable({ filter, isEn, pageSize = 80, showProduct = true, showReference = true, emptyText, onLoaded }: {
  filter: StockMoveFilter
  isEn: boolean
  pageSize?: number
  showProduct?: boolean
  showReference?: boolean
  emptyText?: string
  onLoaded?: (total: number) => void
}) {
  const [rows, setRows] = useState<StockMoveRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const key = JSON.stringify(filter)
  // 页码跟筛选条件绑在一起：条件变了自动回到第 1 页（不在 effect 里 setState）
  const [pageState, setPageState] = useState({ key, page: 1 })
  const page = pageState.key === key ? pageState.page : 1
  const setPage = (fn: (p: number) => number) => setPageState({ key, page: fn(page) })

  const load = useCallback(() => {
    apiGet<{ items: StockMoveRow[]; total: number }>(buildStockMoveQuery(JSON.parse(key), page, pageSize))
      .then(d => { setRows(d.items); setTotal(d.total); onLoaded?.(d.total) })
      .catch(e => toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load stock moves' : '加载库存流水失败')))
  }, [key, page, pageSize, isEn, onLoaded])

  useEffect(() => { load() }, [load])

  if (rows === null) return <div className="text-sm text-gray-400 py-4 text-center">{isEn ? 'Loading…' : '加载中…'}</div>
  if (rows.length === 0) {
    return (
      <div className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-200 rounded" data-testid="stock-moves-empty">
        {emptyText ?? (isEn ? 'No stock moves' : '暂无库存流水')}
      </div>
    )
  }
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div data-testid="stock-moves-table">
      <div className="overflow-x-auto border border-gray-200 rounded">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="text-left px-2 py-1.5 font-medium">{isEn ? 'Date' : '日期'}</th>
              {showReference && <th className="text-left px-2 py-1.5 font-medium">{isEn ? 'Reference' : '单据'}</th>}
              {showProduct && <th className="text-left px-2 py-1.5 font-medium">{isEn ? 'Product' : '商品'}</th>}
              <th className="text-left px-2 py-1.5 font-medium">{isEn ? 'Lot' : '批次'}</th>
              <th className="text-left px-2 py-1.5 font-medium">{isEn ? 'From' : '从'}</th>
              <th className="text-left px-2 py-1.5 font-medium">{isEn ? 'To' : '到'}</th>
              <th className="text-right px-2 py-1.5 font-medium">{isEn ? 'Quantity' : '数量'}</th>
              <th className="text-right px-2 py-1.5 font-medium">{isEn ? 'Value' : '金额'}</th>
              <th className="text-left px-2 py-1.5 font-medium">{isEn ? 'By' : '经手'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map(r => {
              const qty = n(r.qty) ?? 0
              const uomQty = n(r.uomQty)
              const value = n(r.value)
              const inbound = qty > 0
              return (
                <tr key={r.id} title={r.note ?? ''}>
                  <td className="px-2 py-1.5 whitespace-nowrap text-gray-600">{formatDateTime(r.movedAt)}</td>
                  {showReference && (
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span className="font-mono">{r.sourceRef ?? '—'}</span>
                      <span className="ml-1 text-gray-400">{TYPE_LABEL[r.type]?.[isEn ? 1 : 0] ?? r.type}</span>
                    </td>
                  )}
                  {showProduct && <td className="px-2 py-1.5 text-gray-800">{r.productName}</td>}
                  <td className="px-2 py-1.5 font-mono text-gray-600">{r.lot?.lotNumber ?? '—'}</td>
                  <td className="px-2 py-1.5 text-gray-700">{loc(r.fromLocation, isEn)}</td>
                  <td className="px-2 py-1.5 text-gray-700">{loc(r.toLocation, isEn)}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${inbound ? 'text-green-700' : 'text-orange-700'}`}>
                    {inbound ? '+' : '−'}{fmtQty(Math.abs(qty))}
                    {uomQty != null && r.uomName && Math.abs(uomQty) !== Math.abs(qty) && (
                      <span className="ml-1 text-gray-400 font-normal">({fmtQty(Math.abs(uomQty))} {r.uomName})</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{value != null ? `€${value.toFixed(2)}` : '—'}</td>
                  <td className="px-2 py-1.5 text-gray-500">{r.createdBy ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 mt-2 text-xs text-gray-600">
          <span>{(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} / {total}</span>
          <button className="px-2 py-0.5 border rounded disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹</button>
          <button className="px-2 py-0.5 border rounded disabled:opacity-40" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>›</button>
        </div>
      )}
    </div>
  )
}
