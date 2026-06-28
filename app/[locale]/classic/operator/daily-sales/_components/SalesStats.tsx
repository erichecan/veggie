'use client'
import { useState, useEffect, useMemo, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { apiGet } from '@/lib/api'
import type { Order } from '@/lib/types'
import { formatDriverSlotFromOrder, parseDriverSlotKey } from '@/lib/driver-slot'
import { ChipMultiSelect, toggleValue, today } from './shared'

interface CustomerRow { id: string; name: string; street?: string; city?: string; notes?: string; pricelist?: string }
interface ProductRow { id: string; name: string; salePrice?: number; category?: string }
interface UserRow { id: string; name: string }
interface CategoryRow { id: string; name: string }

// ─── Table-embedded inline search ─────────────────────────────────────────────

function TableInlineSearch<T extends { id: string; name: string }>({
  allItems,
  selectedIds,
  onAdd,
  placeholder,
  colSpan,
}: {
  allItems: T[]
  selectedIds: string[]
  onAdd: (item: T) => void
  placeholder: string
  colSpan: number
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLTableRowElement>(null)

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return allItems
      .filter(i => !selectedIds.includes(i.id) && (q === '' || i.name.toLowerCase().includes(q)))
      .slice(0, 12)
  }, [allItems, selectedIds, query])

  useEffect(() => {
    if (!open) return
    function onOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false); setQuery('')
      }
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocused(f => Math.min(f + 1, filtered.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setFocused(f => Math.max(f - 1, 0)) }
    if (e.key === 'Enter' && filtered[focused]) {
      onAdd(filtered[focused]); setQuery(''); setFocused(0)
    }
    if (e.key === 'Escape') { setOpen(false); setQuery('') }
  }

  return (
    <tr ref={containerRef}>
      <td colSpan={colSpan + 1} className="px-4 py-2">
        {!open ? (
          <button
            className="text-xs text-[#875A7B] hover:underline"
            onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0) }}
          >
            + 添加筛选项
          </button>
        ) : (
          <div className="relative">
            <input
              ref={inputRef}
              value={query}
              onChange={e => { setQuery(e.target.value); setFocused(0) }}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className="border border-[#875A7B] rounded px-2 py-0.5 text-xs w-52 focus:outline-none"
            />
            {filtered.length > 0 && (
              <div className="absolute z-50 mt-1 bg-white border border-gray-200 rounded shadow-lg min-w-[220px] max-h-60 overflow-y-auto">
                {filtered.map((item, i) => (
                  <button
                    key={item.id}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-purple-50 ${i === focused ? 'bg-purple-50' : ''}`}
                    onMouseEnter={() => setFocused(i)}
                    onClick={() => { onAdd(item); setQuery(''); setFocused(0) }}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </td>
    </tr>
  )
}

// ─── SalesStats ───────────────────────────────────────────────────────────────

export default function SalesStats() {
  const pathname = usePathname()
  const prefix = pathname.match(/^(\/[a-z]{2}(-[A-Z]{2})?)/)?.[1] ?? ''

  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const [selectedSalesman, setSelectedSalesman] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>([])
  const [selectedTimes, setSelectedTimes] = useState<string[]>([])
  const [selectedBatchNums, setSelectedBatchNums] = useState<number[]>([])
  const [selectedCustomers, setSelectedCustomers] = useState<CustomerRow[]>([])
  const [selectedProducts, setSelectedProducts] = useState<ProductRow[]>([])

  const [allCustomers, setAllCustomers] = useState<CustomerRow[]>([])
  const [allProducts, setAllProducts] = useState<ProductRow[]>([])
  const [allSalesmen, setAllSalesmen] = useState<UserRow[]>([])
  const [allCategories, setAllCategories] = useState<CategoryRow[]>([])
  const [orders, setOrders] = useState<Order[]>([])

  // Load reference data once
  useEffect(() => {
    apiGet<CustomerRow[]>('/api/customers?limit=500').then(d => setAllCustomers(Array.isArray(d) ? d : [])).catch(() => {})
    apiGet<ProductRow[]>('/api/products?limit=500').then(d => setAllProducts(Array.isArray(d) ? d : [])).catch(() => {})
    apiGet<UserRow[]>('/api/users').then(d => setAllSalesmen(Array.isArray(d) ? d : [])).catch(() => {})
    apiGet<CategoryRow[]>('/api/product-categories').then(d => setAllCategories(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  // Load orders whenever date range changes (for batch chip population)
  useEffect(() => {
    if (!fromDate || !toDate) return
    apiGet<Order[]>(
      `/api/orders?status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY,COMPLETED&dateField=deliveryDate&fromDate=${fromDate}&toDate=${toDate}`
    )
      .then(d => setOrders(Array.isArray(d) ? d : []))
      .catch(() => setOrders([]))
  }, [fromDate, toDate])

  const batchFilterOptions = useMemo(() => {
    const drivers = new Set<string>()
    const times = new Set<string>()
    const nums = new Set<number>()
    for (const o of orders) {
      const key = formatDriverSlotFromOrder(o)
      if (!key) continue
      const p = parseDriverSlotKey(key)
      if (p.driver) drivers.add(p.driver)
      if (p.time) times.add(p.time)
      if (p.num) nums.add(p.num)
    }
    return {
      drivers: [...drivers].sort(),
      times: [...times].sort(),
      nums: [...nums].sort((a, b) => a - b),
    }
  }, [orders])

  function buildUrl(mode: 'day' | 'multiline' | 'summary') {
    const params = new URLSearchParams({ mode, from: fromDate, to: toDate })
    if (selectedCustomers.length > 0) params.set('customerIds', selectedCustomers.map(c => c.id).join(','))
    if (selectedProducts.length > 0) params.set('productNames', selectedProducts.map(p => p.name).join(','))
    if (selectedDrivers.length > 0) params.set('drivers', selectedDrivers.join(','))
    if (selectedTimes.length > 0) params.set('times', selectedTimes.join(','))
    if (selectedBatchNums.length > 0) params.set('batchNums', selectedBatchNums.join(','))
    if (selectedCategory) params.set('categoryId', selectedCategory)
    if (selectedSalesman) params.set('salesman', selectedSalesman)
    return `${prefix}/classic/print/day-wise-report?${params.toString()}`
  }

  const selectCls = 'border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-purple-400 bg-white'

  return (
    <div className="max-w-4xl space-y-0 bg-white rounded-lg border border-gray-200 overflow-hidden">

      {/* Filters */}
      <div className="p-5 border-b border-gray-200 space-y-3">
        {/* Date range + selects */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-3">
          <div className="flex items-center gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0">From</label>
            <input
              type="date"
              value={fromDate}
              max={toDate}
              onChange={e => setFromDate(e.target.value)}
              className={`${selectCls} flex-1`}
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0">To</label>
            <input
              type="date"
              value={toDate}
              min={fromDate}
              onChange={e => setToDate(e.target.value)}
              className={`${selectCls} flex-1`}
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0">Salesman</label>
            <select value={selectedSalesman} onChange={e => setSelectedSalesman(e.target.value)} className={`${selectCls} flex-1`}>
              <option value="">全部业务员</option>
              {allSalesmen.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0">Product Category</label>
            <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)} className={`${selectCls} flex-1`}>
              <option value="">全部分类</option>
              {allCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>

        {/* Batch chips */}
        <div className="space-y-2 pt-2 border-t border-dashed border-gray-100">
          <div className="flex items-start gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0 pt-1">司机</label>
            <div className="flex gap-1.5 flex-wrap">
              <button
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedDrivers.length === 0 ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-gray-400 border-gray-200'}`}
                onClick={() => setSelectedDrivers([])}
              >全部司机</button>
              {batchFilterOptions.drivers.map(d => (
                <button
                  key={d}
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedDrivers.includes(d) ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-[#875A7B] border-[#d4b8d0]'}`}
                  onClick={() => setSelectedDrivers(prev => toggleValue(prev, d))}
                >{d}</button>
              ))}
            </div>
          </div>
          <div className="flex items-start gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0 pt-1">AM / PM</label>
            <div className="flex gap-1.5 flex-wrap">
              <button
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedTimes.length === 0 ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-gray-400 border-gray-200'}`}
                onClick={() => setSelectedTimes([])}
              >全部时段</button>
              {batchFilterOptions.times.map(t => (
                <button
                  key={t}
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedTimes.includes(t) ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-[#875A7B] border-[#d4b8d0]'}`}
                  onClick={() => setSelectedTimes(prev => toggleValue(prev, t))}
                >{t.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <div className="flex items-start gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0 pt-1">批次</label>
            <div className="flex gap-1.5 flex-wrap">
              <button
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedBatchNums.length === 0 ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-gray-400 border-gray-200'}`}
                onClick={() => setSelectedBatchNums([])}
              >全部批次</button>
              {batchFilterOptions.nums.map(n => (
                <button
                  key={n}
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedBatchNums.includes(n) ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-[#875A7B] border-[#d4b8d0]'}`}
                  onClick={() => setSelectedBatchNums(prev => toggleValue(prev, n))}
                >#{n}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Customers table */}
      <div className="border-b border-gray-200">
        <div className="px-5 py-2 bg-gray-50 border-b border-gray-200">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Customers</span>
          {selectedCustomers.length === 0 && (
            <span className="ml-2 text-xs text-gray-400">（留空 = 全部客户）</span>
          )}
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 w-8" />
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Name</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Street</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">City</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Notes</th>
            </tr>
          </thead>
          <tbody>
            {selectedCustomers.map(c => (
              <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50">
                <td className="px-4 py-2 text-center">
                  <button
                    onClick={() => setSelectedCustomers(prev => prev.filter(x => x.id !== c.id))}
                    className="text-gray-300 hover:text-red-400 text-base leading-none"
                  >×</button>
                </td>
                <td className="px-4 py-2 text-gray-800">{c.name}</td>
                <td className="px-4 py-2 text-gray-400">{c.street ?? '–'}</td>
                <td className="px-4 py-2 text-gray-400">{c.city ?? '–'}</td>
                <td className="px-4 py-2 text-gray-400">{c.notes ?? '–'}</td>
              </tr>
            ))}
            <TableInlineSearch<CustomerRow>
              allItems={allCustomers}
              selectedIds={selectedCustomers.map(c => c.id)}
              onAdd={item => setSelectedCustomers(prev => [...prev, item])}
              placeholder="搜索客户…"
              colSpan={4}
            />
          </tbody>
        </table>
      </div>

      {/* Products table */}
      <div className="border-b border-gray-200">
        <div className="px-5 py-2 bg-gray-50 border-b border-gray-200">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Products</span>
          {selectedProducts.length === 0 && (
            <span className="ml-2 text-xs text-gray-400">（留空 = 全部商品）</span>
          )}
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 w-8" />
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Name</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-gray-400">Sale Price</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Category</th>
            </tr>
          </thead>
          <tbody>
            {selectedProducts.map(p => (
              <tr key={p.id} className="border-b border-gray-50 hover:bg-gray-50">
                <td className="px-4 py-2 text-center">
                  <button
                    onClick={() => setSelectedProducts(prev => prev.filter(x => x.id !== p.id))}
                    className="text-gray-300 hover:text-red-400 text-base leading-none"
                  >×</button>
                </td>
                <td className="px-4 py-2 text-gray-800">{p.name}</td>
                <td className="px-4 py-2 text-right text-gray-600">
                  {p.salePrice != null ? `$${Number(p.salePrice).toFixed(2)}` : '–'}
                </td>
                <td className="px-4 py-2 text-gray-400">{p.category ?? '–'}</td>
              </tr>
            ))}
            <TableInlineSearch<ProductRow>
              allItems={allProducts}
              selectedIds={selectedProducts.map(p => p.id)}
              onAdd={item => setSelectedProducts(prev => [...prev, item])}
              placeholder="搜索商品…"
              colSpan={3}
            />
          </tbody>
        </table>
      </div>

      {/* Print buttons */}
      <div className="px-6 py-4 flex items-center gap-3">
        <button
          onClick={() => window.open(buildUrl('day'), '_blank')}
          className="px-5 py-2 text-sm font-semibold text-white rounded"
          style={{ background: '#875A7B' }}
        >
          Print
        </button>
        <button
          onClick={() => window.open(buildUrl('multiline'), '_blank')}
          className="px-5 py-2 text-sm font-semibold rounded border"
          style={{ borderColor: '#875A7B', color: '#875A7B' }}
        >
          Print Multi Line
        </button>
        <button
          onClick={() => window.open(buildUrl('summary'), '_blank')}
          className="px-5 py-2 text-sm font-semibold rounded border border-gray-300 text-gray-600"
        >
          Print Sale Summary
        </button>
      </div>
    </div>
  )
}
