'use client'
import { Fragment, useState, useEffect, useMemo } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import {
  LineChart, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart,
} from 'recharts'
import { apiGet } from '@/lib/api'
import type { Order } from '@/lib/types'
import { formatDriverSlotFromOrder, parseDriverSlotKey } from '@/lib/driver-slot'
import { toggleValue, today } from './shared'
import ProductSearchInput from '@/components/classic/ProductSearchInput'
import CustomerSearchInput from '@/components/classic/CustomerSearchInput'

interface CustomerRow { id: string; name: string; street?: string; city?: string; notes?: string; pricelist?: string }
interface ProductRow { id: string; name: string; salePrice?: number; category?: string; categoryId?: string | null; qtyOnHand?: number; uomName?: string }
interface UserRow { id: string; name: string }
interface CategoryRow { id: string; name: string }
interface OrderLine { id: string; productId?: string | null; productName?: string | null; orderedQty?: number | null; unitPrice?: number | null; subtotal?: number | null; uomName?: string | null }
interface ReportLine { date: string; customerId: string; customerName: string; productName: string; qty: number; unitPrice: number; amount: number }

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

// 筛选结果表：单个日期分组（日期头 → 客户 → 商品行 → 日小计）
function FragmentRows({ day }: { day: { date: string; dateQty: number; dateAmt: number; customers: ReportLine[][] } }) {
  return (
    <>
      <tr className="bg-gray-100">
        <td colSpan={4} className="px-4 py-1.5 font-bold text-gray-700">{day.date}</td>
      </tr>
      {day.customers.map(custLines => (
        <Fragment key={day.date + custLines[0].customerId}>
          <tr className="bg-gray-50/60">
            <td colSpan={4} className="px-4 py-1 font-medium text-[#875A7B]">{custLines[0].customerName}</td>
          </tr>
          {custLines.map((l, i) => (
            <tr key={i} className="border-b border-gray-50 hover:bg-purple-50/30">
              <td className="px-4 py-1.5 pl-8 text-gray-700">{l.productName}</td>
              <td className="px-4 py-1.5 text-right tabular-nums text-gray-700">{l.qty.toFixed(3)}</td>
              <td className="px-4 py-1.5 text-right tabular-nums text-gray-500">{eur(l.unitPrice)}</td>
              <td className="px-4 py-1.5 text-right tabular-nums text-gray-700">{eur(l.amount)}</td>
            </tr>
          ))}
        </Fragment>
      ))}
      <tr className="border-b border-gray-200 bg-gray-50 font-medium text-gray-600">
        <td className="px-4 py-1.5">小计 {day.date}</td>
        <td className="px-4 py-1.5 text-right tabular-nums">{day.dateQty.toFixed(3)}</td>
        <td />
        <td className="px-4 py-1.5 text-right tabular-nums">{eur(day.dateAmt)}</td>
      </tr>
    </>
  )
}

// ─── SalesStats ───────────────────────────────────────────────────────────────

