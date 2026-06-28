'use client'
import { useState, useEffect, useMemo, useRef } from 'react'
import { usePathname } from 'next/navigation'
import {
  LineChart, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart,
} from 'recharts'
import { apiGet } from '@/lib/api'
import type { Order } from '@/lib/types'
import { formatDriverSlotFromOrder, parseDriverSlotKey } from '@/lib/driver-slot'
import { toggleValue, today } from './shared'

interface CustomerRow { id: string; name: string; street?: string; city?: string; notes?: string; pricelist?: string }
interface ProductRow { id: string; name: string; salePrice?: number; category?: string; qtyOnHand?: number; uomName?: string }
interface UserRow { id: string; name: string }
interface CategoryRow { id: string; name: string }
interface OrderLine { id: string; productId?: string | null; productName?: string | null; orderedQty?: number | null; subtotal?: number | null; uomName?: string | null }

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

function periodDates(p: 'week' | 'month' | '4weeks'): [string, string] {
  const t = today()
  if (p === 'week') {
    const dt = new Date()
    const dow = dt.getDay() || 7
    dt.setDate(dt.getDate() - dow + 1)
    return [dt.toISOString().slice(0, 10), t]
  }
  if (p === 'month') {
    const dt = new Date()
    dt.setDate(1)
    return [dt.toISOString().slice(0, 10), t]
  }
  const dt = new Date()
  dt.setDate(dt.getDate() - 27)
  return [dt.toISOString().slice(0, 10), t]
}

