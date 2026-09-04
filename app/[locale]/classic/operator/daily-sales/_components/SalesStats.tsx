'use client'
import { Fragment, useState, useEffect, useMemo, useCallback } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'
import { eur } from '@/lib/format-money'
import type { Order } from '@/lib/types'
import { formatDriverSlotFromOrder, parseDriverSlotKey, type DriverSlotInfo } from '@/lib/driver-slot'
import { toggleValue, today } from './shared'
import ProductSearchInput from '@/components/classic/ProductSearchInput'
import CustomerSearchInput from '@/components/classic/CustomerSearchInput'
import MultiSelectPopover from '@/components/classic/MultiSelectPopover'
import { openAuthedPdf, downloadAuthedFile } from '@/lib/print/open-pdf'
import { downloadCsv } from '@/lib/csv-export'
import { compareSequenceThenName } from '@/lib/print/line-sort'
import {
  buildSalesMatrix,
  matrixToCsvRows,
  type MatrixGranularity,
} from '@/lib/analytics/sales-matrix'

interface CustomerRow { id: string; name: string; street?: string; city?: string; notes?: string; pricelist?: string }
interface ProductRow { id: string; name: string; salePrice?: number; category?: string; categoryId?: string | null; qtyOnHand?: number; uomName?: string; sequence?: number | null }
interface UserRow { id: string; name: string }
interface CategoryRow { id: string; name: string }
interface OrderLine { id: string; productId?: string | null; productName?: string | null; orderedQty?: number | null; unitPrice?: number | null; subtotal?: number | null; uomName?: string | null }

/** 一条摊平的订单行，携带派生的分类/单位/库存/目录顺序号，供四种查看方式共用 */
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
  /** 商品目录/仓库拣货顺序号，勾选「按目录顺序排序」时用来排序；查不到兜底 0 排最前 */
  sequence: number
}

const DOW_LABELS_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const DOW_LABELS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const fmtQty = (v: number) => (v % 1 === 0 ? v.toFixed(0) : v.toFixed(2))

// 按客户查看：单个日期分组（日期头 → 客户 → 商品行 → 日小计）
function FragmentRows({ day, isEn }: { day: { date: string; dateQty: number; dateAmt: number; customers: ReportLine[][] }; isEn: boolean }) {
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
              <td className="px-4 py-1.5 text-right tabular-nums text-gray-700">{l.qty.toFixed(2)}</td>
              <td className="px-4 py-1.5 text-right tabular-nums text-gray-500">{eur(l.unitPrice)}</td>
              <td className="px-4 py-1.5 text-right tabular-nums text-gray-700">{eur(l.amount)}</td>
            </tr>
          ))}
        </Fragment>
      ))}
      <tr className="border-b border-gray-200 bg-gray-50 font-medium text-gray-600">
        <td className="px-4 py-1.5">{isEn ? `Subtotal ${day.date}` : `小计 ${day.date}`}</td>
        <td className="px-4 py-1.5 text-right tabular-nums">{day.dateQty.toFixed(2)}</td>
        <td />
        <td className="px-4 py-1.5 text-right tabular-nums">{eur(day.dateAmt)}</td>
      </tr>
    </>
  )
}

type ViewMode = 'customer' | 'product' | 'category' | 'weekday'

