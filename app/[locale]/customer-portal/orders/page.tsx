'use client'
import { useEffect, useState, useCallback } from 'react'
import { apiGet } from '@/lib/api'
import { toast } from 'sonner'
import Link from 'next/link'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { formatDateOnly } from '@/lib/format-date'

const PURPLE = '#875A7B'

const STATUS_MAP_ZH: Record<string, { label: string; color: string; bg: string }> = {
  PENDING:        { label: '待确认', color: '#b45309', bg: '#fef3c7' },
  CONFIRMED:      { label: '已确认', color: '#1d4ed8', bg: '#dbeafe' },
  WAVE_ASSIGNED:  { label: '拣货中', color: '#6d28d9', bg: '#ede9fe' },
  IN_DELIVERY:    { label: '配送中', color: '#0891b2', bg: '#cffafe' },
  COMPLETED:      { label: '已完成', color: '#15803d', bg: '#dcfce7' },
  LOCKED:         { label: '已锁定', color: '#374151', bg: '#e5e7eb' },
  CANCELLED:      { label: '已取消', color: '#dc2626', bg: '#fee2e2' },
}

const STATUS_MAP_EN: Record<string, { label: string; color: string; bg: string }> = {
  PENDING:        { label: 'Pending', color: '#b45309', bg: '#fef3c7' },
  CONFIRMED:      { label: 'Confirmed', color: '#1d4ed8', bg: '#dbeafe' },
  WAVE_ASSIGNED:  { label: 'Picking', color: '#6d28d9', bg: '#ede9fe' },
  IN_DELIVERY:    { label: 'In Delivery', color: '#0891b2', bg: '#cffafe' },
  COMPLETED:      { label: 'Completed', color: '#15803d', bg: '#dcfce7' },
  LOCKED:         { label: 'Locked', color: '#374151', bg: '#e5e7eb' },
  CANCELLED:      { label: 'Cancelled', color: '#dc2626', bg: '#fee2e2' },
}

const STATUS_TABS = ['ALL', 'PENDING', 'CONFIRMED', 'IN_DELIVERY', 'COMPLETED'] as const

interface Order {
  id: string
  code: string
  status: string
  totalAmount: number
  paymentMethod: string
  deliveryDate: string | null
  createdAt: string
  items: unknown
  lines: Array<{
    id: string
    productName: string
    spec: string | null
    uomName: string | null
    unitPrice: number
    orderedQty: number
    deliveredQty: number
    subtotal: number
  }>
}

export default function CustomerOrdersPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>('ALL')
  const [search, setSearch] = useState('')

  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const STATUS_MAP = isEn ? STATUS_MAP_EN : STATUS_MAP_ZH

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('pageSize', '20')
      if (statusFilter !== 'ALL') params.set('status', statusFilter)
      if (search.trim()) params.set('search', search.trim())
      const data = await apiGet<{ data: Order[]; total: number; totalPages: number }>(
        `/api/customer-portal/orders?${params}`
      )
      setOrders(data.data || [])
      setTotal(data.total)
      setTotalPages(data.totalPages)
    } catch {
      toast.error(isEn ? 'Failed to load orders' : '加载订单失败')
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter, search, isEn])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold" style={{ color: PURPLE }}>{isEn ? 'My Orders' : '我的订单'}</h1>

      {/* Status tabs */}
      <div className="flex gap-2 flex-wrap">
        {STATUS_TABS.map(s => (
          <button key={s}
            onClick={() => { setStatusFilter(s); setPage(1) }}
            className="px-3 py-1.5 rounded-full text-xs font-medium transition-colors border"
            style={statusFilter === s
              ? { background: PURPLE, color: 'white', borderColor: PURPLE }
              : { borderColor: '#ddd', color: '#666' }
            }>
            {s === 'ALL' ? (isEn ? 'All' : '全部') : STATUS_MAP[s]?.label || s}
          </button>
        ))}
      </div>

      {/* Search */}
      <input type="text" value={search}
        onChange={e => { setSearch(e.target.value); setPage(1) }}
        placeholder={isEn ? 'Search order number...' : '搜索订单编号...'}
        className="w-full border rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2"
        style={{ borderColor: '#ddd' }}
      />

      {/* Order list */}
      {loading ? (
        <div className="text-center py-16 text-gray-400">{isEn ? 'Loading...' : '加载中...'}</div>
      ) : orders.length === 0 ? (
        <div className="text-center py-16 text-gray-400">{isEn ? 'No orders yet' : '暂无订单'}</div>
      ) : (
        <div className="space-y-3">
          {orders.map(order => {
            const st = STATUS_MAP[order.status] || { label: order.status, color: '#666', bg: '#eee' }
            return (
              <Link key={order.id} href={`${prefix}/customer-portal/orders/${order.id}`}
                className="block bg-white rounded-xl border p-4 hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{order.code || order.id.slice(0, 8)}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                        style={{ background: st.bg, color: st.color }}>
                        {st.label}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                      {isEn ? 'Placed' : '下单'}: {formatDateOnly(order.createdAt)}
                      {order.deliveryDate && <span> · {isEn ? 'Delivery' : '配送'}: {formatDateOnly(order.deliveryDate)}</span>}
                      <span> · {order.paymentMethod === 'CASH' ? (isEn ? 'Cash' : '现金') : (isEn ? 'Online Payment' : '在线支付')}</span>
                    </p>
                  </div>
                  <span className="text-lg font-bold" style={{ color: PURPLE }}>
                    €{Number(order.totalAmount).toFixed(2)}
                  </span>
                </div>
                {order.lines && order.lines.length > 0 && (
                  <div className="mt-2 text-xs text-gray-500">
                    {order.lines.slice(0, 3).map(l => l.productName).join(isEn ? ', ' : '、')}
                    {order.lines.length > 3 && (isEn ? ` and ${order.lines.length} items total` : ` 等${order.lines.length}项`)}
                  </div>
                )}
              </Link>
            )
          })}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center gap-2 pt-4">
              <button onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 border rounded text-sm disabled:opacity-30">
                {isEn ? 'Previous' : '上一页'}
              </button>
              <span className="px-3 py-1.5 text-sm text-gray-500">{page} / {totalPages} {isEn ? `(${total} orders)` : `(共${total}单)`}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1.5 border rounded text-sm disabled:opacity-30">
                {isEn ? 'Next' : '下一页'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
