'use client'
import { Fragment, useState, useEffect, useMemo } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
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

/** 一条摊平的订单行，携带派生的分类/单位/库存，供四种查看方式共用 */
interface ReportLine {
  date: string
  customerId: string
  customerName: string
  productId: string
  productName: string
  categoryName: string
  uomName: string
  qty: number
  unitPrice: number
  amount: number
  qtyOnHand: number
}

const DOW_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const eur = (v: number) => `€${v.toFixed(2)}`
const fmtQty = (v: number) => (v % 1 === 0 ? v.toFixed(0) : v.toFixed(2))

// 按客户查看：单个日期分组（日期头 → 客户 → 商品行 → 日小计）
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

type ViewMode = 'customer' | 'product' | 'category' | 'weekday'

export default function SalesStats() {
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  // ── 一套筛选条件（驱动下面全部查看方式）──────────────────────────────────
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const [selectedSalesman, setSelectedSalesman] = useState('')
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>([])
  const [selectedTimes, setSelectedTimes] = useState<string[]>([])
  const [selectedBatchNums, setSelectedBatchNums] = useState<number[]>([])
  const [selectedCustomers, setSelectedCustomers] = useState<CustomerRow[]>([])
  const [selectedProducts, setSelectedProducts] = useState<ProductRow[]>([])
  const [customerQuery, setCustomerQuery] = useState('')
  const [productQuery, setProductQuery] = useState('')
  const [categoryQuery, setCategoryQuery] = useState('')

  const [allProducts, setAllProducts] = useState<ProductRow[]>([])
  const [allSalesmen, setAllSalesmen] = useState<UserRow[]>([])
  const [allCategories, setAllCategories] = useState<CategoryRow[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)

  // ── 查看方式 + 度量 ──────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>('customer')
  const [weekdayMeasure, setWeekdayMeasure] = useState<'qty' | 'amount'>('qty')

  // 参考数据（一次加载）
  useEffect(() => {
    apiGet<ProductRow[]>('/api/products?limit=5000').then(d => setAllProducts(Array.isArray(d) ? d : [])).catch(() => {})
    apiGet<UserRow[]>('/api/users').then(d => setAllSalesmen(Array.isArray(d) ? d : [])).catch(() => {})
    apiGet<CategoryRow[]>('/api/product-categories').then(d => setAllCategories(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  // 唯一的订单请求：只按日期区间拉，其余筛选全部在前端做 → 四种查看方式共用这一份数据
  useEffect(() => {
    if (!fromDate || !toDate) return
    setOrdersLoading(true)
    apiGet<Order[]>(
      `/api/orders?status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY,COMPLETED&dateField=deliveryDate&fromDate=${fromDate}&toDate=${toDate}&include_lines=true&limit=5000`
    )
      .then(d => setOrders(Array.isArray(d) ? d : []))
      .catch(() => setOrders([]))
      .finally(() => setOrdersLoading(false))
  }, [fromDate, toDate])

  // 司机/时段/批次 chip 选项：从当前区间订单里提取
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

  const productMap = useMemo(() => {
    const m = new Map<string, ProductRow>()
    for (const p of allProducts) m.set(p.id, p)
    return m
  }, [allProducts])

  // ── 筛选结果：一批订单行，全部筛选在此统一应用 ───────────────────────────
  const reportLines = useMemo(() => {
    const custSet = new Set(selectedCustomers.map(c => c.id))
    const prodNames = new Set(selectedProducts.map(p => p.name))
    const catSet = new Set(selectedCategories)
    const out: ReportLine[] = []
    for (const o of orders) {
      if (custSet.size > 0 && !custSet.has(o.restaurantId)) continue
      const salesUserId = (o as Order & { salesUserId?: string | null }).salesUserId ?? ''
      if (selectedSalesman && salesUserId !== selectedSalesman) continue
      if (selectedDrivers.length > 0 || selectedTimes.length > 0 || selectedBatchNums.length > 0) {
        const p = parseDriverSlotKey(formatDriverSlotFromOrder(o))
        if (selectedDrivers.length > 0 && !selectedDrivers.includes(p.driver)) continue
        if (selectedTimes.length > 0 && !selectedTimes.includes(p.time)) continue
        if (selectedBatchNums.length > 0 && !selectedBatchNums.includes(p.num)) continue
      }
      const date = ((o as Order & { deliveryDate?: string }).deliveryDate ?? String(o.createdAt)).slice(0, 10)
      for (const l of ((o as Order & { lines?: OrderLine[] }).lines ?? [])) {
        const name = l.productName ?? ''
        if (prodNames.size > 0 && !prodNames.has(name)) continue
        const prod = l.productId ? productMap.get(l.productId) : undefined
        const catId = prod?.categoryId ?? ''
        if (catSet.size > 0 && !catSet.has(catId)) continue
        out.push({
          date,
          customerId: o.restaurantId,
          customerName: o.restaurantName,
          productId: l.productId ?? '',
          productName: name,
          categoryName: prod?.category ?? '未分类',
          uomName: l.uomName ?? prod?.uomName ?? '',
          qty: Number(l.orderedQty ?? 0),
          unitPrice: Number(l.unitPrice ?? 0),
          amount: Number(l.subtotal ?? 0),
          qtyOnHand: Number(prod?.qtyOnHand ?? 0),
        })
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.customerName.localeCompare(b.customerName))
  }, [orders, selectedCustomers, selectedProducts, selectedCategories, selectedSalesman, selectedDrivers, selectedTimes, selectedBatchNums, productMap])

  const reportTotal = useMemo(() => ({
    qty: reportLines.reduce((s, l) => s + l.qty, 0),
    amount: reportLines.reduce((s, l) => s + l.amount, 0),
  }), [reportLines])

  // 查看方式①：按客户（日期 → 客户 → 行）
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
      .map(([date, byCust]) => {
        const all = [...byCust.values()].flat()
        return {
          date,
          dateQty: all.reduce((s, l) => s + l.qty, 0),
          dateAmt: all.reduce((s, l) => s + l.amount, 0),
          customers: [...byCust.values()],
        }
      })
  }, [reportLines])

  // 查看方式②：按商品（跨区间聚合）
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

  // 查看方式③：按分类（分类 → 商品，带 ATP）—— 调度备货
  const categoryReport = useMemo(() => {
    const catMap = new Map<string, Map<string, { productId: string; name: string; uomName: string; qty: number; qtyOnHand: number }>>()
    for (const l of reportLines) {
      if (!catMap.has(l.categoryName)) catMap.set(l.categoryName, new Map())
      const prods = catMap.get(l.categoryName)!
      const key = l.productId || l.productName
      const ex = prods.get(key)
      if (ex) ex.qty += l.qty
      else prods.set(key, { productId: l.productId, name: l.productName, uomName: l.uomName, qty: l.qty, qtyOnHand: l.qtyOnHand })
    }
    return [...catMap.entries()]
      .map(([catName, prods]) => {
        const products = [...prods.values()].sort((a, b) => b.qty - a.qty)
        return { catName, products, totalQty: products.reduce((s, p) => s + p.qty, 0) }
      })
      .sort((a, b) => a.catName.localeCompare(b.catName))
  }, [reportLines])

  const categorySummary = useMemo(() => ({
    sku: categoryReport.reduce((s, c) => s + c.products.length, 0),
    qty: categoryReport.reduce((s, c) => s + c.totalQty, 0),
  }), [categoryReport])

  // 查看方式④：按星期趋势（日均）—— 销售员订货
  const weekdayReport = useMemo(() => {
    // 区间内每个"星期几"出现的日历天数（用于算日均，含没有订单的日子）
    const occ = [0, 0, 0, 0, 0, 0, 0]
    if (fromDate && toDate) {
      const end = new Date(toDate + 'T12:00:00Z')
      const d = new Date(fromDate + 'T12:00:00Z')
      while (d <= end) {
        occ[(d.getUTCDay() + 6) % 7]++
        d.setUTCDate(d.getUTCDate() + 1)
      }
    }
    const sum = [0, 0, 0, 0, 0, 0, 0]
    for (const l of reportLines) {
      const dt = new Date(l.date + 'T12:00:00Z')
      const dow = (dt.getUTCDay() + 6) % 7
      sum[dow] += weekdayMeasure === 'qty' ? l.qty : l.amount
    }
    const round1 = (v: number) => Math.round(v * 10) / 10
    return DOW_LABELS.map((day, i) => ({
      day,
      value: occ[i] > 0 ? round1(sum[i] / occ[i]) : 0,
      occ: occ[i],
    }))
  }, [reportLines, fromDate, toDate, weekdayMeasure])

  const weekdayConclusion = useMemo(() => {
    const nonZero = weekdayReport.filter(d => d.value > 0)
    if (nonZero.length === 0) return ''
    const peak = nonZero.reduce((max, d) => d.value > max.value ? d : max)
    const weekTotal = weekdayReport.reduce((s, d) => s + d.value, 0)
    const fmt = (v: number) => weekdayMeasure === 'qty' ? `${fmtQty(v)} 件` : `€${v.toFixed(0)}`
    return `日均峰值在${peak.day}（${fmt(peak.value)}）；按此日均，一周合计约 ${fmt(weekTotal)}。`
  }, [weekdayReport, weekdayMeasure])

  // ── 打印 ──────────────────────────────────────────────────────────────────
  function buildUrl(mode: 'day' | 'multiline' | 'summary') {
    const params = new URLSearchParams({ mode, from: fromDate, to: toDate })
    if (selectedCustomers.length > 0) params.set('customerIds', selectedCustomers.map(c => c.id).join(','))
    if (selectedProducts.length > 0) params.set('productNames', selectedProducts.map(p => p.name).join(','))
    if (selectedDrivers.length > 0) params.set('drivers', selectedDrivers.join(','))
    if (selectedTimes.length > 0) params.set('times', selectedTimes.join(','))
    if (selectedBatchNums.length > 0) params.set('batchNums', selectedBatchNums.join(','))
    // 打印页只支持单分类；多选时不下传（分类精确打印走「打印分类总量」）
    if (selectedCategories.length === 1) params.set('categoryId', selectedCategories[0])
    if (selectedSalesman) params.set('salesUserId', selectedSalesman)
    return `${prefix}/classic/print/day-wise-report?${params.toString()}`
  }

  // 按分类查看的专属打印：直接渲染屏幕上的 categoryReport，保证所见即所打
  function handleCategoryPrint() {
    const w = window.open('', '_blank', 'noopener,width=800,height=700')
    if (!w) return
    const catsHtml = categoryReport.map(cat => `
      <div style="margin-bottom:16px;">
        <div style="background:#f3f4f6;padding:6px 12px;font-weight:bold;font-size:13px;border-radius:4px 4px 0 0;">${cat.catName} <span style="font-weight:normal;font-size:11px;color:#6b7280;">${cat.products.length} SKU · ${fmtQty(cat.totalQty)} 件</span></div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:#f9fafb;">
              <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;">产品名称</th>
              <th style="text-align:center;padding:6px 8px;border-bottom:1px solid #e5e7eb;">单位</th>
              <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #e5e7eb;">数量</th>
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
                <td style="padding:5px 8px;text-align:right;font-weight:500;">${fmtQty(p.qty)}</td>
                <td style="padding:5px 8px;text-align:right;color:${color};font-weight:500;">${fmtQty(atp)}</td>
              </tr>`
            }).join('')}
          </tbody>
        </table>
      </div>
    `).join('')
    const catLabel = selectedCategories.length > 0
      ? selectedCategories.map(id => allCategories.find(c => c.id === id)?.name ?? id).join('、')
      : '全部分类'
    w.document.write(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>分类总量 · ${fromDate}${toDate !== fromDate ? ' ~ ' + toDate : ''}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#fff;padding:20px}@media print{@page{margin:1cm}body{padding:0}}</style>
</head><body>
<div style="margin-bottom:16px;padding-bottom:12px;border-bottom:1px dashed #e5e7eb;font-size:12px;color:#6b7280;">
  <b style="font-size:15px;color:#111;">分类总量</b>&nbsp;&nbsp;日期：<b style="color:#111;">${fromDate}${toDate !== fromDate ? ' ~ ' + toDate : ''}</b>&nbsp;&nbsp;分类：<b style="color:#111;">${catLabel}</b>&nbsp;&nbsp;合计：<b style="color:#111;">${categorySummary.sku} SKU · ${fmtQty(categorySummary.qty)} 件</b>
  <div style="margin-top:4px;">ATP 色标：<span style="color:#10B981;">正数 = 有余量</span> · <span style="color:#F59E0B;">零 = 刚好用完</span> · <span style="color:#8B5CF6;">负数 ≠ 缺货（可能当天到货或可临时调货）</span></div>
</div>
${catsHtml}
<script>window.print();<\/script>
</body></html>`)
    w.document.close()
    w.focus()
  }

  const selectCls = 'border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-purple-400 bg-white'

  const focusHint = selectedProducts.length > 0
    ? `已聚焦商品：${selectedProducts.map(p => p.name).join('、')}`
    : selectedCategories.length > 0
      ? `已聚焦分类：${selectedCategories.map(id => allCategories.find(c => c.id === id)?.name ?? '').join('、')}`
      : '未选商品/分类 = 全店（可在上方选择要订的货）'

  return (
    <div className="max-w-4xl space-y-0 bg-white rounded-lg border border-gray-200 overflow-hidden">

      {/* ── 筛选栏 ── */}
      <div className="p-5 border-b border-gray-200 space-y-3">
        <div className="grid grid-cols-2 gap-x-8 gap-y-3">
          <div className="flex items-center gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0">From</label>
            <input type="date" value={fromDate} max={toDate} onChange={e => setFromDate(e.target.value)} className={`${selectCls} flex-1`} />
          </div>
          <div className="flex items-center gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0">To</label>
            <input type="date" value={toDate} min={fromDate} onChange={e => setToDate(e.target.value)} className={`${selectCls} flex-1`} />
          </div>
          <div className="flex items-center gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0">Salesman</label>
            <select value={selectedSalesman} onChange={e => setSelectedSalesman(e.target.value)} className={`${selectCls} flex-1`}>
              <option value="">全部业务员</option>
              {allSalesmen.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="flex items-start gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0 pt-1.5">分类（多选）</label>
            <div className="flex items-center gap-1.5 flex-wrap flex-1">
              {selectedCategories.map(id => (
                <span key={id} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-[#f3edf7] text-[#875A7B] rounded border border-[#d4b8e0]">
                  {allCategories.find(c => c.id === id)?.name ?? id}
                  <button onClick={() => setSelectedCategories(prev => prev.filter(x => x !== id))} className="hover:text-red-500 leading-none">×</button>
                </span>
              ))}
              <ProductSearchInput<CategoryRow>
                value={categoryQuery}
                onChange={setCategoryQuery}
                onSelect={c => { setSelectedCategories(prev => prev.includes(c.id) ? prev : [...prev, c.id]); setCategoryQuery('') }}
                products={allCategories.filter(c => !selectedCategories.includes(c.id))}
                placeholder="搜索分类…"
                inputClassName="border border-gray-300 rounded px-2 py-0.5 text-xs w-36 focus:outline-none focus:border-[#875A7B]"
                showOnEmptyQuery={false}
                selectOnTab
              />
              {selectedCategories.length === 0
                ? <span className="text-xs text-gray-400">（留空 = 全部分类）</span>
                : <button onClick={() => setSelectedCategories([])} className="text-xs text-gray-400 hover:text-gray-600">清除</button>}
            </div>
          </div>
        </div>

        {/* 司机 / AM-PM / 批次 */}
        <div className="space-y-2 pt-2 border-t border-dashed border-gray-100">
          <div className="flex items-start gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0 pt-1">司机</label>
            <div className="flex gap-1.5 flex-wrap">
              <button className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedDrivers.length === 0 ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-gray-400 border-gray-200'}`} onClick={() => setSelectedDrivers([])}>全部司机</button>
              {batchFilterOptions.drivers.map(d => (
                <button key={d} className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedDrivers.includes(d) ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-[#875A7B] border-[#d4b8d0]'}`} onClick={() => setSelectedDrivers(prev => toggleValue(prev, d))}>{d}</button>
              ))}
            </div>
          </div>
          <div className="flex items-start gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0 pt-1">AM / PM</label>
            <div className="flex gap-1.5 flex-wrap">
              <button className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedTimes.length === 0 ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-gray-400 border-gray-200'}`} onClick={() => setSelectedTimes([])}>全部时段</button>
              {batchFilterOptions.times.map(t => (
                <button key={t} className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedTimes.includes(t) ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-[#875A7B] border-[#d4b8d0]'}`} onClick={() => setSelectedTimes(prev => toggleValue(prev, t))}>{t.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <div className="flex items-start gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0 pt-1">批次</label>
            <div className="flex gap-1.5 flex-wrap">
              <button className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedBatchNums.length === 0 ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-gray-400 border-gray-200'}`} onClick={() => setSelectedBatchNums([])}>全部批次</button>
              {batchFilterOptions.nums.map(n => (
                <button key={n} className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedBatchNums.includes(n) ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-[#875A7B] border-[#d4b8d0]'}`} onClick={() => setSelectedBatchNums(prev => toggleValue(prev, n))}>#{n}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 客户 */}
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
          {selectedCustomers.length === 0
            ? <span className="text-xs text-gray-400">（留空 = 全部客户）</span>
            : <button onClick={() => setSelectedCustomers([])} className="text-xs text-gray-400 hover:text-gray-600">清除</button>}
        </div>
      </div>

      {/* 商品 */}
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
          {selectedProducts.length === 0
            ? <span className="text-xs text-gray-400">（留空 = 全部商品）</span>
            : <button onClick={() => setSelectedProducts([])} className="text-xs text-gray-400 hover:text-gray-600">清除</button>}
        </div>
      </div>

      {/* ── 结果：查看方式切换 ── */}
      <div>
        <div className="px-5 py-3 flex items-center justify-between gap-3 flex-wrap bg-gray-50 border-b border-gray-100">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              筛选结果
              <span className="ml-2 font-normal normal-case text-gray-400">
                {ordersLoading ? '加载中…' : `${reportLines.length} 行 · 合计 ${eur(reportTotal.amount)}`}
              </span>
            </span>
            <div className="flex rounded border border-gray-200 overflow-hidden text-xs">
              {([['customer', '按客户'], ['product', '按商品'], ['category', '按分类'], ['weekday', '按星期趋势']] as [ViewMode, string][]).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setViewMode(v)}
                  className={`px-2.5 py-1 transition-colors ${viewMode === v ? 'bg-[#875A7B] text-white' : 'text-gray-500 hover:bg-gray-50 bg-white'}`}
                >{label}</button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">打印：</span>
            {viewMode === 'category' ? (
              <button
                onClick={handleCategoryPrint}
                disabled={reportLines.length === 0}
                className="px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40"
                style={{ borderColor: '#875A7B', color: '#875A7B' }}
              >打印分类总量</button>
            ) : (
              <>
                <button onClick={() => window.open(buildUrl('day'), '_blank', 'noopener,noreferrer')} disabled={reportLines.length === 0} className="px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40" style={{ borderColor: '#875A7B', color: '#875A7B' }}>日报（按客户）</button>
                <button onClick={() => window.open(buildUrl('multiline'), '_blank', 'noopener,noreferrer')} disabled={reportLines.length === 0} className="px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40" style={{ borderColor: '#875A7B', color: '#875A7B' }}>明细清单</button>
                <button onClick={() => window.open(buildUrl('summary'), '_blank', 'noopener,noreferrer')} disabled={reportLines.length === 0} className="px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40" style={{ borderColor: '#875A7B', color: '#875A7B' }}>商品×星期汇总</button>
              </>
            )}
          </div>
        </div>

        {/* 空态 */}
        {viewMode !== 'weekday' && reportLines.length === 0 ? (
          <div className="px-5 py-8 text-center text-gray-400 text-sm">
            {ordersLoading ? '加载中…' : '当前筛选条件下没有订单行'}
          </div>
        ) : viewMode === 'customer' ? (
          /* 按客户 */
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
                {groupedReport.map(day => <FragmentRows key={day.date} day={day} />)}
                <tr className="bg-[#875A7B]/10 font-bold text-gray-800">
                  <td className="px-4 py-2">总计</td>
                  <td className="px-4 py-2 text-right tabular-nums">{reportTotal.qty.toFixed(3)}</td>
                  <td className="px-4 py-2" />
                  <td className="px-4 py-2 text-right tabular-nums">{eur(reportTotal.amount)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : viewMode === 'product' ? (
          /* 按商品 */
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
        ) : viewMode === 'category' ? (
          /* 按分类（调度）*/
          <div className="p-5 space-y-4">
            <div className="space-y-4">
              {categoryReport.map(cat => (
                <div key={cat.catName} className="rounded-lg border border-gray-100 overflow-hidden">
                  <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                    <span className="text-xs font-semibold text-gray-600 uppercase tracking-wider">{cat.catName}</span>
                    <span className="text-xs text-gray-400">{cat.products.length} SKU · {fmtQty(cat.totalQty)} 件</span>
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="px-3 py-2 text-left text-gray-400 font-normal">产品名称</th>
                        <th className="px-3 py-2 text-center text-gray-400 font-normal w-16">单位</th>
                        <th className="px-3 py-2 text-right text-gray-400 font-normal w-20">数量</th>
                        <th className="px-3 py-2 text-right text-gray-400 font-normal w-24">ATP 库存</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cat.products.map(p => {
                        const atp = p.qtyOnHand - p.qty
                        const color = atp > 0 ? '#10B981' : atp === 0 ? '#F59E0B' : '#8B5CF6'
                        return (
                          <tr key={p.productId || p.name} className="border-b border-gray-50 hover:bg-purple-50 transition-colors">
                            <td className="px-3 py-2 text-gray-800">{p.name}</td>
                            <td className="px-3 py-2 text-center text-gray-500">{p.uomName || '—'}</td>
                            <td className="px-3 py-2 text-right text-gray-700 tabular-nums font-medium">{fmtQty(p.qty)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              <span className="inline-flex items-center gap-1.5 justify-end">
                                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                                <span style={{ color }}>{fmtQty(atp)}</span>
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
            <div className="text-xs text-gray-500 pt-2 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
              <span>合计：{categorySummary.sku} SKU · {fmtQty(categorySummary.qty)} 件</span>
              <span className="text-gray-400">
                ATP 色标：<span className="text-emerald-600">正数=有余量</span> · <span className="text-amber-500">零=刚好用完</span> · <span className="text-violet-500">负数≠缺货（可能当天到货或可临时调货）</span>
              </span>
            </div>
          </div>
        ) : (
          /* 按星期趋势（销售员）*/
          <div className="p-5 space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex rounded border border-gray-200 overflow-hidden text-xs">
                {(['qty', 'amount'] as const).map(m => (
                  <button key={m} onClick={() => setWeekdayMeasure(m)} className={`px-3 py-1.5 transition-colors ${weekdayMeasure === m ? 'bg-[#875A7B] text-white' : 'text-gray-500 hover:bg-gray-50 bg-white'}`}>
                    {m === 'qty' ? '按数量' : '按金额'}
                  </button>
                ))}
              </div>
              <span className="text-xs text-gray-400">日均（每个星期几在所选区间内的平均值）· {focusHint}</span>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={weekdayReport} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} width={56} tickFormatter={v => weekdayMeasure === 'qty' ? `${v}` : `€${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`} />
                <Tooltip formatter={(v) => [weekdayMeasure === 'qty' ? `${Number(v ?? 0)} 件/日均` : `€${Number(v ?? 0).toFixed(0)}/日均`, '']} />
                <Bar dataKey="value" fill="#875A7B" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            {weekdayConclusion && (
              <div className="text-xs text-gray-600 bg-gray-50 rounded-lg px-4 py-2.5 border border-gray-100">{weekdayConclusion}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
