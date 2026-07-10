'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import type { Order, OrderStatus } from '@/lib/types'
import { displayOrderCode } from '@/lib/order-code'
import { formatDriverSlotFromOrder } from '@/lib/driver-slot'
import { formatDateOnly } from '@/lib/format-date'

const PURPLE = '#875A7B'
const BORDER = '#d4b8d0'

const STATUS_LABEL: Record<string, string> = {
  PENDING: '待确认',
  CONFIRMED: '已确认',
  WAVE_ASSIGNED: '拣货中',
  IN_DELIVERY: '配送中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: 'bg-yellow-50 text-yellow-700',
  CONFIRMED: 'bg-blue-50 text-blue-700',
  WAVE_ASSIGNED: 'bg-purple-50 text-purple-700',
  IN_DELIVERY: 'bg-orange-50 text-orange-700',
  COMPLETED: 'bg-green-50 text-green-700',
  CANCELLED: 'bg-red-50 text-red-600',
}

const STATUS_TABS = [
  { key: 'all', label: '全部' },
  { key: 'CONFIRMED', label: '待发货' },
  { key: 'WAVE_ASSIGNED', label: '拣货中' },
  { key: 'IN_DELIVERY', label: '配送中' },
  { key: 'COMPLETED', label: '已完成' },
]

const PAGE_SIZE = 50

export default function InventoryDeliveriesPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [activeTab, setActiveTab] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('pageSize', String(PAGE_SIZE))
      params.set('page', String(page))
      if (activeTab !== 'all') params.set('status', activeTab)
      if (search) params.set('search', search)
      const data = await apiGet<{ data: Order[]; total: number }>(`/api/orders?${params}`)
      setOrders(data.data ?? [])
      setTotal(data.total ?? 0)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [page, search, activeTab])

  useEffect(() => { load() }, [load])

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setSearch(searchInput)
    setPage(1)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <button onClick={() => router.push(`${prefix}/classic/operator/inventory`)} className="hover:underline">
          库存管理
        </button>
        <span>/</span>
        <span style={{ color: PURPLE }}>发货单</span>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold" style={{ color: PURPLE }}>发货单列表</h1>
        <button
          onClick={() => router.push(`${prefix}/classic/operator/orders`)}
          className="px-4 py-1.5 rounded text-sm font-medium text-white"
          style={{ background: PURPLE }}
        >
          查看销售订单
        </button>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 border-b" style={{ borderColor: BORDER }}>
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => { setActiveTab(tab.key); setPage(1) }}
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
          placeholder="搜索订单号或客户名称..."
          className="border rounded px-3 py-1.5 text-sm flex-1 outline-none"
          style={{ borderColor: BORDER }}
        />
        <button type="submit" className="px-4 py-1.5 rounded text-sm font-medium text-white" style={{ background: PURPLE }}>
          搜索
        </button>
        {search && (
          <button type="button" onClick={() => { setSearch(''); setSearchInput(''); setPage(1) }} className="px-3 py-1.5 rounded text-sm text-gray-500 border" style={{ borderColor: BORDER }}>
            清除
          </button>
        )}
      </form>

      <div className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: BORDER }}>
        <div className="grid gap-3 px-4 py-2.5 text-xs font-semibold border-b"
          style={{ borderColor: BORDER, color: PURPLE, background: '#faf5fb', gridTemplateColumns: '140px 1fr 100px 100px 100px 100px' }}>
          <span>订单号</span>
          <span>客户</span>
          <span>配送日期</span>
          <span>批次</span>
          <span>金额</span>
          <span>状态</span>
        </div>

        {loading && <div className="py-12 text-center text-sm text-gray-400">加载中…</div>}

        {!loading && orders.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-400">
            {search ? `未找到"${search}"相关发货单` : '暂无数据'}
          </div>
        )}

        {!loading && orders.map((order) => (
          <div
            key={order.id}
            className="grid gap-3 px-4 py-3 border-b last:border-b-0 items-center hover:bg-[#875A7B]/20 cursor-pointer transition-colors"
            style={{ borderColor: '#f0e4ee', gridTemplateColumns: '140px 1fr 100px 100px 100px 100px' }}
            onClick={() => router.push(`${prefix}/classic/operator/orders/${order.id}`)}
          >
            <span className="font-mono text-sm font-semibold" style={{ color: PURPLE }}>
              {displayOrderCode(order)}
            </span>
            <span className="text-sm text-gray-700 truncate">{order.restaurantName}</span>
            <span className="text-xs text-gray-500">{formatDateOnly((order as unknown as { deliveryDate?: string }).deliveryDate)}</span>
            <span className="text-xs text-gray-500 truncate">{formatDriverSlotFromOrder(order) || '—'}</span>
            <span className="text-sm font-medium">€{Number(order.totalAmount ?? 0).toFixed(2)}</span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[order.status as string] ?? 'bg-gray-100 text-gray-600'}`}>
              {STATUS_LABEL[order.status as string] ?? order.status}
            </span>
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>共 {total} 条</span>
          <div className="flex gap-1">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1 rounded border disabled:opacity-40" style={{ borderColor: BORDER }}>上一页</button>
            <span className="px-3 py-1">第 {page} / {totalPages} 页</span>
            <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="px-3 py-1 rounded border disabled:opacity-40" style={{ borderColor: BORDER }}>下一页</button>
          </div>
        </div>
      )}
    </div>
  )
}
