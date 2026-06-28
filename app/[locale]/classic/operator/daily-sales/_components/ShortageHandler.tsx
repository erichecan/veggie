'use client'
import { useState, useEffect, useMemo } from 'react'
import { apiGet, apiPost } from '@/lib/api'
import type { Order, OrderLine } from '@/lib/types'
import { today, fmtMoney } from './shared'
import ProductSearchInput from '@/components/classic/ProductSearchInput'

interface ProductRow { id: string; name: string; salePrice?: number; category?: string }

interface AffectedLine {
  lineId: string
  orderId: string
  orderCode: string
  restaurantName: string
  orderedQty: number
  unitPrice: number
  subtotal: number
}

type ShortageAction = 'DELETE_ALL' | 'DISTRIBUTE_EVEN' | 'DISTRIBUTE_MANUAL'

interface ApplyBody {
  productId: string
  productName: string
  date: string
  action: ShortageAction
  availableQty?: number
  manual?: Array<{ orderId: string; lineId: string; newQty: number }>
}

export default function ShortageHandler() {
  const [date, setDate] = useState(today)
  const [allProducts, setAllProducts] = useState<ProductRow[]>([])
  const [productSearch, setProductSearch] = useState('')
  const [selectedProduct, setSelectedProduct] = useState<ProductRow | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [action, setAction] = useState<ShortageAction>('DELETE_ALL')
  const [availableQty, setAvailableQty] = useState('')
  const [manualQtys, setManualQtys] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [resultMsg, setResultMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    apiGet<ProductRow[]>('/api/products?limit=500').then(d => setAllProducts(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  useEffect(() => {
    if (!date) return
    setOrdersLoading(true)
    apiGet<Order[]>(
      `/api/orders?include_lines=true&status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY&dateField=deliveryDate&fromDate=${date}&toDate=${date}`
    )
      .then(d => setOrders(Array.isArray(d) ? d : []))
      .catch(() => setOrders([]))
      .finally(() => setOrdersLoading(false))
  }, [date])

  const affectedLines: AffectedLine[] = useMemo(() => {
    if (!selectedProduct) return []
    const result: AffectedLine[] = []
    for (const o of orders) {
      for (const l of (o.lines ?? [])) {
        if ((l as OrderLine).productId === selectedProduct.id || (l as OrderLine).productName === selectedProduct.name) {
          result.push({
            lineId: l.id,
            orderId: o.id,
            orderCode: o.code ?? o.id.slice(-6),
            restaurantName: o.restaurantName,
            orderedQty: Number((l as OrderLine).orderedQty),
            unitPrice: Number((l as OrderLine).unitPrice),
            subtotal: Number((l as OrderLine).subtotal),
          })
        }
      }
    }
    return result
  }, [orders, selectedProduct])

  const totalQty = affectedLines.reduce((s, l) => s + l.orderedQty, 0)

  function handleSelectProduct(p: ProductRow) {
    setSelectedProduct(p)
    setProductSearch(p.name)
    setResultMsg(null)
    setManualQtys({})
    setAvailableQty('')
  }

  async function handleApply() {
    if (!selectedProduct || affectedLines.length === 0) return
    setSubmitting(true)
    setResultMsg(null)
    try {
      const body: ApplyBody = {
        productId: selectedProduct.id,
        productName: selectedProduct.name,
        date,
        action,
      }
      if (action === 'DISTRIBUTE_EVEN') {
        body.availableQty = Number(availableQty)
      }
      if (action === 'DISTRIBUTE_MANUAL') {
        body.manual = affectedLines.map(l => ({
          orderId: l.orderId,
          lineId: l.lineId,
          newQty: Number(manualQtys[l.lineId] ?? l.orderedQty),
        }))
      }
      await apiPost('/api/daily-sales/shortage/apply', body)
      setResultMsg({ ok: true, text: `操作成功：已处理 ${affectedLines.length} 条订单行` })
      // refresh orders
      const fresh = await apiGet<Order[]>(
        `/api/orders?include_lines=true&status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY&dateField=deliveryDate&fromDate=${date}&toDate=${date}`
      )
      setOrders(Array.isArray(fresh) ? fresh : [])
      setSelectedProduct(null)
      setProductSearch('')
    } catch (err) {
      setResultMsg({ ok: false, text: err instanceof Error ? err.message : '操作失败' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-5 max-w-3xl">
      {/* Date picker */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 flex items-center gap-4">
        <label className="text-sm text-gray-600">配送日期</label>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-[#875A7B]"
        />
        {ordersLoading && <span className="text-xs text-gray-400">加载中...</span>}
        {!ordersLoading && <span className="text-xs text-gray-400">共 {orders.length} 单</span>}
      </div>

      {/* Product search */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="text-sm font-medium text-gray-700 mb-2">搜索缺货商品</div>
        <ProductSearchInput
          value={productSearch}
          onChange={v => { setProductSearch(v); setSelectedProduct(null) }}
          onSelect={handleSelectProduct}
          products={allProducts}
          placeholder="输入商品名称..."
          showOnEmptyQuery={false}
          inputClassName="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-[#875A7B]"
        />
      </div>

      {/* Affected orders */}
      {selectedProduct && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
            <div>
              <span className="font-medium text-gray-800">{selectedProduct.name}</span>
              <span className="ml-2 text-xs text-gray-400">
                影响 {affectedLines.length} 单 · 总计 {totalQty} 件
              </span>
            </div>
          </div>

          {affectedLines.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-400 text-sm">该日期没有包含此商品的订单</div>
          ) : (
            <>
              {/* Lines table */}
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="px-4 py-2 text-left text-xs text-gray-400">订单</th>
                    <th className="px-4 py-2 text-left text-xs text-gray-400">客户</th>
                    <th className="px-4 py-2 text-right text-xs text-gray-400">订量</th>
                    <th className="px-4 py-2 text-right text-xs text-gray-400">小计</th>
                    {action === 'DISTRIBUTE_MANUAL' && (
                      <th className="px-4 py-2 text-right text-xs text-gray-400">新数量</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {affectedLines.map(l => (
                    <tr key={l.lineId} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-2 font-mono text-xs text-gray-500">{l.orderCode}</td>
                      <td className="px-4 py-2 text-gray-800">{l.restaurantName}</td>
                      <td className="px-4 py-2 text-right text-gray-600">{l.orderedQty}</td>
                      <td className="px-4 py-2 text-right text-gray-600">${fmtMoney(l.subtotal)}</td>
                      {action === 'DISTRIBUTE_MANUAL' && (
                        <td className="px-4 py-2 text-right">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={manualQtys[l.lineId] ?? l.orderedQty}
                            onChange={e => setManualQtys(prev => ({ ...prev, [l.lineId]: e.target.value }))}
                            className="w-20 border border-gray-300 rounded px-2 py-0.5 text-sm text-right focus:outline-none focus:border-[#875A7B]"
                          />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Action selection */}
              <div className="p-4 border-t border-gray-100 space-y-4">
                <div className="flex gap-3">
                  {(['DELETE_ALL', 'DISTRIBUTE_EVEN', 'DISTRIBUTE_MANUAL'] as ShortageAction[]).map(a => (
                    <button
                      key={a}
                      onClick={() => { setAction(a); setManualQtys({}) }}
                      className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                        action === a ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'border-gray-300 text-gray-600 hover:border-[#875A7B]'
                      }`}
                    >
                      {a === 'DELETE_ALL' ? '全部删除' : a === 'DISTRIBUTE_EVEN' ? '平均分配' : '手动分配'}
                    </button>
                  ))}
                </div>

                {action === 'DELETE_ALL' && (
                  <p className="text-xs text-red-600 bg-red-50 rounded px-3 py-2">
                    将从以上 {affectedLines.length} 个订单中删除「{selectedProduct.name}」这一行，并重新计算订单金额。
                  </p>
                )}

                {action === 'DISTRIBUTE_EVEN' && (
                  <div className="flex items-center gap-3">
                    <label className="text-sm text-gray-600">可用数量（总计）</label>
                    <input
                      type="number"
                      min="0"
                      value={availableQty}
                      onChange={e => setAvailableQty(e.target.value)}
                      placeholder={`原始共 ${totalQty}`}
                      className="w-28 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-[#875A7B]"
                    />
                    <span className="text-xs text-gray-400">
                      每单约 {availableQty ? (Number(availableQty) / affectedLines.length).toFixed(2) : '—'} 件
                    </span>
                  </div>
                )}

                {action === 'DISTRIBUTE_MANUAL' && (
                  <p className="text-xs text-gray-500">请在上方表格中逐行填写新数量（填 0 则删除该行）。</p>
                )}

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleApply}
                    disabled={submitting || (action === 'DISTRIBUTE_EVEN' && !availableQty)}
                    className="px-4 py-2 text-sm font-medium rounded bg-[#875A7B] text-white hover:bg-[#6d4764] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {submitting ? '处理中...' : '确认执行'}
                  </button>
                  {resultMsg && (
                    <span className={`text-sm ${resultMsg.ok ? 'text-green-600' : 'text-red-600'}`}>
                      {resultMsg.text}
                    </span>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
