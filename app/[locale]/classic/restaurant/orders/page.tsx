'use client'
import { useState, useEffect } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'
import { getSession } from '@/lib/session'
import type { Order } from '@/lib/types'
import { OrderStatusBadge } from '@/components/shared/status-badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DateTimeShort } from '@/components/shared/date-with-day'
import { displayOrderCode } from '@/lib/order-code'

const PURPLE = '#875A7B'

export default function ClassicRestaurantOrdersPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [orders, setOrders] = useState<Order[]>([])
  const [selected, setSelected] = useState<Order | null>(null)

  useEffect(() => {
    const user = getSession()
    if (!user) return
    const cid = user.customerId ?? user.userId
    apiGet<Record<string, unknown>[]>(`/api/orders?restaurantId=${cid}`)
      .then(raw => setOrders(raw.map(o => ({ ...(o as unknown as Order), status: (o.status as string).toLowerCase() as Order['status'] }))))
      .catch(() => {})
  }, [])

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">{isEn ? 'My Orders' : '我的订单'}</h1>

      {orders.length === 0 && (
        <div className="bg-white rounded-xl border border-gray-200 py-16 text-center text-gray-400">
          {isEn ? 'No orders yet' : '暂无订单'}
        </div>
      )}

      <div className="space-y-3">
        {orders.map(o => (
          <div
            key={o.id}
            className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:shadow-md transition-shadow"
            style={{ ['--tw-border-opacity' as string]: '1' }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = '#d4c0d4')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = '')}
            onClick={() => setSelected(o)}
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono text-xs text-gray-500 mr-2">{displayOrderCode(o)}</span>
                <OrderStatusBadge status={o.status} />
              </div>
              <span className="font-bold" style={{ color: PURPLE }}>€{o.totalAmount.toFixed(2)}</span>
            </div>
            <div className="mt-2 text-sm text-gray-600">
              {o.items.map(i => `${i.productName}×${i.quantity}`).join(isEn ? ', ' : '、')}
            </div>
            <div className="mt-1 text-xs text-gray-400">
              <DateTimeShort date={o.createdAt} />
            </div>
          </div>
        ))}
      </div>

      <Dialog open={!!selected} onOpenChange={() => setSelected(null)}>
        {selected && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{isEn ? 'Order Details' : '订单详情'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">{isEn ? 'Order #' : '订单号'}</span>
                <span className="font-mono text-xs">{displayOrderCode(selected)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">{isEn ? 'Placed at' : '下单时间'}</span>
                <DateTimeShort date={selected.createdAt} />
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">{isEn ? 'Delivery Status' : '配送状态'}</span>
                <OrderStatusBadge status={selected.status} />
              </div>
              <div className="border-t pt-3">
                <p className="text-sm font-medium text-gray-700 mb-2">{isEn ? 'Items' : '商品明细'}</p>
                <div className="space-y-2">
                  {selected.items.map((item, i) => (
                    <div key={i} className="flex justify-between text-sm">
                      <span>{item.productName} <span className="text-gray-400 text-xs">× {item.quantity}</span></span>
                      <span className="font-medium">€{item.subtotal.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="border-t pt-3 flex justify-between font-bold">
                <span>{isEn ? 'Total' : '合计'}</span>
                <span style={{ color: PURPLE }}>€{selected.totalAmount.toFixed(2)}</span>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