export default function SalesStats() {
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const [selectedSalesman, setSelectedSalesman] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>([])
  const [selectedTimes, setSelectedTimes] = useState<string[]>([])
  const [selectedBatchNums, setSelectedBatchNums] = useState<number[]>([])
  const [selectedCustomers, setSelectedCustomers] = useState<CustomerRow[]>([])
  const [selectedProducts, setSelectedProducts] = useState<ProductRow[]>([])
  const [customerQuery, setCustomerQuery] = useState('')
  const [productQuery, setProductQuery] = useState('')

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
  const [selectedStatsCats, setSelectedStatsCats] = useState<string[]>([])
  const [dailyOrders, setDailyOrders] = useState<Order[]>([])
  const [dailyLoading, setDailyLoading] = useState(false)
  const [showWeeklyAvg, setShowWeeklyAvg] = useState(false)
  // 周趋势度量：销售员订货按数量决策，默认看量；金额留作参考
  const [weeklyMeasure, setWeeklyMeasure] = useState<'qty' | 'amount'>('qty')

  // Load reference data once
  useEffect(() => {
    apiGet<ProductRow[]>('/api/products?limit=500').then(d => setAllProducts(Array.isArray(d) ? d : [])).catch(() => {})
    apiGet<UserRow[]>('/api/users').then(d => setAllSalesmen(Array.isArray(d) ? d : [])).catch(() => {})
    apiGet<CategoryRow[]>('/api/product-categories').then(d => setAllCategories(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  // Load orders (with lines) whenever range/salesman/category changes — drives batch chips + on-screen result table
  const [ordersLoading, setOrdersLoading] = useState(false)
  useEffect(() => {
    if (!fromDate || !toDate) return
    const params = new URLSearchParams({
      status: 'CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY,COMPLETED',
      dateField: 'deliveryDate', fromDate, toDate,
      include_lines: 'true', limit: '5000',
    })
    if (selectedCategory) params.set('categoryId', selectedCategory)
    if (selectedSalesman) params.set('salesUserId', selectedSalesman)
    setOrdersLoading(true)
    apiGet<Order[]>(`/api/orders?${params}`)
      .then(d => setOrders(Array.isArray(d) ? d : []))
      .catch(() => setOrders([]))
      .finally(() => setOrdersLoading(false))
  }, [fromDate, toDate, selectedCategory, selectedSalesman])

  // Auto-compute dashboard date range from fromDate (current week + 4 past weeks)
  useEffect(() => {
    const dt = new Date(fromDate + 'T12:00:00Z')
    const dow = (dt.getUTCDay() + 6) % 7
    const mon = new Date(dt)
    mon.setUTCDate(dt.getUTCDate() - dow)
    const from = new Date(mon)
    from.setUTCDate(mon.getUTCDate() - 28)
    const to = new Date(mon)
    to.setUTCDate(mon.getUTCDate() + 6)
    setDashFrom(from.toISOString().slice(0, 10))
    setDashTo(to.toISOString().slice(0, 10))
  }, [fromDate])

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
  // 状态集需与批次/看板查询一致：订单确认后一旦被排线，状态会推进到 WAVE_ASSIGNED/IN_DELIVERY/COMPLETED，
  // 只查 CONFIRMED 会漏掉当天已排线/已配送的订单，导致「今日总量」看起来是空的。
  useEffect(() => {
    if (!fromDate) return
    setDailyLoading(true)
    apiGet<Order[]>(
      `/api/orders?status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY,COMPLETED&dateField=deliveryDate&fromDate=${fromDate}&toDate=${fromDate}`
    )
      .then(d => setDailyOrders(Array.isArray(d) ? d : []))
      .catch(() => setDailyOrders([]))
      .finally(() => setDailyLoading(false))
  }, [fromDate])

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

  // ── 筛选结果（与 day-wise-report 打印页同口径）───────────────────────────────
  const reportLines = useMemo(() => {
    const custSet = new Set(selectedCustomers.map(c => c.id))
    const prodNames = new Set(selectedProducts.map(p => p.name))
    const out: ReportLine[] = []
    for (const o of orders) {
      if (custSet.size > 0 && !custSet.has(o.restaurantId)) continue
      if (selectedDrivers.length > 0 || selectedTimes.length > 0 || selectedBatchNums.length > 0) {
        const p = parseDriverSlotKey(formatDriverSlotFromOrder(o))
        if (selectedDrivers.length > 0 && !selectedDrivers.includes(p.driver)) continue
        if (selectedTimes.length > 0 && !selectedTimes.includes(p.time)) continue
        if (selectedBatchNums.length > 0 && !selectedBatchNums.includes(p.num)) continue
      }
      const date = ((o as Order & { deliveryDate?: string }).deliveryDate ?? String(o.createdAt)).slice(0, 10)
      const ls = (o as Order & { lines?: OrderLine[] }).lines ?? []
      for (const l of ls) {
        const name = l.productName ?? ''
        if (prodNames.size > 0 && !prodNames.has(name)) continue
        out.push({
          date,
          customerId: o.restaurantId,
          customerName: o.restaurantName,
          productName: name,
          qty: Number(l.orderedQty ?? 0),
          unitPrice: Number(l.unitPrice ?? 0),
          amount: Number(l.subtotal ?? 0),
        })
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.customerName.localeCompare(b.customerName))
  }, [orders, selectedCustomers, selectedProducts, selectedDrivers, selectedTimes, selectedBatchNums])

  // 日期 → 客户 → 行 的层级分组（屏幕展示用）
  const groupedReport = useMemo(() => {
    const byDate = new Map<string, Map<string, ReportLine[]>>()
    for (const l of reportLines) {
      if (!byDate.has(l.date)) byDate.set(l.date, new Map())
      const byCust = byDate.get(l.date)!
      if (!byCust.has(l.customerId)) byCust.set(l.customerId, [])
      byCust.get(l.customerId)!.push(l)
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, byCust]) => ({
        date,
        dateQty: [...byCust.values()].flat().reduce((s, l) => s + l.qty, 0),
        dateAmt: [...byCust.values()].flat().reduce((s, l) => s + l.amount, 0),
        customers: [...byCust.values()],
      }))
  }, [reportLines])

  const reportTotal = useMemo(() => ({
    qty: reportLines.reduce((s, l) => s + l.qty, 0),
    amount: reportLines.reduce((s, l) => s + l.amount, 0),
  }), [reportLines])

  // 按商品汇总视图：跨区间聚合每个商品的量/额/客户数
  const [reportGroupBy, setReportGroupBy] = useState<'customer' | 'product'>('customer')
  const productReport = useMemo(() => {
    const m = new Map<string, { name: string; qty: number; amount: number; customers: Set<string> }>()
    for (const l of reportLines) {
      const e = m.get(l.productName) ?? { name: l.productName, qty: 0, amount: 0, customers: new Set<string>() }
      e.qty += l.qty
      e.amount += l.amount
      e.customers.add(l.customerId)
      m.set(l.productName, e)
    }
    return [...m.values()]
      .map(v => ({ name: v.name, qty: v.qty, amount: v.amount, customerCount: v.customers.size, avgPrice: v.qty > 0 ? v.amount / v.qty : 0 }))
      .sort((a, b) => b.amount - a.amount)
  }, [reportLines])

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

  // 周趋势吃上方的商品/分类筛选：销售员选中要订的货，看它周一~周日各卖多少
  const weeklyChartData = useMemo(() => {
    const DOW_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    const now = new Date(fromDate + 'T12:00:00Z')
    const nowDow = (now.getUTCDay() + 6) % 7
    const thisMon = new Date(now)
    thisMon.setUTCDate(now.getUTCDate() - nowDow)
    thisMon.setUTCHours(0, 0, 0, 0)
    const prodNames = new Set(selectedProducts.map(p => p.name))
    const round1 = (v: number) => Math.round(v * 10) / 10
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
      let orderTotal = 0
      for (const l of ((o as Order & { lines?: OrderLine[] }).lines ?? [])) {
        if (prodNames.size > 0 && !prodNames.has(l.productName ?? '')) continue
        if (selectedCategory) {
          const cid = l.productId ? productMap.get(l.productId)?.categoryId : null
          if (cid !== selectedCategory) continue
        }
        orderTotal += weeklyMeasure === 'qty' ? Number(l.orderedQty ?? 0) : Number(l.subtotal ?? 0)
      }
      if (weeksBack === 0) currentWeek[weekday] += orderTotal
      else if (weeksBack >= 1 && weeksBack <= 4) pastWeeks[weeksBack - 1][weekday] += orderTotal
    }
    const pastAvg = Array(7).fill(0).map((_, i) =>
      round1(pastWeeks.reduce((s, w) => s + w[i], 0) / 4)
    )
    return DOW_LABELS.map((day, i) => ({
      day, current: round1(currentWeek[i]), avg: pastAvg[i],
    }))
  }, [dashOrders, fromDate, selectedProducts, selectedCategory, productMap, weeklyMeasure])

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
    const fmt = (v: number) => weeklyMeasure === 'qty' ? `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)} 件` : `€${v.toFixed(0)}`
    return `本周峰值在${peak.day}（${fmt(peak.current)}）；本周合计 ${fmt(total)}${diffText}。`
  }, [weeklyChartData, weeklyMeasure])

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
              const color = atp > 0 ? '#10B981' : atp === 0 ? '#F59E0B' : '#8B5CF6'
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
<title>今日总量 · ${fromDate}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#fff;padding:20px}@media print{@page{margin:1cm}body{padding:0}}</style>
</head><body>
<div style="margin-bottom:16px;padding-bottom:12px;border-bottom:1px dashed #e5e7eb;font-size:12px;color:#6b7280;">
  <b style="font-size:15px;color:#111;">今日总量</b>&nbsp;&nbsp;日期：<b style="color:#111;">${fromDate}</b>&nbsp;&nbsp;分类：<b style="color:#111;">${selectedStatsCats.length > 0 ? selectedStatsCats.join('、') : '全部分类'}</b>&nbsp;&nbsp;合计：<b style="color:#111;">${dailySummary.totalSku} SKU · ${dailySummary.totalQty % 1 === 0 ? dailySummary.totalQty.toFixed(0) : dailySummary.totalQty.toFixed(2)} 件</b>
  <div style="margin-top:4px;">ATP 色标：<span style="color:#10B981;">正数 = 有余量</span> · <span style="color:#F59E0B;">零 = 刚好用完</span> · <span style="color:#8B5CF6;">负数 ≠ 缺货（可能当天到货或可临时调货）</span></div>
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
    if (selectedSalesman) params.set('salesUserId', selectedSalesman)
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
              {allSalesmen.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
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

      {/* Customers chip filter */}
      <div className="px-5 py-3 border-b border-gray-200">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider shrink-0">Customers</span>
          {selectedCustomers.map(c => (
            <span key={c.id} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-[#f3edf7] text-[#875A7B] rounded border border-[#d4b8e0]">
              {c.name}
              <button onClick={() => setSelectedCustomers(prev => prev.filter(x => x.id !== c.id))} className="hover:text-red-500 leading-none">×</button>
            </span>
          ))}
          <CustomerSearchInput<CustomerRow>
            value={customerQuery}
            onChange={setCustomerQuery}
            onSelect={c => setSelectedCustomers(prev => prev.some(x => x.id === c.id) ? prev : [...prev, c])}
            excludeIds={selectedCustomers.map(c => c.id)}
            placeholder="搜索客户…"
            inputClassName="border border-gray-300 rounded px-2 py-0.5 text-xs w-40 focus:outline-none focus:border-[#875A7B]"
          />
          {selectedCustomers.length === 0 ? (
            <span className="text-xs text-gray-400">（留空 = 全部客户）</span>
          ) : (
            <button onClick={() => setSelectedCustomers([])} className="text-xs text-gray-400 hover:text-gray-600">清除</button>
          )}
        </div>
      </div>

      {/* Products chip filter */}
      <div className="px-5 py-3 border-b border-gray-200">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider shrink-0">Products</span>
          {selectedProducts.map(p => (
            <span key={p.id} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-[#f3edf7] text-[#875A7B] rounded border border-[#d4b8e0]">
              {p.name}
              <button onClick={() => setSelectedProducts(prev => prev.filter(x => x.id !== p.id))} className="hover:text-red-500 leading-none">×</button>
            </span>
          ))}
          <ProductSearchInput<ProductRow>
            value={productQuery}
            onChange={setProductQuery}
            onSelect={p => { setSelectedProducts(prev => prev.some(x => x.id === p.id) ? prev : [...prev, p]); setProductQuery('') }}
            products={allProducts.filter(p => !selectedProducts.some(sp => sp.id === p.id))}
            placeholder="搜索商品…"
            inputClassName="border border-gray-300 rounded px-2 py-0.5 text-xs w-40 focus:outline-none focus:border-[#875A7B]"
            showOnEmptyQuery={false}
            selectOnTab
          />
          {selectedProducts.length === 0 ? (
            <span className="text-xs text-gray-400">（留空 = 全部商品）</span>
          ) : (
            <button onClick={() => setSelectedProducts([])} className="text-xs text-gray-400 hover:text-gray-600">清除</button>
          )}
        </div>
      </div>

      {/* 筛选结果（屏幕预览，与打印同口径） */}
      <div className="border-b border-gray-200">
        <div className="px-5 py-3 flex items-center justify-between gap-3 flex-wrap bg-gray-50 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              筛选结果
              <span className="ml-2 font-normal normal-case text-gray-400">
                {ordersLoading ? '加载中…' : `${reportLines.length} 行 · 合计 ${eur(reportTotal.amount)}`}
              </span>
            </span>
            <div className="flex rounded border border-gray-200 overflow-hidden text-xs">
              {(['customer', 'product'] as const).map(g => (
                <button
                  key={g}
                  onClick={() => setReportGroupBy(g)}
                  className={`px-2.5 py-1 transition-colors ${reportGroupBy === g ? 'bg-[#875A7B] text-white' : 'text-gray-500 hover:bg-gray-50 bg-white'}`}
                >
                  {g === 'customer' ? '按客户' : '按商品'}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">打印：</span>
            <button
              onClick={() => window.open(buildUrl('day'), '_blank', 'noopener,noreferrer')}
              disabled={reportLines.length === 0}
              className="px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40"
              style={{ borderColor: '#875A7B', color: '#875A7B' }}
            >日报（按客户）</button>
            <button
              onClick={() => window.open(buildUrl('multiline'), '_blank', 'noopener,noreferrer')}
              disabled={reportLines.length === 0}
              className="px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40"
              style={{ borderColor: '#875A7B', color: '#875A7B' }}
            >明细清单</button>
            <button
              onClick={() => window.open(buildUrl('summary'), '_blank', 'noopener,noreferrer')}
              disabled={reportLines.length === 0}
              className="px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40"
              style={{ borderColor: '#875A7B', color: '#875A7B' }}
            >商品×星期汇总</button>
          </div>
        </div>
        {reportLines.length === 0 ? (
          <div className="px-5 py-8 text-center text-gray-400 text-sm">
            {ordersLoading ? '加载中…' : '当前筛选条件下没有订单行'}
          </div>
        ) : reportGroupBy === 'customer' ? (
          <div className="max-h-[480px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white shadow-sm">
                <tr className="border-b border-gray-200">
                  <th className="px-4 py-2 text-left text-gray-400 font-medium">产品</th>
                  <th className="px-4 py-2 text-right text-gray-400 font-medium w-24">数量</th>
                  <th className="px-4 py-2 text-right text-gray-400 font-medium w-24">单价</th>
                  <th className="px-4 py-2 text-right text-gray-400 font-medium w-28">金额</th>
                </tr>
              </thead>
              <tbody>
                {groupedReport.map(day => (
                  <FragmentRows key={day.date} day={day} />
                ))}
                <tr className="bg-[#875A7B]/10 font-bold text-gray-800">
                  <td className="px-4 py-2">总计</td>
                  <td className="px-4 py-2 text-right tabular-nums">{reportTotal.qty.toFixed(3)}</td>
                  <td className="px-4 py-2" />
                  <td className="px-4 py-2 text-right tabular-nums">{eur(reportTotal.amount)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="max-h-[480px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white shadow-sm">
                <tr className="border-b border-gray-200">
                  <th className="px-4 py-2 text-left text-gray-400 font-medium">产品</th>
                  <th className="px-4 py-2 text-right text-gray-400 font-medium w-20">客户数</th>
                  <th className="px-4 py-2 text-right text-gray-400 font-medium w-24">数量合计</th>
                  <th className="px-4 py-2 text-right text-gray-400 font-medium w-24">均价</th>
                  <th className="px-4 py-2 text-right text-gray-400 font-medium w-28">金额合计</th>
                </tr>
              </thead>
              <tbody>
                {productReport.map(p => (
                  <tr key={p.name} className="border-b border-gray-50 hover:bg-purple-50/30">
                    <td className="px-4 py-1.5 text-gray-700">{p.name}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-gray-500">{p.customerCount}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-gray-700">{p.qty.toFixed(3)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-gray-500">{eur(p.avgPrice)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-gray-700">{eur(p.amount)}</td>
                  </tr>
                ))}
                <tr className="bg-[#875A7B]/10 font-bold text-gray-800">
                  <td className="px-4 py-2">总计</td>
                  <td className="px-4 py-2" />
                  <td className="px-4 py-2 text-right tabular-nums">{reportTotal.qty.toFixed(3)}</td>
                  <td className="px-4 py-2" />
                  <td className="px-4 py-2 text-right tabular-nums">{eur(reportTotal.amount)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── New Views: 当日分类总量 / 周销售趋势 ── */}
      <div className="border-t border-gray-200">

        {/* Shared header: view toggle (date follows the From picker above) */}
        <div className="px-5 py-3 flex items-center gap-4 bg-gray-50 border-b border-gray-200">
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
          <span className="text-xs text-gray-400">以上方 From 日期（{fromDate}）为准</span>
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
                          const color = atp > 0 ? '#10B981' : atp === 0 ? '#F59E0B' : '#8B5CF6'
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
              <div className="text-xs text-gray-500 pt-2 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
                <span>合计：{dailySummary.totalSku} SKU · {dailySummary.totalQty % 1 === 0 ? dailySummary.totalQty.toFixed(0) : dailySummary.totalQty.toFixed(2)} 件</span>
                <span className="text-gray-400">
                  ATP 色标：<span className="text-emerald-600">正数=有余量</span> · <span className="text-amber-500">零=刚好用完</span> · <span className="text-violet-500">负数≠缺货（可能当天到货或可临时调货）</span>
                </span>
              </div>
            )}
          </div>
        )}

        {/* View 2: 周趋势 */}
        {statsView === 'weekly' && (
          <div className="p-5 space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex rounded border border-gray-200 overflow-hidden text-xs">
                {(['qty', 'amount'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => setWeeklyMeasure(m)}
                    className={`px-3 py-1.5 transition-colors ${weeklyMeasure === m ? 'bg-[#875A7B] text-white' : 'text-gray-500 hover:bg-gray-50 bg-white'}`}
                  >
                    {m === 'qty' ? '按数量' : '按金额'}
                  </button>
                ))}
              </div>
              <button onClick={() => setShowWeeklyAvg(v => !v)} className={`px-3 py-1.5 text-xs rounded border transition-colors ${showWeeklyAvg ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'border-gray-300 text-gray-600 hover:border-[#875A7B]'}`}>
                {showWeeklyAvg ? '隐藏' : '显示'}过去4周均值
              </button>
              <span className="text-xs text-gray-400">
                {selectedProducts.length > 0
                  ? `已聚焦商品：${selectedProducts.map(p => p.name).join('、')}`
                  : selectedCategory
                    ? `已聚焦分类：${allCategories.find(c => c.id === selectedCategory)?.name ?? ''}`
                    : '未选商品/分类 = 全店（可在上方 Products / Product Category 选择要订的货）'}
              </span>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={weeklyChartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} width={56}
                  tickFormatter={v => weeklyMeasure === 'qty'
                    ? `${v}`
                    : `€${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`} />
                <Tooltip formatter={(v, name) => [
                  weeklyMeasure === 'qty' ? `${Number(v ?? 0)} 件` : `€${Number(v ?? 0).toFixed(0)}`,
                  name === 'current' ? '本周' : '过去4周均值',
                ]} />
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
