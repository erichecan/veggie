'use client'
import { useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'
import { toast } from 'sonner'
import { eur } from '@/lib/format-money'
import { formatDateOnly } from '@/lib/format-date'
import { usePriceCheck } from './price-check'
import type { CartItem } from './cart-utils'

const PURPLE = '#875A7B'
const RECENT_COUNT = 5

interface RecentOrderLine {
  id: string
  productId: string
  productName: string
  spec: string | null
  uomName: string | null
  unitPrice: number
  orderedQty: number
}

interface RecentOrder {
  id: string
  code: string
  status: string
  totalAmount: number
  createdAt: string
  lines: RecentOrderLine[]
}

/** 最近 N 单 + 一键"再来一单"——整单维度的快捷复购，与常购清单（单品维度）互补 */
export function RecentOrdersPanel({ onReorder, isEn }: { onReorder: (items: CartItem[]) => void; isEn: boolean }) {
  const [orders, setOrders] = useState<RecentOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const { open, checking, dialog } = usePriceCheck(isEn)

  useEffect(() => {
    apiGet<{ data: RecentOrder[] }>(`/api/customer-portal/orders?page=1&pageSize=${RECENT_COUNT}`)
      .then((d) => setOrders(d.data || []))
      .catch(() => toast.error(isEn ? 'Failed to load recent orders' : '加载最近订单失败'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleReorderClick(order: RecentOrder) {
    setCheckingId(order.id)
    await open(
      isEn ? `Reorder ${order.code}` : `再来一单 · ${order.code}`,
      order.lines.map((l) => ({
        productId: l.productId,
        name: l.productName,
        spec: l.spec,
        uomName: l.uomName,
        quantity: l.orderedQty,
        referencePrice: l.unitPrice,
      })),
      onReorder,
    )
    setCheckingId(null)
  }

  if (loading) return <p className="text-sm text-gray-400 py-6 text-center">{isEn ? 'Loading...' : '加载中...'}</p>
  if (orders.length === 0) return <p className="text-sm text-gray-400 py-6 text-center">{isEn ? 'No orders yet' : '暂无历史订单'}</p>

  return (
    <div className="space-y-2">
      {orders.map((o) => (
        <div key={o.id} className="bg-white rounded-xl border p-3 flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span>{o.code}</span>
              <span className="text-xs text-gray-400">{formatDateOnly(o.createdAt)}</span>
            </div>
            <p className="text-xs text-gray-400 truncate mt-0.5">
              {o.lines.slice(0, 3).map((l) => l.productName).join(isEn ? ', ' : '、')}
              {o.lines.length > 3 && (isEn ? ` +${o.lines.length - 3} more` : ` 等${o.lines.length}项`)}
              {' · '}{eur(o.totalAmount)}
            </p>
          </div>
          <button
            onClick={() => handleReorderClick(o)}
            disabled={checking && checkingId === o.id}
            className="flex-none px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50"
            style={{ background: PURPLE }}
          >
            {checking && checkingId === o.id ? (isEn ? 'Checking...' : '核对中...') : (isEn ? 'Reorder' : '再来一单')}
          </button>
        </div>
      ))}
      {dialog}
    </div>
  )
}
