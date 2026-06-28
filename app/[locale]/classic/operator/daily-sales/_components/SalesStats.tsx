'use client'
import { Fragment, useState, useEffect, useMemo, useRef } from 'react'
import { usePathname } from 'next/navigation'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { apiGet } from '@/lib/api'
import type { Order } from '@/lib/types'
import { formatDriverSlotFromOrder, parseDriverSlotKey } from '@/lib/driver-slot'
import { toggleValue, today } from './shared'

interface CustomerRow { id: string; name: string; street?: string; city?: string; notes?: string; pricelist?: string }
interface ProductRow { id: string; name: string; salePrice?: number; category?: string }
interface UserRow { id: string; name: string }
interface CategoryRow { id: string; name: string }
interface OrderLine { id: string; productId?: string | null; productName?: string | null; orderedQty?: number | null; subtotal?: number | null }

// ─── Chart helpers ─────────────────────────────────────────────────────────────

const CHART_COLORS = ['#875A7B', '#4B6BFB', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6']

function dateGroupKey(d: string, g: 'day' | 'week' | 'month'): string {
  if (g === 'day') return d
  if (g === 'month') return d.slice(0, 7)
  const dt = new Date(d + 'T12:00:00Z')
  const dow = dt.getUTCDay() || 7
  dt.setUTCDate(dt.getUTCDate() - dow + 1)
  return dt.toISOString().slice(0, 10)
}

function dateGroupLabel(key: string, g: 'day' | 'week' | 'month'): string {
  if (g === 'day') return key.slice(5).replace('-', '/')
  if (g === 'month') {
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(key.slice(5)) - 1] ?? key
  }
  const dt = new Date(key + 'T12:00:00Z')
  return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`
}

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

  // Independent 28-day stats fetch for trend charts
  const [statsOrders, setStatsOrders] = useState<Order[]>([])
  const [statsLoading, setStatsLoading] = useState(false)
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('day')
  const [showCategoryOverlay, setShowCategoryOverlay] = useState(false)

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

  // Load past 28 days for trend analysis (independent, loads once)
  useEffect(() => {
    const to = today()
    const fromDt = new Date()
    fromDt.setDate(fromDt.getDate() - 27)
    const from = fromDt.toISOString().slice(0, 10)
    setStatsLoading(true)
    apiGet<Order[]>(
      `/api/orders?status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY,COMPLETED&dateField=deliveryDate&fromDate=${from}&toDate=${to}`
    )
      .then(d => setStatsOrders(Array.isArray(d) ? d : []))
      .catch(() => setStatsOrders([]))
      .finally(() => setStatsLoading(false))
  }, [])

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

  // product id → ProductRow map for category lookup
  const productMap = useMemo(() => {
    const m = new Map<string, ProductRow>()
    for (const p of allProducts) m.set(p.id, p)
    return m
  }, [allProducts])

  // Top 5 categories by 28-day revenue
  const topCategories = useMemo(() => {
    const rev = new Map<string, number>()
    for (const o of statsOrders) {
      for (const l of ((o as Order & { lines?: OrderLine[] }).lines ?? [])) {
        const cat = (l.productId ? productMap.get(l.productId)?.category : null) ?? '未分类'
        rev.set(cat, (rev.get(cat) ?? 0) + Number(l.subtotal ?? 0))
      }
    }
    return [...rev.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name)
  }, [statsOrders, productMap])

  // Chart data aggregated by granularity
  const chartData = useMemo(() => {
    const buckets = new Map<string, { total: number; cats: Record<string, number> }>()
    for (const o of statsOrders) {
      const date = (o.deliveryDate as string | undefined)?.slice(0, 10) ?? ''
      if (!date) continue
      const key = dateGroupKey(date, granularity)
      if (!buckets.has(key)) buckets.set(key, { total: 0, cats: {} })
      const b = buckets.get(key)!
      for (const l of ((o as Order & { lines?: OrderLine[] }).lines ?? [])) {
        const sub = Number(l.subtotal ?? 0)
        b.total += sub
        if (showCategoryOverlay) {
          const cat = (l.productId ? productMap.get(l.productId)?.category : null) ?? '未分类'
          if (topCategories.includes(cat)) b.cats[cat] = (b.cats[cat] ?? 0) + sub
        }
      }
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, b]) => ({
        label: dateGroupLabel(key, granularity),
        total: Math.round(b.total),
        ...Object.fromEntries(topCategories.map(c => [c, Math.round(b.cats[c] ?? 0)])),
      }))
  }, [statsOrders, granularity, showCategoryOverlay, topCategories, productMap])

  // Category ranking over the 28-day period
  const catRanking = useMemo(() => {
    const rev = new Map<string, { qty: number; amount: number }>()
    for (const o of statsOrders) {
      for (const l of ((o as Order & { lines?: OrderLine[] }).lines ?? [])) {
        const cat = (l.productId ? productMap.get(l.productId)?.category : null) ?? '未分类'
        const cur = rev.get(cat) ?? { qty: 0, amount: 0 }
        cur.qty += Number(l.orderedQty ?? 0)
        cur.amount += Number(l.subtotal ?? 0)
        rev.set(cat, cur)
      }
    }
    const total = [...rev.values()].reduce((s, v) => s + v.amount, 0)
    return [...rev.entries()]
      .sort(([, a], [, b]) => b.amount - a.amount)
      .map(([name, v]) => ({ name, qty: v.qty, amount: v.amount, pct: total > 0 ? v.amount / total : 0 }))
  }, [statsOrders, productMap])

  // Purchase suggestions: past 14 days only, ceil(avgDaily * 7 * 1.1)
  const purchaseSuggestions = useMemo(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 13)
    const cutoffStr = cutoff.toISOString().slice(0, 10)
    const recent = statsOrders.filter(o => {
      const d = (o.deliveryDate as string | undefined)?.slice(0, 10) ?? ''
      return d >= cutoffStr
    })
    const prodQty = new Map<string, { name: string; category: string; qty: number }>()
    for (const o of recent) {
      for (const l of ((o as Order & { lines?: OrderLine[] }).lines ?? [])) {
        if (!l.productId) continue
        const cat = productMap.get(l.productId)?.category ?? '未分类'
        const name = l.productName ?? productMap.get(l.productId)?.name ?? l.productId
        const cur = prodQty.get(l.productId) ?? { name, category: cat, qty: 0 }
        cur.qty += Number(l.orderedQty ?? 0)
        prodQty.set(l.productId, cur)
      }
    }
    return [...prodQty.entries()]
      .map(([id, v]) => ({
        id,
        name: v.name,
        category: v.category,
        suggested: Math.ceil((v.qty / 14) * 7 * 1.1),
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || b.suggested - a.suggested)
  }, [statsOrders, productMap])

  function exportSuggestions() {
    const header = '品类,商品名称,建议采购量\n'
    const rows = purchaseSuggestions.map(r => `${r.category},${r.name},${r.suggested}`).join('\n')
    const blob = new Blob(['﻿' + header + rows], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `purchase-suggestions-${today()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

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
      <div className="px-6 py-4 flex items-center gap-3 border-b border-gray-200">
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

      {/* ── Sales Trend Chart ── */}
      <div className="border-b border-gray-200">
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            近 28 天销售趋势
            {statsLoading && <span className="ml-2 font-normal text-gray-400 normal-case">加载中…</span>}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCategoryOverlay(v => !v)}
              className={`px-2.5 py-1 text-xs rounded border transition-colors ${showCategoryOverlay ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'border-gray-300 text-gray-600'}`}
            >
              品类分层
            </button>
            <div className="flex rounded border border-gray-200 overflow-hidden text-xs">
              {(['day', 'week', 'month'] as const).map(g => (
                <button
                  key={g}
                  onClick={() => setGranularity(g)}
                  className={`px-2.5 py-1 transition-colors ${granularity === g ? 'bg-[#875A7B] text-white' : 'text-gray-500 hover:bg-gray-50'}`}
                >
                  {g === 'day' ? '日' : g === 'week' ? '周' : '月'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="p-4">
          {chartData.length === 0 && !statsLoading ? (
            <div className="h-40 flex items-center justify-center text-gray-400 text-sm">暂无数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={52} tickFormatter={v => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`} />
                <Tooltip formatter={(v) => [`$${Number(v ?? 0).toFixed(0)}`, '']} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="total" name="总销售额" stroke={CHART_COLORS[0]} strokeWidth={2} dot={false} />
                {showCategoryOverlay && topCategories.map((cat, i) => (
                  <Line key={cat} type="monotone" dataKey={cat} name={cat} stroke={CHART_COLORS[i + 1] ?? '#999'} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ── Category Ranking ── */}
      <div className="border-b border-gray-200">
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-200">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">品类销售排名（近 28 天）</span>
        </div>
        {catRanking.length === 0 ? (
          <div className="px-5 py-6 text-gray-400 text-sm text-center">暂无数据</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-5 py-2 text-left text-xs font-medium text-gray-400">品类</th>
                <th className="px-5 py-2 text-right text-xs font-medium text-gray-400">销量</th>
                <th className="px-5 py-2 text-right text-xs font-medium text-gray-400">销售额</th>
                <th className="px-5 py-2 text-left text-xs font-medium text-gray-400 w-40">占比</th>
              </tr>
            </thead>
            <tbody>
              {catRanking.map(row => (
                <tr key={row.name} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-5 py-2 text-gray-800">{row.name}</td>
                  <td className="px-5 py-2 text-right text-gray-600">{row.qty.toFixed(0)}</td>
                  <td className="px-5 py-2 text-right text-gray-600">${row.amount.toFixed(0)}</td>
                  <td className="px-5 py-2">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-[#875A7B]" style={{ width: `${(row.pct * 100).toFixed(1)}%` }} />
                      </div>
                      <span className="text-xs text-gray-400 w-10 text-right">{(row.pct * 100).toFixed(1)}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Purchase Suggestions ── */}
      <div>
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">采购建议</span>
            <span className="ml-2 text-xs text-gray-400">（近 14 天均量 × 7 × 1.1）</span>
          </div>
          {purchaseSuggestions.length > 0 && (
            <button
              onClick={exportSuggestions}
              className="px-3 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:border-[#875A7B] hover:text-[#875A7B] transition-colors"
            >
              导出 CSV
            </button>
          )}
        </div>
        {purchaseSuggestions.length === 0 ? (
          <div className="px-5 py-6 text-gray-400 text-sm text-center">暂无数据</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-5 py-2 text-left text-xs font-medium text-gray-400">品类</th>
                <th className="px-5 py-2 text-left text-xs font-medium text-gray-400">商品</th>
                <th className="px-5 py-2 text-right text-xs font-medium text-gray-400">建议采购量</th>
              </tr>
            </thead>
            <tbody>
              {purchaseSuggestions.map((row, idx) => {
                const prevCat = idx > 0 ? purchaseSuggestions[idx - 1].category : null
                const showCat = row.category !== prevCat
                return (
                  <Fragment key={row.id}>
                    {showCat && (
                      <tr>
                        <td colSpan={3} className="px-5 pt-3 pb-1 text-xs font-semibold text-[#875A7B] bg-purple-50">
                          {row.category}
                        </td>
                      </tr>
                    )}
                    <tr className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-5 py-2 text-gray-400 text-xs" />
                      <td className="px-5 py-2 text-gray-800">{row.name}</td>
                      <td className="px-5 py-2 text-right font-mono text-gray-700">{row.suggested}</td>
                    </tr>
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
