'use client'
import type { ReactNode } from 'react'
import type { Order } from '@/lib/types'
import { displayOrderCode } from '@/lib/order-code'
import { formatDateOnly } from '@/lib/format-date'

interface Props {
  orders: Order[]
  selected: Set<string>
  loading: boolean
  isEn: boolean
  statusLabels: Record<string, string>
  statusColors: Record<string, string>
  onSelect: (id: string, checked: boolean) => void
  onOpen: (order: Order) => void
  renderExtra?: (order: Order) => ReactNode
  sortOptions: { key: string; label: string }[]
  sortKey: string
  sortDir: string
  onSort: (key: string, direction: 'asc' | 'desc') => void
  groupLabel?: (order: Order) => string
  filterControls?: ReactNode
}

export default function OrderMobileList({ orders, selected, loading, isEn, statusLabels, statusColors, onSelect, onOpen, renderExtra, sortOptions, sortKey, sortDir, onSort, groupLabel, filterControls }: Props) {
  return (
    <div className="md:hidden p-3 space-y-3" aria-busy={loading}>
      {filterControls && <details className="rounded border bg-white p-3 text-sm"><summary className="cursor-pointer">{isEn ? 'Date filters' : '日期筛选'}</summary><div className="mt-3 grid grid-cols-1 gap-2">{filterControls}</div></details>}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2 min-h-11"><input type="checkbox" checked={orders.length > 0 && orders.every(order => selected.has(order.id))} onChange={event => orders.forEach(order => onSelect(order.id, event.target.checked))} />{isEn ? 'Select all' : '全选'}</label>
        <select aria-label={isEn ? 'Sort by' : '排序字段'} value={sortKey} onChange={event => onSort(event.target.value, sortDir === 'desc' ? 'desc' : 'asc')} className="min-h-11 border rounded px-2 min-w-0 flex-1">{sortOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select>
        <button className="min-h-11 px-3 border rounded" onClick={() => onSort(sortKey, sortDir === 'desc' ? 'asc' : 'desc')}>{sortDir === 'desc' ? '↓' : '↑'}</button>
      </div>
      {loading && <p className="text-sm text-gray-500" role="status">{isEn ? 'Loading…' : '加载中…'}</p>}
      {!loading && orders.length === 0 && <p className="py-8 text-center text-gray-500">{isEn ? 'No orders' : '暂无订单'}</p>}
      {orders.map(order => (
        <article key={order.id} className={`rounded-xl border p-3 space-y-3 ${selected.has(order.id) ? 'border-purple-300 bg-purple-50' : 'border-gray-200 bg-white'}`}>
          {groupLabel && <p className="text-xs font-semibold text-gray-500">{groupLabel(order)}</p>}
          <div className="flex items-center gap-2">
            <label className="flex items-center justify-center min-w-11 min-h-11">
              <input type="checkbox" aria-label={`${isEn ? 'Select' : '选择'} ${displayOrderCode(order)}`} checked={selected.has(order.id)} onChange={event => onSelect(order.id, event.target.checked)} className="w-5 h-5 accent-[#875A7B]" />
            </label>
            <button onClick={() => onOpen(order)} className="min-w-0 flex-1 text-left text-[#875A7B] font-semibold break-words min-h-11">{displayOrderCode(order)}</button>
            <span className={`px-2 py-1 text-xs rounded shrink-0 ${statusColors[order.status] ?? 'bg-gray-100 text-gray-600'}`}>{statusLabels[order.status] ?? order.status}</span>
          </div>
          <button onClick={() => onOpen(order)} className="block text-left w-full text-base font-medium break-words">{order.restaurantName}</button>
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <span className="text-gray-500">{isEn ? 'Delivery' : '交货日期'}: {order.deliveryDate ? formatDateOnly(order.deliveryDate) : '—'}</span>
            <span className="font-semibold tabular-nums">€ {order.totalAmount.toFixed(2)}</span>
          </div>
          {order.returnStatus === 'RETURNED' && <span className="text-xs text-orange-700">{isEn ? 'Has Return' : '有退货'}</span>}
          {renderExtra?.(order)}
        </article>
      ))}
    </div>
  )
}