const eur = (v: number) => `€${v.toFixed(2)}`

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

  // Dashboard analytics state
  const [dashPeriod, setDashPeriod] = useState<'week' | 'month' | '4weeks' | 'custom'>('4weeks')
  const [dashFrom, setDashFrom] = useState<string>('')
  const [dashTo, setDashTo] = useState<string>('')
  const [dashOrders, setDashOrders] = useState<Order[]>([])
  const [dashLoading, setDashLoading] = useState(false)
  const [dashGranularity, setDashGranularity] = useState<'day' | 'week' | 'month'>('day')
  const [showCategoryOverlay, setShowCategoryOverlay] = useState(false)

  // New views state
  const [statsView, setStatsView] = useState<'daily' | 'weekly'>('daily')
  const [selectedDate, setSelectedDate] = useState(today)
  const [selectedStatsCats, setSelectedStatsCats] = useState<string[]>([])
  const [dailyOrders, setDailyOrders] = useState<Order[]>([])
  const [dailyLoading, setDailyLoading] = useState(false)
  const [showWeeklyAvg, setShowWeeklyAvg] = useState(false)

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

  // Auto-compute dashboard date range from selectedDate (current week + 4 past weeks)
  useEffect(() => {
    const dt = new Date(selectedDate + 'T12:00:00Z')
    const dow = (dt.getUTCDay() + 6) % 7
    const mon = new Date(dt)
    mon.setUTCDate(dt.getUTCDate() - dow)
    const from = new Date(mon)
    from.setUTCDate(mon.getUTCDate() - 28)
    const to = new Date(mon)
    to.setUTCDate(mon.getUTCDate() + 6)
    setDashFrom(from.toISOString().slice(0, 10))
    setDashTo(to.toISOString().slice(0, 10))
  }, [selectedDate])

  // Reload dashboard orders when date range changes
  useEffect(() => {
    if (!dashFrom || !dashTo) return
    setDashLoading(true)
    apiGet<Order[]>(
      `/api/orders?status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY,COMPLETED&dateField=deliveryDate&fromDate=${dashFrom}&toDate=${dashTo}`
    )
      .then(d => setDashOrders(Array.isArray(d) ? d : []))
      .catch(() => setDashOrders([]))
      .finally(() => setDashLoading(false))
  }, [dashFrom, dashTo])

  // Load daily orders for View 1
  useEffect(() => {
    setDailyLoading(true)
    apiGet<Order[]>(
      `/api/orders?status=CONFIRMED&dateField=deliveryDate&fromDate=${selectedDate}&toDate=${selectedDate}`
    )
      .then(d => setDailyOrders(Array.isArray(d) ? d : []))
      .catch(() => setDailyOrders([]))
      .finally(() => setDailyLoading(false))
  }, [selectedDate])

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

  // ── Dashboard analytics ───────────────────────────────────────────────────────

  const productTop10 = useMemo(() => {
    const map = new Map<string, { name: string; category: string; qty: number; exTax: number; incTax: number; customers: Set<string> }>()
    for (const o of dashOrders) {
      for (const l of ((o as Order & { lines?: OrderLine[] }).lines ?? [])) {
        if (!l.productId) continue
        const cat = productMap.get(l.productId)?.category ?? '未分类'
        const e = map.get(l.productId) ?? { name: l.productName ?? l.productId, category: cat, qty: 0, exTax: 0, incTax: 0, customers: new Set<string>() }
        e.qty += Number(l.orderedQty ?? 0)
        e.exTax += Number(l.subtotal ?? 0)
        e.incTax += Number(l.subtotal ?? 0) * (1 + Number((l as OrderLine & { taxRate?: number | null }).taxRate ?? 0))
        e.customers.add(o.restaurantId)
        map.set(l.productId, e)
      }
    }
    return [...map.values()]
      .map(v => ({ ...v, avgUnitPrice: v.qty > 0 ? v.exTax / v.qty : 0, avgPerCustomer: v.customers.size > 0 ? v.qty / v.customers.size : 0, customerCount: v.customers.size }))
      .sort((a, b) => b.exTax - a.exTax)
      .slice(0, 10)
  }, [dashOrders, productMap])

  const categoryTop10 = useMemo(() => {
    const map = new Map<string, { productIds: Set<string>; qty: number; exTax: number; incTax: number }>()
    for (const o of dashOrders) {
      for (const l of ((o as Order & { lines?: OrderLine[] }).lines ?? [])) {
        const cat = (l.productId ? productMap.get(l.productId)?.category : null) ?? '未分类'
        const e = map.get(cat) ?? { productIds: new Set<string>(), qty: 0, exTax: 0, incTax: 0 }
        if (l.productId) e.productIds.add(l.productId)
        e.qty += Number(l.orderedQty ?? 0)
        e.exTax += Number(l.subtotal ?? 0)
        e.incTax += Number(l.subtotal ?? 0) * (1 + Number((l as OrderLine & { taxRate?: number | null }).taxRate ?? 0))
        map.set(cat, e)
      }
    }
    const totalExTax = [...map.values()].reduce((s, v) => s + v.exTax, 0)
    return [...map.entries()]
      .map(([name, v]) => ({ name, productCount: v.productIds.size, qty: v.qty, exTax: v.exTax, incTax: v.incTax, pct: totalExTax > 0 ? v.exTax / totalExTax : 0 }))
      .sort((a, b) => b.exTax - a.exTax)
      .slice(0, 10)
  }, [dashOrders, productMap])

  const customerTop10 = useMemo(() => {
    const map = new Map<string, { name: string; orderCount: number; qty: number; exTax: number; incTax: number }>()
    for (const o of dashOrders) {
      const e = map.get(o.restaurantId) ?? { name: o.restaurantName, orderCount: 0, qty: 0, exTax: 0, incTax: 0 }
      e.orderCount += 1
      for (const l of ((o as Order & { lines?: OrderLine[] }).lines ?? [])) {
        e.qty += Number(l.orderedQty ?? 0)
        e.exTax += Number(l.subtotal ?? 0)
        e.incTax += Number(l.subtotal ?? 0) * (1 + Number((l as OrderLine & { taxRate?: number | null }).taxRate ?? 0))
      }
      map.set(o.restaurantId, e)
    }
    return [...map.values()]
      .map(v => ({ ...v, avgOrderValue: v.orderCount > 0 ? v.exTax / v.orderCount : 0 }))
      .sort((a, b) => b.exTax - a.exTax)
      .slice(0, 10)
  }, [dashOrders])

  const weekdayData = useMemo(() => {
    const DOW_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    const buckets = Array.from({ length: 7 }, (_, i) => ({ day: DOW_LABELS[i], orderCount: 0, exTax: 0, qty: 0 }))
    for (const o of dashOrders) {
      const d = (o.deliveryDate as string | undefined)?.slice(0, 10)
      if (!d) continue
      const dt = new Date(d + 'T12:00:00Z')
      const dow = (dt.getUTCDay() + 6) % 7
      buckets[dow].orderCount += 1
      for (const l of ((o as Order & { lines?: OrderLine[] }).lines ?? [])) {
        buckets[dow].exTax += Number(l.subtotal ?? 0)
        buckets[dow].qty += Number(l.orderedQty ?? 0)
      }
    }
    return buckets.map(b => ({ ...b, avgUnitPrice: b.qty > 0 ? b.exTax / b.qty : 0 }))
  }, [dashOrders])

  const topCategories = useMemo(() => categoryTop10.slice(0, 5).map(c => c.name), [categoryTop10])

  const chartData = useMemo(() => {
    const buckets = new Map<string, { total: number; cats: Record<string, number> }>()
    for (const o of dashOrders) {
      const date = (o.deliveryDate as string | undefined)?.slice(0, 10) ?? ''
      if (!date) continue
      const key = dateGroupKey(date, dashGranularity)
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
        label: dateGroupLabel(key, dashGranularity),
        total: Math.round(b.total),
        ...Object.fromEntries(topCategories.map(c => [c, Math.round(b.cats[c] ?? 0)])),
      }))
  }, [dashOrders, dashGranularity, showCategoryOverlay, topCategories, productMap])

  // ── View 1: 当日分类总量 ─────────────────────────────────────────────────────

  const dailyStats = useMemo(() => {
    const catMap = new Map<string, {
      catName: string
      products: Map<string, { productId: string; name: string; uomName: string; qty: number; qtyOnHand: number }>
    }>()
    for (const o of dailyOrders) {
      for (const l of ((o as Order & { lines?: OrderLine[] }).lines ?? [])) {
        const pid = l.productId ?? ''
        const prod = pid ? productMap.get(pid) : undefined
        const catName = prod?.category ?? '未分类'
        if (!catMap.has(catName)) catMap.set(catName, { catName, products: new Map() })
        const catEntry = catMap.get(catName)!
        const existing = catEntry.products.get(pid)
        if (existing) {
          existing.qty += Number(l.orderedQty ?? 0)
        } else {
          catEntry.products.set(pid, {
            productId: pid,
            name: l.productName ?? pid,
            uomName: l.uomName ?? prod?.uomName ?? '',
            qty: Number(l.orderedQty ?? 0),
            qtyOnHand: Number(prod?.qtyOnHand ?? 0),
          })
        }
      }
    }
    return [...catMap.entries()]
      .map(([catName, entry]) => ({
        catName,
        products: [...entry.products.values()].sort((a, b) => b.qty - a.qty),
      }))
      .sort((a, b) => a.catName.localeCompare(b.catName))
  }, [dailyOrders, productMap])

  const filteredDailyStats = useMemo(() => {
    if (selectedStatsCats.length === 0) return dailyStats
    return dailyStats.filter(c => selectedStatsCats.includes(c.catName))
  }, [dailyStats, selectedStatsCats])

  const dailySummary = useMemo(() => {
    let totalSku = 0; let totalQty = 0
    for (const cat of filteredDailyStats) {
      totalSku += cat.products.length
      for (const p of cat.products) totalQty += p.qty
    }
    return { totalSku, totalQty }
  }, [filteredDailyStats])

  // ── View 2: 周销售趋势 ──────────────────────────────────────────────────────

  const weeklyChartData = useMemo(() => {
    const DOW_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    const now = new Date(selectedDate + 'T12:00:00Z')
    const nowDow = (now.getUTCDay() + 6) % 7
    const thisMon = new Date(now)
    thisMon.setUTCDate(now.getUTCDate() - nowDow)
    thisMon.setUTCHours(0, 0, 0, 0)
    const currentWeek = Array(7).fill(0) as number[]
    const pastWeeks: number[][] = Array.from({ length: 4 }, () => Array(7).fill(0))
    for (const o of dashOrders) {
      const d = (o.deliveryDate as string | undefined)?.slice(0, 10)
      if (!d) continue
      const dt = new Date(d + 'T12:00:00Z')
      const weekday = (dt.getUTCDay() + 6) % 7
      const orderMon = new Date(dt)
      orderMon.setUTCDate(dt.getUTCDate() - (dt.getUTCDay() + 6) % 7)
      orderMon.setUTCHours(0, 0, 0, 0)
      const msPerWeek = 7 * 24 * 60 * 60 * 1000
      const weeksBack = Math.round((thisMon.getTime() - orderMon.getTime()) / msPerWeek)
      const orderTotal = ((o as Order & { lines?: OrderLine[] }).lines ?? [])
        .reduce((s, l) => s + Number(l.subtotal ?? 0), 0)
      if (weeksBack === 0) currentWeek[weekday] += orderTotal
      else if (weeksBack >= 1 && weeksBack <= 4) pastWeeks[weeksBack - 1][weekday] += orderTotal
    }
    const pastAvg = Array(7).fill(0).map((_, i) =>
      Math.round(pastWeeks.reduce((s, w) => s + w[i], 0) / 4)
    )
    return DOW_LABELS.map((day, i) => ({
      day, current: Math.round(currentWeek[i]), avg: pastAvg[i],
    }))
  }, [dashOrders, selectedDate])

  const weeklyConclusion = useMemo(() => {
    const nonZero = weeklyChartData.filter(d => d.current > 0)
    if (nonZero.length === 0) return ''
    const total = weeklyChartData.reduce((s, d) => s + d.current, 0)
    const avgTotal = weeklyChartData.reduce((s, d) => s + d.avg, 0)
    const peak = nonZero.reduce((max, d) => d.current > max.current ? d : max)
    const diffPct = avgTotal > 0 ? ((total - avgTotal) / avgTotal * 100) : null
    const diffText = diffPct !== null
      ? `，较过去4周同期${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(0)}%`
      : ''
    return `本周峰值在${peak.day}（€${peak.current.toFixed(0)}）；本周合计 €${total.toFixed(0)}${diffText}。`
  }, [weeklyChartData])

  function handleDailyPrint() {
    const w = window.open('', '_blank', 'noopener,width=800,height=700')
    if (!w) return
    const catsHtml = filteredDailyStats.map(cat => `
      <div style="margin-bottom:16px;">
        <div style="background:#f3f4f6;padding:6px 12px;font-weight:bold;font-size:13px;border-radius:4px 4px 0 0;">${cat.catName} <span style="font-weight:normal;font-size:11px;color:#6b7280;">${cat.products.length} SKU</span></div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:#f9fafb;">
              <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;">产品名称</th>
              <th style="text-align:center;padding:6px 8px;border-bottom:1px solid #e5e7eb;">单位</th>
              <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #e5e7eb;">确认量</th>
              <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #e5e7eb;">ATP</th>
            </tr>
          </thead>
          <tbody>
            ${cat.products.map(p => {
              const atp = p.qtyOnHand - p.qty
              const color = atp > 0 ? '#10B981' : atp === 0 ? '#F59E0B' : '#EF4444'
              return `<tr style="border-bottom:1px solid #f3f4f6;">
                <td style="padding:5px 8px;">${p.name}</td>
                <td style="padding:5px 8px;text-align:center;color:#6b7280;">${p.uomName || '—'}</td>
                <td style="padding:5px 8px;text-align:right;font-weight:500;">${p.qty % 1 === 0 ? p.qty.toFixed(0) : p.qty.toFixed(2)}</td>
                <td style="padding:5px 8px;text-align:right;color:${color};font-weight:500;">${atp % 1 === 0 ? atp.toFixed(0) : atp.toFixed(2)}</td>
              </tr>`
            }).join('')}
          </tbody>
        </table>
      </div>
    `).join('')
    w.document.write(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>今日总量 · ${selectedDate}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#fff;padding:20px}@media print{@page{margin:1cm}body{padding:0}}</style>
</head><body>
<div style="margin-bottom:16px;padding-bottom:12px;border-bottom:1px dashed #e5e7eb;font-size:12px;color:#6b7280;">
  <b style="font-size:15px;color:#111;">今日总量</b>&nbsp;&nbsp;日期：<b style="color:#111;">${selectedDate}</b>&nbsp;&nbsp;合计：<b style="color:#111;">${dailySummary.totalSku} SKU · ${dailySummary.totalQty % 1 === 0 ? dailySummary.totalQty.toFixed(0) : dailySummary.totalQty.toFixed(2)} 件</b>
</div>
${catsHtml}
<script>window.print();<\/script>
</body></html>`)
    w.document.close()
    w.focus()
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

      {/* ── New Views: 当日分类总量 / 周销售趋势 ── */}
      <div className="border-t border-gray-200">

        {/* Shared header: date picker + view toggle */}
        <div className="px-5 py-3 flex items-center gap-4 bg-gray-50 border-b border-gray-200">
          <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} className={selectCls} />
          <div className="flex items-center gap-2">
            {(['daily', 'weekly'] as const).map(v => (
              <button
                key={v}
                onClick={() => setStatsView(v)}
                className={`px-4 py-1.5 text-xs font-medium rounded border transition-colors ${
                  statsView === v ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-gray-600 border-gray-300 hover:border-[#875A7B]'
                }`}
              >
                {v === 'daily' ? '今日总量' : '周趋势'}
              </button>
            ))}
          </div>
          {dailyLoading && statsView === 'daily' && <span className="text-xs text-gray-400">加载中…</span>}
          {dashLoading && statsView === 'weekly' && <span className="text-xs text-gray-400">数据加载中…</span>}
        </div>

        {/* View 1: 今日总量 */}
        {statsView === 'daily' && (
          <div className="p-5 space-y-4">
            {dailyStats.length > 0 && (
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2 flex-1 min-w-0">
                  <label className="text-xs text-gray-500 shrink-0 pt-1">分类</label>
                  <div className="flex gap-1.5 flex-wrap">
                    <button onClick={() => setSelectedStatsCats([])} className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedStatsCats.length === 0 ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-gray-400 border-gray-200'}`}>全部</button>
                    {dailyStats.map(c => (
                      <button key={c.catName} onClick={() => setSelectedStatsCats(prev => toggleValue(prev, c.catName))}
                        className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedStatsCats.includes(c.catName) ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-[#875A7B] border-[#d4b8d0]'}`}
                      >{c.catName}</button>
                    ))}
                  </div>
                </div>
                <button
                  onClick={handleDailyPrint}
                  className="px-3 py-1.5 text-xs rounded border border-gray-300 text-gray-600 hover:border-[#875A7B] hover:text-[#875A7B] transition-colors shrink-0"
                >打印</button>
              </div>
            )}
            {filteredDailyStats.length === 0 ? (
              <div className="py-8 text-center text-gray-400 text-sm">该日期暂无已确认订单</div>
            ) : (
              <div className="space-y-4">
                {filteredDailyStats.map(cat => (
                  <div key={cat.catName} className="rounded-lg border border-gray-100 overflow-hidden">
                    <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                      <span className="text-xs font-semibold text-gray-600 uppercase tracking-wider">{cat.catName}</span>
                      <span className="text-xs text-gray-400">{cat.products.length} SKU</span>
                    </div>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="px-3 py-2 text-left text-gray-400 font-normal">产品名称</th>
                          <th className="px-3 py-2 text-center text-gray-400 font-normal w-16">单位</th>
                          <th className="px-3 py-2 text-right text-gray-400 font-normal w-20">确认量</th>
                          <th className="px-3 py-2 text-right text-gray-400 font-normal w-24">ATP 库存</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cat.products.map(p => {
                          const atp = p.qtyOnHand - p.qty
                          const color = atp > 0 ? '#10B981' : atp === 0 ? '#F59E0B' : '#EF4444'
                          return (
                            <tr key={p.productId} className="border-b border-gray-50 hover:bg-purple-50 transition-colors">
                              <td className="px-3 py-2 text-gray-800">{p.name}</td>
                              <td className="px-3 py-2 text-center text-gray-500">{p.uomName || '—'}</td>
                              <td className="px-3 py-2 text-right text-gray-700 tabular-nums font-medium">{p.qty % 1 === 0 ? p.qty.toFixed(0) : p.qty.toFixed(2)}</td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                <span className="inline-flex items-center gap-1.5 justify-end">
                                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                                  <span style={{ color }}>{atp % 1 === 0 ? atp.toFixed(0) : atp.toFixed(2)}</span>
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
            {filteredDailyStats.length > 0 && (
              <div className="text-xs text-gray-500 pt-2 border-t border-gray-100">
                合计：{dailySummary.totalSku} SKU · {dailySummary.totalQty % 1 === 0 ? dailySummary.totalQty.toFixed(0) : dailySummary.totalQty.toFixed(2)} 件
              </div>
            )}
          </div>
        )}

        {/* View 2: 周趋势 */}
        {statsView === 'weekly' && (
          <div className="p-5 space-y-4">
            <div className="flex items-center gap-3">
              <button onClick={() => setShowWeeklyAvg(v => !v)} className={`px-3 py-1.5 text-xs rounded border transition-colors ${showWeeklyAvg ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'border-gray-300 text-gray-600 hover:border-[#875A7B]'}`}>
                {showWeeklyAvg ? '隐藏' : '显示'}过去4周均值
              </button>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={weeklyChartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} width={56} tickFormatter={v => `€${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`} />
                <Tooltip formatter={(v, name) => [`€${Number(v ?? 0).toFixed(0)}`, name === 'current' ? '本周' : '过去4周均值']} />
                <Legend formatter={name => name === 'current' ? '本周' : '过去4周均值'} />
                <Bar dataKey="current" name="current" fill="#875A7B" radius={[2, 2, 0, 0]} />
                {showWeeklyAvg && <Line type="monotone" dataKey="avg" name="avg" stroke="#F59E0B" strokeWidth={2} dot={{ fill: '#F59E0B', r: 3 }} strokeDasharray="4 2" />}
              </ComposedChart>
            </ResponsiveContainer>
            {weeklyConclusion && (
              <div className="text-xs text-gray-600 bg-gray-50 rounded-lg px-4 py-2.5 border border-gray-100">{weeklyConclusion}</div>
            )}
          </div>
        )}
      </div>

      {/* ── Dashboard（已隐藏）── */}
      {false && <div className="p-5 space-y-4 bg-gray-50">

        {/* Period selector */}
        <div className="flex items-center gap-2 flex-wrap">
          {(['week', 'month', '4weeks', 'custom'] as const).map(p => (
            <button
              key={p}
              onClick={() => {
                if (p === 'custom') return
                setDashPeriod(p)
                const [f, t] = periodDates(p)
                setDashFrom(f)
                setDashTo(t)
              }}
              className={`px-3 py-1.5 text-xs rounded border transition-colors ${dashPeriod === p ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-gray-600 border-gray-300 hover:border-[#875A7B]'}`}
            >
              {p === 'week' ? '本周' : p === 'month' ? '本月' : p === '4weeks' ? '过去4周' : '自定义'}
            </button>
          ))}
          {dashPeriod === 'custom' && (
            <>
              <input type="date" value={dashFrom} max={dashTo} onChange={e => setDashFrom(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-xs bg-white" />
              <span className="text-gray-400 text-xs">–</span>
              <input type="date" value={dashTo} min={dashFrom} onChange={e => setDashTo(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-xs bg-white" />
            </>
          )}
          {dashLoading && <span className="text-xs text-gray-400 ml-2">加载中…</span>}
        </div>

        {/* 2-col grid */}
        <div className="grid grid-cols-2 gap-4">

          {/* Card 1: 产品 Top 10 */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wider">产品 Top 10</span>
            </div>
            {productTop10.length === 0 ? (
              <div className="p-6 text-center text-gray-400 text-sm">暂无数据</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="px-3 py-2 text-center text-gray-400 w-6">#</th>
                      <th className="px-3 py-2 text-left text-gray-400">产品</th>
                      <th className="px-3 py-2 text-left text-gray-400">类目</th>
                      <th className="px-3 py-2 text-right text-gray-400">数量</th>
                      <th className="px-3 py-2 text-right text-gray-400">均价</th>
                      <th className="px-3 py-2 text-right text-gray-400">税前</th>
                      <th className="px-3 py-2 text-right text-gray-400">税后</th>
                      <th className="px-3 py-2 text-right text-gray-400">客均量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {productTop10.map((r, i) => (
                      <tr key={r.name} className="border-b border-gray-50 hover:bg-purple-50 transition-colors">
                        <td className="px-3 py-2 text-center text-gray-400">{i + 1}</td>
                        <td className="px-3 py-2 text-gray-800 max-w-[120px] truncate" title={r.name}>{r.name}</td>
                        <td className="px-3 py-2 text-gray-500">{r.category}</td>
                        <td className="px-3 py-2 text-right text-gray-700 tabular-nums">{r.qty.toFixed(0)}</td>
                        <td className="px-3 py-2 text-right text-gray-700 tabular-nums">{eur(r.avgUnitPrice)}</td>
                        <td className="px-3 py-2 text-right text-gray-700 tabular-nums">{eur(r.exTax)}</td>
                        <td className="px-3 py-2 text-right text-gray-700 tabular-nums">{eur(r.incTax)}</td>
                        <td className="px-3 py-2 text-right text-gray-500 tabular-nums">{r.avgPerCustomer.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Card 2: 类目 Top 10 */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wider">类目 Top 10</span>
            </div>
            {categoryTop10.length === 0 ? (
              <div className="p-6 text-center text-gray-400 text-sm">暂无数据</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="px-3 py-2 text-center text-gray-400 w-6">#</th>
                    <th className="px-3 py-2 text-left text-gray-400">类目</th>
                    <th className="px-3 py-2 text-right text-gray-400">品数</th>
                    <th className="px-3 py-2 text-right text-gray-400">总量</th>
                    <th className="px-3 py-2 text-right text-gray-400">税前</th>
                    <th className="px-3 py-2 text-right text-gray-400">税后</th>
                    <th className="px-3 py-2 text-right text-gray-400">占比%</th>
                  </tr>
                </thead>
                <tbody>
                  {categoryTop10.map((r, i) => (
                    <tr key={r.name} className="border-b border-gray-50 hover:bg-purple-50 transition-colors">
                      <td className="px-3 py-2 text-center text-gray-400">{i + 1}</td>
                      <td className="px-3 py-2 text-gray-800">{r.name}</td>
                      <td className="px-3 py-2 text-right text-gray-700 tabular-nums">{r.productCount}</td>
                      <td className="px-3 py-2 text-right text-gray-700 tabular-nums">{r.qty.toFixed(0)}</td>
                      <td className="px-3 py-2 text-right text-gray-700 tabular-nums">{eur(r.exTax)}</td>
                      <td className="px-3 py-2 text-right text-gray-700 tabular-nums">{eur(r.incTax)}</td>
                      <td className="px-3 py-2 text-right text-gray-500 tabular-nums">{(r.pct * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Card 3: 客户 Top 10 */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wider">客户 Top 10</span>
            </div>
            {customerTop10.length === 0 ? (
              <div className="p-6 text-center text-gray-400 text-sm">暂无数据</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="px-3 py-2 text-center text-gray-400 w-6">#</th>
                    <th className="px-3 py-2 text-left text-gray-400">客户</th>
                    <th className="px-3 py-2 text-right text-gray-400">订单数</th>
                    <th className="px-3 py-2 text-right text-gray-400">总量</th>
                    <th className="px-3 py-2 text-right text-gray-400">税前</th>
                    <th className="px-3 py-2 text-right text-gray-400">税后</th>
                    <th className="px-3 py-2 text-right text-gray-400">均单额</th>
                  </tr>
                </thead>
                <tbody>
                  {customerTop10.map((r, i) => (
                    <tr key={r.name} className="border-b border-gray-50 hover:bg-purple-50 transition-colors">
                      <td className="px-3 py-2 text-center text-gray-400">{i + 1}</td>
                      <td className="px-3 py-2 text-gray-800 max-w-[120px] truncate" title={r.name}>{r.name}</td>
                      <td className="px-3 py-2 text-right text-gray-700 tabular-nums">{r.orderCount}</td>
                      <td className="px-3 py-2 text-right text-gray-700 tabular-nums">{r.qty.toFixed(0)}</td>
                      <td className="px-3 py-2 text-right text-gray-700 tabular-nums">{eur(r.exTax)}</td>
                      <td className="px-3 py-2 text-right text-gray-700 tabular-nums">{eur(r.incTax)}</td>
                      <td className="px-3 py-2 text-right text-gray-500 tabular-nums">{eur(r.avgOrderValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Card 4: 星期销售分布 */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wider">星期销售分布</span>
            </div>
            <div className="p-3">
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={weekdayData} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `€${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`} />
                  <YAxis type="category" dataKey="day" tick={{ fontSize: 10 }} width={28} />
                  <Tooltip formatter={(v) => [`€${Number(v ?? 0).toFixed(0)}`, '税前销售额']} />
                  <Bar dataKey="exTax" fill="#875A7B" radius={[0, 2, 2, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <table className="w-full text-xs mt-2">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="py-1 text-left text-gray-400">星期</th>
                    <th className="py-1 text-right text-gray-400">订单</th>
                    <th className="py-1 text-right text-gray-400">销售额</th>
                    <th className="py-1 text-right text-gray-400">均价</th>
                  </tr>
                </thead>
                <tbody>
                  {weekdayData.map(r => (
                    <tr key={r.day} className="border-b border-gray-50 hover:bg-purple-50 transition-colors">
                      <td className="py-1 text-gray-700">{r.day}</td>
                      <td className="py-1 text-right text-gray-600 tabular-nums">{r.orderCount}</td>
                      <td className="py-1 text-right text-gray-700 tabular-nums">{eur(r.exTax)}</td>
                      <td className="py-1 text-right text-gray-500 tabular-nums">{eur(r.avgUnitPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Card 5: 周期趋势 (全宽) */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-600 uppercase tracking-wider">周期趋势</span>
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
                    onClick={() => setDashGranularity(g)}
                    className={`px-2.5 py-1 transition-colors ${dashGranularity === g ? 'bg-[#875A7B] text-white' : 'text-gray-500 hover:bg-gray-50'}`}
                  >
                    {g === 'day' ? '日' : g === 'week' ? '周' : '月'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="p-4">
            {chartData.length === 0 ? (
              <div className="h-40 flex items-center justify-center text-gray-400 text-sm">暂无数据</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={56} tickFormatter={v => `€${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`} />
                  <Tooltip formatter={(v) => [`€${Number(v ?? 0).toFixed(0)}`, '']} />
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
      </div>}
    </div>
  )
}