export default function SalesStats({ refreshKey = 0 }: { refreshKey?: number }) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const DOW_LABELS = isEn ? DOW_LABELS_EN : DOW_LABELS_ZH

  // ── 一套筛选条件（驱动下面全部查看方式）──────────────────────────────────
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const [selectedSalesman, setSelectedSalesman] = useState('')
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>([])
  const [selectedTimes, setSelectedTimes] = useState<string[]>([])
  const [selectedBatchNums, setSelectedBatchNums] = useState<number[]>([])
  /** 周一=0…周日=6，跟 weekdaySummaryReport 的星期换算（(getUTCDay()+6)%7）保持同一套编号 */
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>([])
  const [selectedCustomers, setSelectedCustomers] = useState<CustomerRow[]>([])
  const [selectedProducts, setSelectedProducts] = useState<ProductRow[]>([])
  const [customerQuery, setCustomerQuery] = useState('')
  const [productQuery, setProductQuery] = useState('')

  const [allProducts, setAllProducts] = useState<ProductRow[]>([])
  const [allSalesmen, setAllSalesmen] = useState<UserRow[]>([])
  const [allCategories, setAllCategories] = useState<CategoryRow[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [allDriverSlots, setAllDriverSlots] = useState<DriverSlotInfo[]>([])
  /** 客单价/缺货率汇总卡片：只跟 fromDate/toDate 联动，不跟客户/商品筛选联动（全局参考值） */
  const [salesOverview, setSalesOverview] = useState<{ salesExTax: number; orderCount: number; aov: number; shortageRate: number } | null>(null)

  // ── 查看方式 + 度量 ──────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>('customer')
  /** 矩阵排序键：'product' | 'total' | 列下标（按日时列数不固定，用下标而不是星期号）*/
  type WeekdaySortKey = 'product' | 'total' | number
  const [weekdaySortKey, setWeekdaySortKey] = useState<WeekdaySortKey>('product')
  const [weekdaySortDir, setWeekdaySortDir] = useState<'asc' | 'desc'>('asc')
  /** 台账 D9：同一张矩阵，按日（每天一列）/ 按周（周一至周日七列）现场切 */
  const [granularity, setGranularity] = useState<MatrixGranularity>('week')
  /** 勾选后「按客户/按商品/按分类」三种查看方式 + 打印都按商品目录 sequence 排序，不再按默认(插入顺序/金额/数量) */
  // 默认按商品 sequence 排（客户要求 2026-08-18，与所有单据打印同一口径）。
  // ⚠️ 这是**全局默认值**：所有人下次打开这一页看到的顺序都会变，不再是按金额/数量降序。
  //    没有 sequence 的商品（实测订单行里占 18.4%）排在末尾，按名称 A→Z。
  //    取消勾选即可回到原来的排序。
  const [sortBySequence, setSortBySequence] = useState(true)

  // 参考数据（一次加载）
  useEffect(() => {
    apiGet<ProductRow[]>('/api/products?limit=5000').then(d => setAllProducts(Array.isArray(d) ? d : [])).catch(() => {})
    apiGet<UserRow[]>('/api/users').then(d => setAllSalesmen(Array.isArray(d) ? d : [])).catch(() => {})
    apiGet<CategoryRow[]>('/api/product-categories').then(d => setAllCategories(Array.isArray(d) ? d : [])).catch(() => {})
    apiGet<DriverSlotInfo[]>('/api/driver-slots').then(d => setAllDriverSlots(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  // 唯一的订单请求：只按日期区间拉，其余筛选全部在前端做 → 四种查看方式共用这一份数据
  const loadOrders = useCallback(() => {
    if (!fromDate || !toDate) return
    setOrdersLoading(true)
    apiGet<Order[]>(
      `/api/orders?status=CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY,COMPLETED&dateField=deliveryDate&fromDate=${fromDate}&toDate=${toDate}&include_lines=true&limit=5000`
    )
      .then(d => setOrders(Array.isArray(d) ? d : []))
      .catch(() => setOrders([]))
      .finally(() => setOrdersLoading(false))
  }, [fromDate, toDate])

  useEffect(() => { loadOrders() }, [loadOrders])

  // 客单价 / 缺货率汇总卡片：跟 fromDate/toDate 走同一个组合 API，保证和「数据分析中心」口径一致
  useEffect(() => {
    if (!fromDate || !toDate) return
    // 汇总口径全部取服务端的 summary（SSOT 在 lib/analytics/metrics.summarizeSalesSeries）——
    // 这里原来自己 reduce 了一份客单价，同一个公式两处实现，迟早漂
    apiGet<{
      summary: { salesExTax: number; orderCount: number; aov: number }
      shortage: { summary: { shortageRate: number } }
    }>(`/api/analytics/sales-overview?from=${fromDate}&to=${toDate}`)
      .then((d) => {
        setSalesOverview({
          salesExTax: d.summary.salesExTax,
          orderCount: d.summary.orderCount,
          aov: d.summary.aov,
          shortageRate: d.shortage.summary.shortageRate,
        })
      })
      .catch(() => setSalesOverview(null))
  }, [fromDate, toDate])

  // 页头「刷新」：跳过首次挂载，之后 refreshKey 变化按当前区间重拉订单
  useEffect(() => {
    if (refreshKey === 0) return
    loadOrders()
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // 司机/时段/批次选项：来自司机配置（稳定全集），不依赖当前区间是否已排线
  const batchFilterOptions = useMemo(() => {
    const drivers = new Set<string>()
    const times = new Set<string>()
    const nums = new Set<number>()
    for (const s of allDriverSlots) {
      if (s.driverName) drivers.add(s.driverName)
      if (s.timeOfDay) times.add(s.timeOfDay.toLowerCase())
      if (s.batchNum != null) nums.add(Number(s.batchNum))
    }
    return {
      drivers: [...drivers].sort(),
      times: [...times].sort(),
      nums: [...nums].sort((a, b) => a - b),
    }
  }, [allDriverSlots])

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
      if (selectedWeekdays.length > 0) {
        const dow = (new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7
        if (!selectedWeekdays.includes(dow)) continue
      }
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
          categoryName: prod?.category ?? (isEn ? 'Uncategorized' : '未分类'),
          uomName: l.uomName ?? prod?.uomName ?? '',
          qty: Number(l.orderedQty ?? 0),
          unitPrice: Number(l.unitPrice ?? 0),
          amount: Number(l.subtotal ?? 0),
          qtyOnHand: Number(prod?.qtyOnHand ?? 0),
          sequence: prod?.sequence ?? 0,
        })
      }
    }
    return out.sort((a, b) =>
      a.date.localeCompare(b.date)
      || a.customerName.localeCompare(b.customerName)
      || (sortBySequence ? compareSequenceThenName(a.sequence, a.productName, b.sequence, b.productName) : 0))
  }, [orders, selectedCustomers, selectedProducts, selectedCategories, selectedSalesman, selectedDrivers, selectedTimes, selectedBatchNums, selectedWeekdays, sortBySequence, productMap, isEn])

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
    const m = new Map<string, { name: string; qty: number; amount: number; customers: Set<string>; sequence: number }>()
    for (const l of reportLines) {
      const e = m.get(l.productName) ?? { name: l.productName, qty: 0, amount: 0, customers: new Set<string>(), sequence: l.sequence }
      e.qty += l.qty
      e.amount += l.amount
      e.customers.add(l.customerId)
      m.set(l.productName, e)
    }
    return [...m.values()]
      .map(v => ({ name: v.name, qty: v.qty, amount: v.amount, customerCount: v.customers.size, avgPrice: v.qty > 0 ? v.amount / v.qty : 0, sequence: v.sequence }))
      .sort((a, b) => sortBySequence ? compareSequenceThenName(a.sequence, a.name, b.sequence, b.name) : b.amount - a.amount)
  }, [reportLines, sortBySequence])

  // 查看方式③：按分类（分类 → 商品，带 ATP）—— 调度备货
  const categoryReport = useMemo(() => {
    const catMap = new Map<string, Map<string, { productId: string; name: string; uomName: string; qty: number; qtyOnHand: number; sequence: number }>>()
    for (const l of reportLines) {
      if (!catMap.has(l.categoryName)) catMap.set(l.categoryName, new Map())
      const prods = catMap.get(l.categoryName)!
      const key = l.productId || l.productName
      const ex = prods.get(key)
      if (ex) ex.qty += l.qty
      else prods.set(key, { productId: l.productId, name: l.productName, uomName: l.uomName, qty: l.qty, qtyOnHand: l.qtyOnHand, sequence: l.sequence })
    }
    return [...catMap.entries()]
      .map(([catName, prods]) => {
        const products = [...prods.values()].sort((a, b) => sortBySequence ? compareSequenceThenName(a.sequence, a.name, b.sequence, b.name) : b.qty - a.qty)
        return { catName, products, totalQty: products.reduce((s, p) => s + p.qty, 0) }
      })
      .sort((a, b) => a.catName.localeCompare(b.catName))
  }, [reportLines, sortBySequence])

  const categorySummary = useMemo(() => ({
    sku: categoryReport.reduce((s, c) => s + c.products.length, 0),
    qty: categoryReport.reduce((s, c) => s + c.totalQty, 0),
  }), [categoryReport])

  // 查看方式④：销售矩阵（商品 × 日期 / 商品 × 星期）——台账 D9
  // 汇总逻辑在 lib/analytics/sales-matrix.ts（纯函数），屏幕表格与 CSV 导出共用同一份结果，
  // 「导出的和屏幕上看到的不一样」从结构上就不可能发生。
  // 星期换算与打印模板 day-wise-report-template 的 dayOfWeek() 同一套编号。
  const salesMatrix = useMemo(
    () => buildSalesMatrix(reportLines, granularity, DOW_LABELS),
    [reportLines, granularity, DOW_LABELS],
  )

  const matrixRowsSorted = useMemo(() => {
    const rows = [...salesMatrix.rows]
    if (weekdaySortKey === 'product') {
      rows.sort((a, b) => sortBySequence ? compareSequenceThenName(a.sequence, a.productName, b.sequence, b.productName) : a.productName.localeCompare(b.productName))
    } else if (weekdaySortKey === 'total') {
      rows.sort((a, b) => a.totalQty - b.totalQty)
    } else {
      const col = weekdaySortKey
      rows.sort((a, b) => (a.qty[col] ?? 0) - (b.qty[col] ?? 0))
    }
    if (weekdaySortDir === 'desc') rows.reverse()
    return rows
  }, [salesMatrix, weekdaySortKey, weekdaySortDir, sortBySequence])

  /** 导出给采购：所见即所得，用的就是屏幕上这张矩阵 */
  function exportMatrixCsv() {
    const { headers, rows } = matrixToCsvRows(
      { ...salesMatrix, rows: matrixRowsSorted },
      isEn
        ? { product: 'Product', uom: 'Unit', total: 'Total Qty', amount: 'Amount', onHand: 'On Hand', atp: 'ATP', grand: 'Grand Total' }
        : { product: '产品', uom: '单位', total: '数量合计', amount: '金额合计', onHand: '当前库存', atp: '可承诺 ATP', grand: '合计' },
    )
    const kind = granularity === 'week' ? (isEn ? 'by-weekday' : '按星期') : (isEn ? 'by-day' : '按日')
    downloadCsv(`${isEn ? 'sales-matrix' : '销售矩阵'}-${kind}-${fromDate}_${toDate}`, headers, rows)
  }

  function toggleWeekdaySort(key: WeekdaySortKey) {
    if (weekdaySortKey === key) {
      setWeekdaySortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setWeekdaySortKey(key)
      setWeekdaySortDir(key === 'product' ? 'asc' : 'desc')
    }
  }

  function weekdaySortArrow(key: WeekdaySortKey) {
    if (weekdaySortKey !== key) return null
    return <span className="ml-0.5">{weekdaySortDir === 'asc' ? '▲' : '▼'}</span>
  }

  // ── 打印：走服务端 PDF（跟送货单/汇总单一致），不再是客户端 window.print()——
  // 浏览器自己加的默认页头页脚(打印时间/文档标题/URL/页码)丑且不受控，客户反馈(20260718)
  // 要求去掉；服务端 PDF 页头/页脚完全由我们自己画。────────────────────────────
  function buildPrintUrl(mode: 'day' | 'multiline' | 'summary') {
    const params = new URLSearchParams({ mode, from: fromDate, to: toDate })
    if (selectedCustomers.length > 0) params.set('customerIds', selectedCustomers.map(c => c.id).join(','))
    if (selectedProducts.length > 0) params.set('productNames', selectedProducts.map(p => p.name).join(','))
    if (selectedDrivers.length > 0) params.set('drivers', selectedDrivers.join(','))
    if (selectedTimes.length > 0) params.set('times', selectedTimes.join(','))
    if (selectedBatchNums.length > 0) params.set('batchNums', selectedBatchNums.join(','))
    if (selectedWeekdays.length > 0) params.set('weekdays', selectedWeekdays.join(','))
    if (selectedCategories.length > 0) params.set('categoryIds', selectedCategories.join(','))
    if (selectedSalesman) params.set('salesUserId', selectedSalesman)
    if (sortBySequence) params.set('sortBySequence', '1')
    return `/api/print/day-wise-report-pdf?${params.toString()}`
  }

  function handlePrint(mode: 'day' | 'multiline' | 'summary') {
    openAuthedPdf(buildPrintUrl(mode)).catch(e => alert(e instanceof Error ? e.message : (isEn ? 'Print failed' : '打印失败')))
  }

  // 会计导出:跟屏幕/打印同一套筛选参数(buildPrintUrl 的 querystring 部分)，走 CSV 路由
  const [exporting, setExporting] = useState<'summary' | 'detail' | null>(null)
  function buildExportUrl(kind: 'summary' | 'detail') {
    const url = buildPrintUrl('day')
    const sep = url.includes('?') ? '&' : '?'
    return url.replace('/api/print/day-wise-report-pdf', '/api/print/day-wise-report-csv') + `${sep}kind=${kind}`
  }
  async function handleExport(kind: 'summary' | 'detail') {
    if (exporting) return
    setExporting(kind)
    try {
      const filenameZh = kind === 'summary' ? '订单汇总' : '产品明细'
      const filenameEn = kind === 'summary' ? 'order-summary' : 'product-detail'
      await downloadAuthedFile(buildExportUrl(kind), `${isEn ? filenameEn : filenameZh}.csv`)
    } catch (e) {
      alert(e instanceof Error ? e.message : (isEn ? 'Export failed' : '导出失败'))
    } finally {
      setExporting(null)
    }
  }

  // 按分类查看的专属打印：直接渲染屏幕上的 categoryReport，保证所见即所打
  // 打印内容(送到仓库调度备货用的实体单据)按团队约定始终保持中文，不随界面 locale 切换——
  // 与 lib/print/* 系列单据同一原则(纸质单据是给一线员工用的)
  function handleCategoryPrint() {
    const w = window.open('', '_blank', 'noopener,width=800,height=700')
    if (!w) return
    const unitLabel = '件'
    const catsHtml = categoryReport.map(cat => `
      <div style="margin-bottom:16px;">
        <div style="background:#f3f4f6;padding:6px 12px;font-weight:bold;font-size:13px;border-radius:4px 4px 0 0;">${cat.catName} <span style="font-weight:normal;font-size:11px;color:#6b7280;">${cat.products.length} SKU · ${fmtQty(cat.totalQty)} ${unitLabel}</span></div>
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
    const titleLabel = '分类总量'
    const dateLabel = '日期'
    const categoryLabel = '分类'
    const totalLabel = '合计'
    const atpLegend = `ATP 色标：<span style="color:#10B981;">正数 = 有余量</span> · <span style="color:#F59E0B;">零 = 刚好用完</span> · <span style="color:#8B5CF6;">负数 ≠ 缺货（可能当天到货或可临时调货）</span>`
    w.document.write(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${titleLabel} · ${fromDate}${toDate !== fromDate ? ' ~ ' + toDate : ''}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#fff;padding:20px}@media print{@page{margin:1cm}body{padding:0}}</style>
</head><body>
<div style="margin-bottom:16px;padding-bottom:12px;border-bottom:1px dashed #e5e7eb;font-size:12px;color:#6b7280;">
  <b style="font-size:15px;color:#111;">${titleLabel}</b>&nbsp;&nbsp;${dateLabel}：<b style="color:#111;">${fromDate}${toDate !== fromDate ? ' ~ ' + toDate : ''}</b>&nbsp;&nbsp;${categoryLabel}：<b style="color:#111;">${catLabel}</b>&nbsp;&nbsp;${totalLabel}：<b style="color:#111;">${categorySummary.sku} SKU · ${fmtQty(categorySummary.qty)} ${unitLabel}</b>
  <div style="margin-top:4px;">${atpLegend}</div>
</div>
${catsHtml}
<script>window.print();<\/script>
</body></html>`)
    w.document.close()
    w.focus()
  }

  const selectCls = 'border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-purple-400 bg-white'

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
              <option value="">{isEn ? 'All Salespeople' : '全部业务员'}</option>
              {allSalesmen.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="flex items-start gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0 pt-1.5">{isEn ? 'Categories (multi)' : '分类（多选）'}</label>
            <div className="flex items-center gap-1.5 flex-wrap flex-1">
              <MultiSelectPopover
                label={isEn ? 'Category' : '分类'}
                options={allCategories.map(c => ({ value: c.id, label: c.name }))}
                selected={selectedCategories}
                onChange={setSelectedCategories}
                searchable
                searchPlaceholder={isEn ? 'Search categories…' : '搜索分类…'}
              />
              {selectedCategories.map(id => (
                <span key={id} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-[#f3edf7] text-[#875A7B] rounded border border-[#d4b8e0]">
                  {allCategories.find(c => c.id === id)?.name ?? id}
                  <button onClick={() => setSelectedCategories(prev => prev.filter(x => x !== id))} className="hover:text-red-500 leading-none">×</button>
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* 司机 / AM-PM / 批次 */}
        <div className="space-y-2 pt-2 border-t border-dashed border-gray-100">
          <div className="flex items-start gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0 pt-1">{isEn ? 'Driver' : '司机'}</label>
            <div className="flex items-center gap-1.5 flex-wrap flex-1">
              <MultiSelectPopover
                label={isEn ? 'Driver' : '司机'}
                options={batchFilterOptions.drivers.map(d => ({ value: d, label: d }))}
                selected={selectedDrivers}
                onChange={setSelectedDrivers}
                searchable
                searchPlaceholder={isEn ? 'Search drivers…' : '搜索司机…'}
              />
              {selectedDrivers.map(d => (
                <span key={d} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-[#f3edf7] text-[#875A7B] rounded border border-[#d4b8e0]">
                  {d}
                  <button onClick={() => setSelectedDrivers(prev => prev.filter(x => x !== d))} className="hover:text-red-500 leading-none">×</button>
                </span>
              ))}
            </div>
          </div>
          <div className="flex items-start gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0 pt-1">AM / PM</label>
            <div className="flex gap-1.5 flex-wrap">
              <button className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedTimes.length === 0 ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-gray-400 border-gray-200'}`} onClick={() => setSelectedTimes([])}>{isEn ? 'All time slots' : '全部时段'}</button>
              {batchFilterOptions.times.map(t => (
                <button key={t} className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedTimes.includes(t) ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-[#875A7B] border-[#d4b8d0]'}`} onClick={() => setSelectedTimes(prev => toggleValue(prev, t))}>{t.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <div className="flex items-start gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0 pt-1">{isEn ? 'Batch' : '批次'}</label>
            <div className="flex gap-1.5 flex-wrap">
              <button className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedBatchNums.length === 0 ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-gray-400 border-gray-200'}`} onClick={() => setSelectedBatchNums([])}>{isEn ? 'All batches' : '全部批次'}</button>
              {batchFilterOptions.nums.map(n => (
                <button key={n} className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedBatchNums.includes(n) ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-[#875A7B] border-[#d4b8d0]'}`} onClick={() => setSelectedBatchNums(prev => toggleValue(prev, n))}>#{n}</button>
              ))}
            </div>
          </div>
          <div className="flex items-start gap-3">
            <label className="w-28 text-xs text-gray-500 shrink-0 pt-1">{isEn ? 'Weekday' : '星期'}</label>
            <div className="flex gap-1.5 flex-wrap">
              <button className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedWeekdays.length === 0 ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-gray-400 border-gray-200'}`} onClick={() => setSelectedWeekdays([])}>{isEn ? 'All weekdays' : '全部星期'}</button>
              {DOW_LABELS.map((label, i) => (
                <button key={i} className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selectedWeekdays.includes(i) ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'bg-white text-[#875A7B] border-[#d4b8d0]'}`} onClick={() => setSelectedWeekdays(prev => toggleValue(prev, i))}>{label}</button>
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
            placeholder={isEn ? 'Search customers…' : '搜索客户…'}
            inputClassName="border border-gray-300 rounded px-2 py-0.5 text-xs w-40 focus:outline-none focus:border-[#875A7B]"
          />
          {selectedCustomers.length === 0
            ? <span className="text-xs text-gray-400">{isEn ? '(Empty = all customers)' : '（留空 = 全部客户）'}</span>
            : <button onClick={() => setSelectedCustomers([])} className="text-xs text-gray-400 hover:text-gray-600">{isEn ? 'Clear' : '清除'}</button>}
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
            placeholder={isEn ? 'Search products…' : '搜索商品…'}
            inputClassName="border border-gray-300 rounded px-2 py-0.5 text-xs w-40 focus:outline-none focus:border-[#875A7B]"
            showOnEmptyQuery={false}
            selectOnTab
          />
          {selectedProducts.length === 0
            ? <span className="text-xs text-gray-400">{isEn ? '(Empty = all products)' : '（留空 = 全部商品）'}</span>
            : <button onClick={() => setSelectedProducts([])} className="text-xs text-gray-400 hover:text-gray-600">{isEn ? 'Clear' : '清除'}</button>}
        </div>
      </div>

      {/* ── 结果：查看方式切换 ── */}
      <div>
        <div className="px-5 py-3 flex items-center justify-between gap-3 flex-wrap bg-gray-50 border-b border-gray-100">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              {isEn ? 'Filtered Results' : '筛选结果'}
              <span className="ml-2 font-normal normal-case text-gray-400">
                {ordersLoading ? (isEn ? 'Loading…' : '加载中…') : (isEn ? `${reportLines.length} rows · Total ${eur(reportTotal.amount)}` : `${reportLines.length} 行 · 合计 ${eur(reportTotal.amount)}`)}
              </span>
              <span className="ml-3 font-normal normal-case inline-flex items-center gap-1.5">
                <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600" title={isEn ? 'Sales (ex. tax) in the selected date range, all customers/products' : '所选日期区间的销售额（税前），不受客户/商品筛选影响'}>
                  {isEn ? 'Sales' : '销售额'} {salesOverview ? eur(salesOverview.salesExTax) : '—'}
                  {salesOverview ? <span className="text-gray-400">{isEn ? ` / ${salesOverview.orderCount} orders` : ` / ${salesOverview.orderCount} 单`}</span> : null}
                </span>
                <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600" title={isEn ? 'AOV = total sales (ex. tax) / order count' : '客单价 = 区间销售额（税前）÷ 区间订单数'}>
                  {isEn ? 'AOV' : '客单价'} {salesOverview ? eur(salesOverview.aov) : '—'}
                </span>
                <span className={`px-2 py-0.5 rounded ${salesOverview && salesOverview.shortageRate > 0 ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-600'}`}>
                  {isEn ? 'Shortage rate' : '缺货率'} {salesOverview ? `${(salesOverview.shortageRate * 100).toFixed(1)}%` : '—'}
                </span>
                <span className="text-gray-400">{isEn ? '(all customers/products)' : '（全部客户/商品）'}</span>
              </span>
            </span>
            <div className="flex rounded border border-gray-200 overflow-hidden text-xs">
              {(isEn
                ? ([['customer', 'By Customer'], ['product', 'By Product'], ['category', 'By Category'], ['weekday', 'Product × Day / Weekday']] as [ViewMode, string][])
                : ([['customer', '按客户'], ['product', '按商品'], ['category', '按分类'], ['weekday', '商品×日期/星期']] as [ViewMode, string][])
              ).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setViewMode(v)}
                  className={`px-2.5 py-1 transition-colors ${viewMode === v ? 'bg-[#875A7B] text-white' : 'text-gray-500 hover:bg-gray-50 bg-white'}`}
                >{label}</button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
              <input type="checkbox" checked={sortBySequence} onChange={e => setSortBySequence(e.target.checked)} className="accent-[#875A7B]" />
              {isEn ? 'Sort by catalog sequence' : '按商品目录顺序排序'}
            </label>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">{isEn ? 'Print:' : '打印：'}</span>
            {viewMode === 'category' ? (
              <button
                onClick={handleCategoryPrint}
                disabled={reportLines.length === 0}
                className="px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40"
                style={{ borderColor: '#875A7B', color: '#875A7B' }}
              >{isEn ? 'Print Category Totals' : '打印分类总量'}</button>
            ) : (
              <>
                <button onClick={() => handlePrint('day')} disabled={reportLines.length === 0} className="px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40" style={{ borderColor: '#875A7B', color: '#875A7B' }}>{isEn ? 'Daily Report (By Customer)' : '日报（按客户）'}</button>
                <button onClick={() => handlePrint('multiline')} disabled={reportLines.length === 0} className="px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40" style={{ borderColor: '#875A7B', color: '#875A7B' }}>{isEn ? 'Detail List' : '明细清单'}</button>
                <button onClick={() => handlePrint('summary')} disabled={reportLines.length === 0} className="px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40" style={{ borderColor: '#875A7B', color: '#875A7B' }}>{isEn ? 'Product × Weekday Summary' : '商品×星期汇总'}</button>
                <span className="text-xs text-gray-400 ml-2">{isEn ? 'Export:' : '导出：'}</span>
                <button onClick={() => handleExport('summary')} disabled={reportLines.length === 0 || exporting !== null} className="px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40" style={{ borderColor: '#2d6a4f', color: '#2d6a4f' }}>{exporting === 'summary' ? (isEn ? 'Exporting…' : '导出中…') : (isEn ? 'Order Summary (CSV)' : '订单汇总（CSV）')}</button>
                <button onClick={() => handleExport('detail')} disabled={reportLines.length === 0 || exporting !== null} className="px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40" style={{ borderColor: '#2d6a4f', color: '#2d6a4f' }}>{exporting === 'detail' ? (isEn ? 'Exporting…' : '导出中…') : (isEn ? 'Product Detail (CSV)' : '产品明细（CSV）')}</button>
              </>
            )}
          </div>
        </div>

        {/* 空态 */}
        {reportLines.length === 0 ? (
          <div className="px-5 py-8 text-center text-gray-400 text-sm">
            {ordersLoading ? (isEn ? 'Loading…' : '加载中…') : (isEn ? 'No order lines match the current filters' : '当前筛选条件下没有订单行')}
          </div>
        ) : viewMode === 'customer' ? (
          /* 按客户 */
          <div className="max-h-[480px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white shadow-sm">
                <tr className="border-b border-gray-200">
                  <th className="px-4 py-2 text-left text-gray-400 font-medium">{isEn ? 'Product' : '产品'}</th>
                  <th className="px-4 py-2 text-right text-gray-400 font-medium w-24">{isEn ? 'Qty' : '数量'}</th>
                  <th className="px-4 py-2 text-right text-gray-400 font-medium w-24">{isEn ? 'Unit Price' : '单价'}</th>
                  <th className="px-4 py-2 text-right text-gray-400 font-medium w-28">{isEn ? 'Amount' : '金额'}</th>
                </tr>
              </thead>
              <tbody>
                {groupedReport.map(day => <FragmentRows key={day.date} day={day} isEn={isEn} />)}
                <tr className="bg-[#875A7B]/10 font-bold text-gray-800">
                  <td className="px-4 py-2">{isEn ? 'Total' : '总计'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{reportTotal.qty.toFixed(2)}</td>
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
                  <th className="px-4 py-2 text-left text-gray-400 font-medium">{isEn ? 'Product' : '产品'}</th>
                  <th className="px-4 py-2 text-right text-gray-400 font-medium w-20">{isEn ? 'Customers' : '客户数'}</th>
                  <th className="px-4 py-2 text-right text-gray-400 font-medium w-24">{isEn ? 'Total Qty' : '数量合计'}</th>
                  <th className="px-4 py-2 text-right text-gray-400 font-medium w-24">{isEn ? 'Avg Price' : '均价'}</th>
                  <th className="px-4 py-2 text-right text-gray-400 font-medium w-28">{isEn ? 'Total Amount' : '金额合计'}</th>
                </tr>
              </thead>
              <tbody>
                {productReport.map(p => (
                  <tr key={p.name} className="border-b border-gray-50 hover:bg-purple-50/30">
                    <td className="px-4 py-1.5 text-gray-700">{p.name}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-gray-500">{p.customerCount}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-gray-700">{p.qty.toFixed(2)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-gray-500">{eur(p.avgPrice)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-gray-700">{eur(p.amount)}</td>
                  </tr>
                ))}
                <tr className="bg-[#875A7B]/10 font-bold text-gray-800">
                  <td className="px-4 py-2">{isEn ? 'Total' : '总计'}</td>
                  <td className="px-4 py-2" />
                  <td className="px-4 py-2 text-right tabular-nums">{reportTotal.qty.toFixed(2)}</td>
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
                    <span className="text-xs text-gray-400">{cat.products.length} SKU · {fmtQty(cat.totalQty)} {isEn ? 'units' : '件'}</span>
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="px-3 py-2 text-left text-gray-400 font-normal">{isEn ? 'Product Name' : '产品名称'}</th>
                        <th className="px-3 py-2 text-center text-gray-400 font-normal w-16">{isEn ? 'Unit' : '单位'}</th>
                        <th className="px-3 py-2 text-right text-gray-400 font-normal w-20">{isEn ? 'Qty' : '数量'}</th>
                        <th className="px-3 py-2 text-right text-gray-400 font-normal w-24">{isEn ? 'ATP Stock' : 'ATP 库存'}</th>
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
              <span>{isEn ? 'Total' : '合计'}：{categorySummary.sku} SKU · {fmtQty(categorySummary.qty)} {isEn ? 'units' : '件'}</span>
              <span className="text-gray-400">
                {isEn ? (
                  <>ATP color code: <span className="text-emerald-600">positive=surplus</span> · <span className="text-amber-500">zero=exactly used up</span> · <span className="text-violet-500">negative≠out of stock (may arrive same day or be sourced ad hoc)</span></>
                ) : (
                  <>ATP 色标：<span className="text-emerald-600">正数=有余量</span> · <span className="text-amber-500">零=刚好用完</span> · <span className="text-violet-500">负数≠缺货（可能当天到货或可临时调货）</span></>
                )}
              </span>
            </div>
          </div>
        ) : (
          /* 销售矩阵：商品 × 日期（按日）/ 商品 × 星期（按周）——台账 D9
             星期口径与打印「商品×星期汇总」一致；额外带当前库存与 ATP，供采购判断补货 */
          <div>
            <div className="px-4 py-2 flex items-center gap-2 flex-wrap border-b border-gray-100 bg-white">
              <span className="text-xs text-gray-400">{isEn ? 'Granularity:' : '维度：'}</span>
              {([['day', isEn ? 'By day' : '按日'], ['week', isEn ? 'By weekday' : '按周']] as [MatrixGranularity, string][]).map(([g, label]) => (
                <button
                  key={g}
                  onClick={() => { setGranularity(g); setWeekdaySortKey('product') }}
                  className={`px-2.5 py-0.5 rounded text-xs border transition-colors ${
                    granularity === g ? 'bg-[#875A7B] text-white border-[#875A7B]' : 'border-gray-300 text-gray-500 hover:border-[#875A7B]'
                  }`}
                >{label}</button>
              ))}
              <span className="text-xs text-gray-400 ml-1">
                {granularity === 'week'
                  ? (isEn ? 'Mon–Sun columns aggregate every matching weekday in the range' : '周一至周日各列 = 区间内所有该星期几的合计')
                  : (isEn ? 'One column per delivery date in the range' : '区间内每个配送日一列')}
              </span>
              <button
                onClick={exportMatrixCsv}
                disabled={salesMatrix.rows.length === 0}
                className="ml-auto px-3 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-40"
                style={{ borderColor: '#2d6a4f', color: '#2d6a4f' }}
                title={isEn ? 'Export exactly this matrix (for purchasing)' : '把屏幕上这张矩阵原样导出（给采购）'}
              >{isEn ? 'Export matrix (CSV)' : '导出矩阵（CSV）'}</button>
            </div>
            <div className="max-h-[480px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white shadow-sm">
                  <tr className="border-b border-gray-200">
                    <th
                      onClick={() => toggleWeekdaySort('product')}
                      className="px-4 py-2 text-left text-gray-400 font-medium cursor-pointer select-none hover:text-gray-600"
                    >{isEn ? 'Product' : '产品'}{weekdaySortArrow('product')}</th>
                    {salesMatrix.columns.map((c, i) => (
                      <th
                        key={c.key}
                        onClick={() => toggleWeekdaySort(i)}
                        className="px-3 py-2 text-right text-gray-400 font-medium w-16 cursor-pointer select-none hover:text-gray-600 whitespace-nowrap"
                      >{c.label}{weekdaySortArrow(i)}</th>
                    ))}
                    <th
                      onClick={() => toggleWeekdaySort('total')}
                      className="px-4 py-2 text-right text-gray-400 font-medium w-24 cursor-pointer select-none hover:text-gray-600"
                    >{isEn ? 'Total Qty' : '数量合计'}{weekdaySortArrow('total')}</th>
                    <th className="px-3 py-2 text-right text-gray-400 font-medium w-24">{isEn ? 'Amount' : '金额合计'}</th>
                    <th className="px-3 py-2 text-right text-gray-400 font-medium w-20">{isEn ? 'On Hand' : '当前库存'}</th>
                    <th className="px-3 py-2 text-right text-gray-400 font-medium w-20">{isEn ? 'ATP' : 'ATP'}</th>
                  </tr>
                </thead>
                <tbody>
                  {matrixRowsSorted.map(r => (
                    <tr key={r.productId || r.productName} className="border-b border-gray-50 hover:bg-purple-50/30">
                      <td className="px-4 py-1.5 text-gray-700">{r.productName}</td>
                      {r.qty.map((q, i) => (
                        <td key={i} className="px-3 py-1.5 text-right tabular-nums text-gray-700">{q > 0 ? fmtQty(q) : ''}</td>
                      ))}
                      <td className="px-4 py-1.5 text-right tabular-nums font-medium text-gray-700">{fmtQty(r.totalQty)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{eur(r.totalAmount)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{fmtQty(r.qtyOnHand)}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${r.atp > 0 ? 'text-emerald-600' : r.atp === 0 ? 'text-amber-500' : 'text-violet-500'}`}>{fmtQty(r.atp)}</td>
                    </tr>
                  ))}
                  <tr className="bg-[#875A7B]/10 font-bold text-gray-800">
                    <td className="px-4 py-2">{isEn ? 'Grand Total' : '合计'}</td>
                    {salesMatrix.grand.qty.map((q, i) => (
                      <td key={i} className="px-3 py-2 text-right tabular-nums">{q > 0 ? fmtQty(q) : ''}</td>
                    ))}
                    <td className="px-4 py-2 text-right tabular-nums">{fmtQty(salesMatrix.grand.totalQty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{eur(salesMatrix.grand.totalAmount)}</td>
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2" />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
