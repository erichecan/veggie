'use client'
import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut, apiPost } from '@/lib/api'
import type { Order, OrderStatus, Invoice } from '@/lib/types'
import { displayOrderCode } from '@/lib/order-code'
import OrderMobileList from '@/components/classic/OrderMobileList'
import { DateWithDay } from '@/components/shared/date-with-day'
import { formatDateTimeShort } from '@/lib/format-date'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { Pagination } from '@/components/ui/pagination'
import { DatePicker } from '@/components/ui/date-picker'
import { useServerList } from '@/hooks/use-server-list'
import { formatDriverSlotFromOrder, type DriverSlotInfo } from '@/lib/driver-slot'
import { DriverSlotCombobox } from '@/components/shared/driver-slot-combobox'
import { getSession } from '@/lib/session'
import { type Facet, ORDER_FACET_FIELDS, applyFacets, localizeFacetFields, TIME_QUICK_OPTIONS, TIME_QUICK_LABEL, computeTimeRange, groupFacets } from '@/lib/list-filters'
import { downloadAuthedFile } from '@/lib/print/open-pdf'
import { useRefetchOnFocus } from '@/lib/hooks/use-refetch-on-focus'
import { writeRecordNavQuery, listNavQuery } from '@/lib/hooks/use-record-nav'
import { useCsvExport } from '@/hooks/use-csv-export'
import { parseCsv, downloadCsv } from '@/lib/csv-export'
import { orderLineExportColumns } from '@/lib/export/columns/order-lines'

const PAGE_SIZE = 50

const STATUS_LABEL_ZH: Record<OrderStatus, string> = {
  pending:       '待处理',
  confirmed:     '已确认',
  wave_assigned: '司机分配结束',
  in_delivery:   '配送中',
  completed:     '已完成',
  locked:        '拣货中',
  cancelled:     '已取消',
}

const STATUS_LABEL_EN: Record<OrderStatus, string> = {
  pending:       'Pending',
  confirmed:     'Confirmed',
  wave_assigned: 'Driver Assigned',
  in_delivery:   'In Delivery',
  completed:     'Completed',
  locked:        'Picking',
  cancelled:     'Cancelled',
}

const STATUS_COLOR: Record<OrderStatus, string> = {
  pending:       'bg-yellow-50 text-yellow-700',
  confirmed:     'bg-blue-50 text-blue-700',
  wave_assigned: 'bg-blue-50 text-blue-700',
  in_delivery:   'bg-purple-50 text-purple-700',
  completed:     'bg-green-50 text-green-700',
  locked:        'bg-gray-200 text-gray-700',
  cancelled:     'bg-red-50 text-red-600',
}

type ActiveFilter = 'all' | 'to_invoice' | 'return_open' | OrderStatus

type ColFilters = {
  code: string
  deliveryDateFrom: string
  deliveryDateTo: string
  createdBy: string
  customer: string
  salesman: string
  deliveryBatch: string
  invoiceStatus: string
  status: string
  createdAtFrom: string
  createdAtTo: string
}

const EMPTY_FILTERS: ColFilters = {
  code: '', deliveryDateFrom: '', deliveryDateTo: '', createdBy: '',
  customer: '', salesman: '', deliveryBatch: '',
  invoiceStatus: '', status: '', createdAtFrom: '', createdAtTo: '',
}

function normalizeStatus(s: string | null | undefined): OrderStatus {
  if (!s) return 'pending'
  return s.toLowerCase() as OrderStatus
}

function norm(s: string | null | undefined): string {
  return s ? s.toLowerCase().trim() : ''
}

// CSV 导入列定义(销售单)，与采购单导入同一模式(lib/export/columns/purchase-orders.ts 对应页)：
// 中文表头为主约定，英文表头作为别名同样可被识别(匹配大小写不敏感)。单价/税率留空时
// 由服务端权威定价(lib/server-pricing.ts resolveOrderLines)按价格表算，不像采购单那样必填。
const SO_IMPORT_COLUMNS: { key: string; zh: string; en: string; required?: boolean }[] = [
  { key: 'customer',     zh: '客户名称', en: 'Customer Name', required: true },
  { key: 'product',      zh: '商品名称', en: 'Product Name',  required: true },
  { key: 'productRef',   zh: '商品编号', en: 'Product Ref' },
  { key: 'quantity',     zh: '数量',     en: 'Quantity',      required: true },
  { key: 'unitPrice',    zh: '单价',     en: 'Unit Price' },
  { key: 'taxRate',      zh: '税率',     en: 'Tax Rate' },
  { key: 'isGift',       zh: '赠品',     en: 'Gift' },
  { key: 'deliveryDate', zh: '交货日期', en: 'Delivery Date' },
  { key: 'notes',        zh: '备注',     en: 'Notes' },
]

function DateCell({ iso }: { iso: string | null | undefined }) {
  return (
    <span title={formatDateTimeShort(iso)}>
      <DateWithDay date={iso} />
    </span>
  )
}

function getField(o: Order, key: string): string {
  return String((o as unknown as Record<string, unknown>)[key] ?? '')
}

function invoiceStatusFor(o: Order, invoicedIds: Set<string>): string {
  if (invoicedIds.has(o.id)) return 'invoiced'
  if (o.status === 'completed') return 'to_invoice'
  return 'nothing'
}

export default function ClassicOrdersPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale
  const STATUS_LABEL = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH

  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('all')
  const [colFilters, setColFilters] = useState<ColFilters>(EMPTY_FILTERS)
  // code/customer/salesman/driver/createdBy 列筛选框下推到服务端查询(见 baseUrl),防抖 400ms 避免逐字符触发请求
  const [debouncedColText, setDebouncedColText] = useState({ code: '', customer: '', salesman: '', driver: '', createdBy: '' })
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedColText({ code: colFilters.code, customer: colFilters.customer, salesman: colFilters.salesman, driver: colFilters.deliveryBatch, createdBy: colFilters.createdBy })
    }, 400)
    return () => clearTimeout(t)
  }, [colFilters.code, colFilters.customer, colFilters.salesman, colFilters.deliveryBatch, colFilters.createdBy])
  // 分面搜索 + 快捷筛选(My / 时间)
  const [facets, setFacets] = useState<Facet[]>([])
  const [myActive, setMyActive] = useState(false)
  const [timeKey, setTimeKey] = useState('')
  const currentUser = useMemo(() => getSession(), [])
  const [showFiltersBar, setShowFiltersBar] = useState(true)
  const [sortField, setSortField] = useState('createdAt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [isReadMode, setIsReadMode] = useState(true)
  const [editBatchId, setEditBatchId] = useState<string | null>(null)
  const [editBatchVal, setEditBatchVal] = useState('')
  // 编辑模式下司机批次的本地暂存(orderId → slotId,'' 为取消分配),点「保存」统一提交
  const [pendingBatch, setPendingBatch] = useState<Record<string, string>>({})
  const [savingBatch, setSavingBatch] = useState(false)
  const [driverSlots, setDriverSlots] = useState<DriverSlotInfo[]>([])

  // ── Import modal(CSV 导入，镜像采购单页 purchases/page.tsx）─────────────────
  const [showImportModal, setShowImportModal] = useState(false)
  const [importParsed, setImportParsed] = useState<Array<Record<string, string>>>([])
  const [importLoading, setImportLoading] = useState(false)
  const [importResult, setImportResult] = useState<{ success: number; failed: number; errors: string[] } | null>(null)
  const importFileRef = useRef<HTMLInputElement>(null)

  function fetchDriverSlots() {
    return apiGet<DriverSlotInfo[]>('/api/driver-slots').then(d => setDriverSlots(Array.isArray(d) ? d : [])).catch(() => {})
  }
  useEffect(() => { fetchDriverSlots() }, [])
  const [groupBy, setGroupBy] = useState('')

  // Build status param from active filter — changes trigger server refetch via useServerList
  const statusParam = useMemo(() => {
    if (activeFilter === 'to_invoice') return 'COMPLETED'
    if (activeFilter === 'return_open') return 'IN_DELIVERY,COMPLETED,LOCKED'
    if (activeFilter === 'all') return 'CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY,COMPLETED'
    return activeFilter.toUpperCase()
  }, [activeFilter])

  // 交货日期/列筛选/排序均下推到服务端:任一变化即触发 useServerList 重查(回第 1 页),
  // 避免"只筛/只排当前页"——匹配记录不在当前页时被误判为空,或翻页后排序断档(客户反馈)
  const baseUrl = useMemo(() => {
    const params = new URLSearchParams({ status: statusParam, include_lines: 'false' })
    // 「待开票」下推服务端（20261021）：原来是拉一页 COMPLETED 再在浏览器里剔掉已开票的，
    // 一页 20 条剩几条、总数却按全部已完成单算，翻页看起来像有空页
    if (activeFilter === 'to_invoice' || colFilters.invoiceStatus === 'to_invoice') params.set('invoiceState', 'to_invoice')
    // 「未回单」：货已离仓、签收单还没交回核销（与核销管理页待核销同口径，20261021）
    if (activeFilter === 'return_open') params.set('returnState', 'open')
    // 交货日期过滤走服务端分页分支认的参数:dateField=deliveryDate + fromDate/toDate
    if (colFilters.deliveryDateFrom || colFilters.deliveryDateTo) {
      params.set('dateField', 'deliveryDate')
      if (colFilters.deliveryDateFrom) params.set('fromDate', colFilters.deliveryDateFrom)
      if (colFilters.deliveryDateTo) params.set('toDate', colFilters.deliveryDateTo)
    }
    // Created on 列筛选：独立参数 createdAtFrom/createdAtTo，走服务端(此前只对当前页客户端过滤，
    // 翻页/总数会对不上，见 lib/orders-query.ts 的同名参数)
    if (colFilters.createdAtFrom) params.set('createdAtFrom', colFilters.createdAtFrom)
    if (colFilters.createdAtTo) params.set('createdAtTo', colFilters.createdAtTo)
    // 状态列筛选 → colStatus，走服务端(此前只在前端对当前页二次过滤，分页 total 没跟着收窄，
    // 客户反馈"筛完还是显示共146条/第1/3页")
    if (colFilters.status) params.set('colStatus', colFilters.status.toUpperCase())
    // 单号/客户/销售员/司机列筛选框(与分面 chip 独立,AND 语义) → colCode/colCustomer/colSalesman/colDriver
    if (debouncedColText.code) params.set('colCode', debouncedColText.code)
    if (debouncedColText.customer) params.set('colCustomer', debouncedColText.customer)
    if (debouncedColText.salesman) params.set('colSalesman', debouncedColText.salesman)
    if (debouncedColText.driver) params.set('colDriver', debouncedColText.driver)
    if (debouncedColText.createdBy) params.set('colCreatedBy', debouncedColText.createdBy)
    // 表头排序 — deliveryBatch/司机列虽是 wave 派生展示字段,服务端也已改成整表内存排序后再切页
    // (见 /api/orders 的 sortField===deliveryBatch 分支),这里不再排除,统一下推
    params.set('sortField', sortField)
    params.set('sortDir', sortDir)
    // 分面聚焦搜索 → f_* / search
    applyFacets(params, facets)
    // My Sales Order → 按当前登录用户(业务员)过滤
    if (myActive && currentUser?.userId) params.set('salesUserId', currentUser.userId)
    // 时间快捷(Today/This Week…) → deliveryFrom/deliveryTo(按交货日期，与第二列/交货日期列筛口径一致)
    const range = timeKey ? computeTimeRange(timeKey) : null
    if (range) { params.set('deliveryFrom', range.from); params.set('deliveryTo', range.to) }
    return `/api/orders?${params.toString()}`
  }, [statusParam, activeFilter, colFilters.invoiceStatus, colFilters.status, colFilters.deliveryDateFrom, colFilters.deliveryDateTo, colFilters.createdAtFrom, colFilters.createdAtTo, debouncedColText, sortField, sortDir, facets, myActive, currentUser, timeKey])

  // 会计导出:跟列表当前筛选结果(baseUrl)完全同一套参数,只是换个路由+加 kind
  const [exporting, setExporting] = useState<'summary' | 'detail' | null>(null)
  async function exportCsv(kind: 'summary' | 'detail') {
    if (exporting) return
    setExporting(kind)
    try {
      const url = baseUrl.replace('/api/orders?', `/api/orders/export-csv?kind=${kind}&`)
      await downloadAuthedFile(url, isEn ? `orders-${kind}.csv` : `订单${kind === 'summary' ? '汇总' : '明细'}.csv`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Export failed' : '导出失败'))
    } finally {
      setExporting(null)
    }
  }

  // 全字段导出(可勾选字段) + CSV 导入 —— 与采购单列表页(purchases/page.tsx)同一模式，
  // 走独立的 order-lines 导出实体(lib/export/columns/order-lines.ts)，不动上面
  // 既有的 exportCsv('summary'|'detail')，那两个是报价单页共用的旧实体不能改。
  const exportAction = useCsvExport({
    entity: 'order-lines',
    params: () => baseUrl.split('?')[1] ?? '',
    fallbackFilename: isEn ? 'orders.csv' : '销售单.csv',
    columns: (en: boolean) => orderLineExportColumns(en),
  })
  // 多选后只导出选中的销售单，同样先弹字段勾选框
  const exportSelectedAction = useCsvExport({
    entity: 'order-lines',
    params: () => {
      const p = new URLSearchParams()
      p.set('ids', sorted.filter(o => selected.has(o.id)).map(o => o.id).join(','))
      p.set('sortField', sortField)
      p.set('sortDir', sortDir)
      return p
    },
    fallbackFilename: isEn ? 'orders-selected.csv' : '销售单-选中.csv',
    columns: (en: boolean) => orderLineExportColumns(en),
  })

  // ── CSV import helpers ────────────────────────────────────────────────────

  function downloadImportTemplate() {
    const headers = SO_IMPORT_COLUMNS.map(c => isEn ? c.en : c.zh)
    const today = new Date().toISOString().slice(0, 10)
    const sample = isEn
      ? ['Restaurant A', 'Cabbage', '', '10', '2.50', '23', '', today, '']
      : ['餐馆 A', '白菜', '', '10', '2.50', '23', '', today, '']
    downloadCsv(isEn ? 'sales_order_import_template' : '销售单导入模板', headers, [sample])
  }

  // 共享的健壮 CSV 解析器(引号包裹字段/内嵌逗号换行/BOM/CRLF)；表头按中/英文列名匹配
  // (大小写不敏感)后统一映射到固定 key 上，与采购单导入同一份解析规则。
  function parseImportCSV(text: string): Array<Record<string, string>> {
    const rows = parseCsv(text)
    if (rows.length < 2) return []
    const header = rows[0].map(h => h.trim().toLowerCase())
    const colIdx = new Map<string, number>()
    for (const c of SO_IMPORT_COLUMNS) {
      const idx = header.findIndex(h => h === c.zh.toLowerCase() || h === c.en.toLowerCase())
      if (idx >= 0) colIdx.set(c.key, idx)
    }
    return rows.slice(1).map(r => {
      const row: Record<string, string> = {}
      for (const [key, idx] of colIdx) row[key] = (r[idx] ?? '').trim()
      return row
    })
  }

  function handleImportFile(file: File) {
    const reader = new FileReader()
    reader.onload = e => {
      const text = e.target?.result as string
      setImportParsed(parseImportCSV(text))
      setImportResult(null)
    }
    reader.readAsText(file, 'utf-8')
  }

  async function handleImportSubmit() {
    if (!importParsed.length) return
    setImportLoading(true)
    setImportResult(null)

    // 客户 = /api/customers 默认视图(isCustomer=true && isActive=true)；不传 pageSize
    // 走 legacy 扁平数组分支，一次拿到全部匹配行。商品匹配与采购单导入同一套口径：
    // 优先按商品编号(internalRef)，其次按名称精确匹配。
    let customers: Array<{ id: string; name: string }> = []
    let products: Array<{ id: string; name: string; internalRef?: string | null }> = []
    try {
      [customers, products] = await Promise.all([
        apiGet<typeof customers>('/api/customers?slim=1'),
        apiGet<typeof products>('/api/products?slim=1'),
      ])
    } catch { /* ignore — 会在下方按"未找到"逐组报错 */ }

    function findProduct(productRef: string, productName: string) {
      if (productRef) {
        const byRef = products.find(p => p.internalRef && norm(p.internalRef) === norm(productRef))
        if (byRef) return byRef
      }
      return products.find(p => norm(p.name) === norm(productName)) ?? null
    }

    // 按客户名分组，构建销售单(报价单)
    const groups = new Map<string, typeof importParsed>()
    for (const row of importParsed) {
      const key = row.customer?.trim()
      if (!key) continue
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }

    let success = 0
    const errors: string[] = []
    // ⛔ 20261029 修复：之前不管成功/失败都不清 importParsed，disabled 只看 length===0——
    // 部分失败后用户改完重新点「导入」，会把已经成功创建的客户分组再提交一遍，
    // 销售单被重复创建。这里记下本次成功的客户分组，提交完从 importParsed 里摘掉，
    // 重试只会再提交真正失败的那些行。
    const succeededCustomers = new Set<string>()

    for (const [customerName, rows] of groups) {
      const customer = customers.find(c => norm(c.name) === norm(customerName))
      if (!customer) { errors.push(isEn ? `Customer not found: ${customerName}` : `找不到客户: ${customerName}`); continue }

      const items: Array<{ productId: string; productName: string; quantity: number; price?: number; taxRate?: number; isGift?: boolean }> = []
      const missingProducts: string[] = []
      const invalidRows: string[] = []

      for (const row of rows) {
        const productName = row.product?.trim() || ''
        if (!productName) continue
        const productRef = row.productRef?.trim() || ''
        const quantity = parseFloat(row.quantity)
        if (!row.quantity?.trim() || !Number.isFinite(quantity) || quantity <= 0) {
          invalidRows.push(isEn ? `${productName}: quantity is required` : `${productName}: 数量为必填项`)
          continue
        }
        // 单价留空 = 不传，由服务端权威定价(resolveOrderLines)按价格表/客户档案算，
        // 不像采购单那样必填——这里只是参考价，除非操作员有改价权限才会被采纳。
        const unitPriceRaw = row.unitPrice?.trim()
        const price = unitPriceRaw ? parseFloat(unitPriceRaw) : undefined
        const taxRateRaw = row.taxRate?.trim()
        const taxRate = taxRateRaw ? parseFloat(taxRateRaw) : undefined
        const isGift = ['是', 'yes', '1', 'true'].includes(norm(row.isGift))
        const matched = findProduct(productRef, productName)
        if (!matched) { missingProducts.push(productName); continue }
        items.push({ productId: matched.id, productName, quantity, price, taxRate, isGift })
      }

      if (missingProducts.length || invalidRows.length) {
        const parts: string[] = []
        if (missingProducts.length) {
          parts.push(isEn ? `product not found — ${missingProducts.join(', ')}` : `商品未找到 — ${missingProducts.join('、')}`)
        }
        if (invalidRows.length) parts.push(invalidRows.join('; '))
        errors.push(`${customerName}: ${parts.join('; ')}`)
        continue
      }
      if (!items.length) {
        errors.push(isEn ? `${customerName}: no valid item rows` : `${customerName}: 无有效商品行`)
        continue
      }

      const deliveryDateRaw = rows[0].deliveryDate?.trim() || ''
      // 后端 normalizeDateOnly 对不是 YYYY-MM-DD 的值直接返回 undefined（不报错）——
      // Excel 打开 CSV 再保存常把日期列重渲染成本地化格式(如 29/10/2026)，不在这里
      // 挡住的话，订单会"创建成功"但静默丢了交货日期，脱出波次/配送排程却没有任何提示。
      if (deliveryDateRaw && !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDateRaw)) {
        errors.push(isEn
          ? `${customerName}: delivery date must be YYYY-MM-DD (got "${deliveryDateRaw}")`
          : `${customerName}: 交货日期格式须为 YYYY-MM-DD（实际为 "${deliveryDateRaw}"）`)
        continue
      }
      const deliveryDate = deliveryDateRaw || undefined
      const internalNote = rows[0].notes?.trim() || undefined

      try {
        await apiPost('/api/orders', {
          restaurantId: customer.id,
          restaurantName: customer.name,
          items,
          deliveryDate,
          internalNote,
        })
        success++
        succeededCustomers.add(customerName)
      } catch (e) {
        errors.push(`${customerName}: ${e instanceof Error ? e.message : (isEn ? 'Creation failed' : '创建失败')}`)
      }
    }

    setImportResult({ success, failed: errors.length, errors })
    setImportLoading(false)
    if (success > 0) {
      toast.success(isEn ? `Successfully imported ${success} sales orders` : `成功导入 ${success} 个销售单`)
      refresh()
      if (succeededCustomers.size > 0) {
        setImportParsed(prev => prev.filter(row => !succeededCustomers.has(row.customer?.trim())))
      }
    }
  }

  const {
    data: rawOrders,
    total,
    page,
    pageSize,
    totalPages,
    loading,
    setPage,
    setPageSize,
    setSearch: setServerSearch,
    search,
    refresh,
  } = useServerList<Record<string, unknown>>({ url: baseUrl, pageSize: PAGE_SIZE })
  // 详情页上一条/下一条按同一筛选+排序+搜索走(lib/hooks/use-record-nav.ts)
  useEffect(() => { writeRecordNavQuery('orders', listNavQuery(baseUrl, search)) }, [baseUrl, search])

  // 列表本身的焦点刷新 useServerList 内部已经自带(见 hooks/use-server-list.ts 的
  // focus/visibilitychange 监听)，这里不重复接 refresh，否则每次切回 tab 会触发
  // 两次同样的列表请求；只补筛选用的司机档期候选这一项它没有覆盖到的参考数据。
  useRefetchOnFocus([fetchDriverSlots])

  const orders = useMemo(() =>
    rawOrders.map(o => ({
      ...(o as unknown as Order),
      status: normalizeStatus(o.status as string | null | undefined),
    })),
    [rawOrders],
  )

  // 只查当前这一页订单的开票状态。以前是 `/api/invoices?slim=1` 全表扫 148,285 张
  // （3.2 MB / 2.5 秒），只为给列表打「已开票」标记 —— 而列表本来就只显示 PAGE_SIZE 条。
  const pageOrderIds = useMemo(() => orders.map(o => o.id).join(','), [orders])

  useEffect(() => {
    if (!pageOrderIds) { setInvoices([]); return }
    let cancelled = false
    apiGet<Invoice[]>(`/api/invoices?slim=1&orderIds=${encodeURIComponent(pageOrderIds)}`)
      .catch(() => [] as Invoice[])
      .then(rows => { if (!cancelled) setInvoices(rows) })
    return () => { cancelled = true }
  }, [pageOrderIds])

  const invoicedOrderIds = useMemo(() => new Set(invoices.flatMap(inv => inv.saleOrderIds)), [invoices])

  function setCf(key: keyof ColFilters, value: string) {
    setColFilters(prev => ({ ...prev, [key]: value }))
  }

  function addFacet(key: string, value: string) {
    const field = ORDER_FACET_FIELDS.find(f => f.key === key)
    if (!field) return
    // 同一维度可累积多个关键词(后端 buildFacetWhere 组成 OR)；不同维度之间 AND
    setFacets(prev => [...prev, { key, label: isEn ? field.labelEn : field.label, value }])
  }
  function removeFacet(idx: number) {
    setFacets(prev => prev.filter((_, i) => i !== idx))
  }
  function removeFacetGroup(key: string) {
    setFacets(prev => prev.filter(f => f.key !== key))
  }
  function facetChipLabel(f: Facet) {
    return f.key === 'all' ? f.value : `${f.label}: ${f.value}`
  }

  // 一键清除（20261017 客户反馈"清不掉筛选条件"）
  function clearAllFilters() {
    setServerSearch('')
    setFacets([])
    setActiveFilter('all')
    setGroupBy('')
    setMyActive(false)
    setTimeKey('')
    setColFilters(EMPTY_FILTERS)
    setSortField('createdAt')
    setSortDir('desc')
  }

  // Client-side column filters applied to current page data
  const filtered = useMemo(() => {
    let result = [...orders]


    const cf = colFilters
    // 交货日期/创建日期/单号/客户/销售员/司机/状态已由服务端过滤(见 baseUrl),此处不再客户端二次筛选,
    // 避免"只筛当前页导致可见行数与分页总数对不上"(客户反馈:同一关键词每次搜到的页数/条数都不一样)
    // to_invoice 已由服务端筛（invoiceState），剩这一档仍按当前页标记过滤
    if (cf.invoiceStatus && cf.invoiceStatus !== 'to_invoice') result = result.filter(o => invoiceStatusFor(o, invoicedOrderIds) === cf.invoiceStatus)

    return result
  }, [orders, invoicedOrderIds, colFilters])

  // 排序(含 deliveryBatch/司机列)已下推服务端(见 baseUrl),数据到手时已是全局排好序的当页
  // 切片,不再客户端二次排序。
  const sorted = filtered

  // 选择司机批次只做本地暂存,不触发保存/刷新,避免打断连续编辑
  function stageBatch(orderId: string, slotId: string, originalSlotId: string) {
    setPendingBatch(prev => {
      if (slotId === originalSlotId) {
        const next = { ...prev }
        delete next[orderId]
        return next
      }
      return { ...prev, [orderId]: slotId }
    })
    setEditBatchId(null)
  }

  const pendingCount = Object.keys(pendingBatch).length

  async function saveAllBatches() {
    const entries = Object.entries(pendingBatch)
    if (entries.length === 0 || savingBatch) return
    setSavingBatch(true)
    const failed: string[] = []
    const failMessages = new Set<string>()
    await Promise.all(entries.map(async ([orderId, slotId]) => {
      try {
        await apiPut(`/api/orders/${orderId}/batch`, { driverSlotId: slotId || null })
      } catch (e) {
        failed.push(orderId)
        failMessages.add(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
      }
    }))
    setSavingBatch(false)
    if (failed.length === 0) {
      toast.success(isEn ? `Saved driver batch for ${entries.length} orders` : `已保存 ${entries.length} 个订单的司机批次`)
      setPendingBatch({})
    } else {
      // 失败原因一致（如批次已锁定）时直接显示具体原因，而非笼统的"N 个失败"
      const detail = failMessages.size === 1 ? [...failMessages][0] : (isEn ? `${failed.length} orders failed to save` : `${failed.length} 个订单保存失败`)
      toast.error(isEn ? `${detail}, kept for retry` : `${detail},已保留待重试`)
      setPendingBatch(prev => {
        const next: Record<string, string> = {}
        for (const id of failed) if (id in prev) next[id] = prev[id]
        return next
      })
    }
    refresh()
  }

  function exitEditMode() {
    if (pendingCount > 0 && !confirm(isEn
      ? `${pendingCount} unsaved driver batch changes will be discarded. Exit edit mode?`
      : `有 ${pendingCount} 项未保存的司机批次修改,放弃并退出编辑?`)) return
    setIsReadMode(true)
    setEditBatchId(null)
    setPendingBatch({})
  }

  // 「去调度台排车」（20261021，替换原「生成拣货波次」）：原按钮建出来的波次既没有日期也没有司机，
  // 调度台按日期显示波次，这种波次哪天都看不到；订单却被改成 Driver Assigned，22 点自动出发也不管它，
  // 单子就悬在那里。现在排车统一在调度台按「日期 × 司机」拖，这里只负责带着送货日期跳过去。
  function goDispatchConsole() {
    const picked = sorted.filter(o => selected.has(o.id) && o.status === 'confirmed')
    if (picked.length === 0) { toast.error(isEn ? 'Please select confirmed sales orders first' : '请先选择已确认的销售单'); return }
    const days = [...new Set(picked.map(o => (o.deliveryDate ?? '').slice(0, 10)).filter(Boolean))].sort()
    if (days.length > 1) {
      toast.info(isEn
        ? `Selected orders are for ${days.length} different delivery dates; opening ${days[0]} first`
        : `所选订单分属 ${days.length} 个送货日期，先打开 ${days[0]}（其余日期在调度台顶部「其他日期」里切换）`)
    }
    router.push(`${prefix}/classic/operator/dispatch-console${days[0] ? `?date=${days[0]}` : ''}`)
  }

  const allSelected = sorted.length > 0 && sorted.every(o => selected.has(o.id))
  function toggleAll() {
    if (allSelected) setSelected(prev => { const n = new Set(prev); sorted.forEach(o => n.delete(o.id)); return n })
    else setSelected(prev => { const n = new Set(prev); sorted.forEach(o => n.add(o.id)); return n })
  }

  // 只数当前看得见的勾选（20261021）：切换筛选后被筛掉的行仍留在 selected 里，原来按钮照样把它们算进去，
  // 屏幕上一张都看不到却显示 (1)
  const selectedConfirmedCount = sorted.filter(o => selected.has(o.id) && o.status === 'confirmed').length
  // 导出选中用——不限状态，同样只数当前看得见的勾选（同 20261021 的理由）
  const selectedVisibleCount = sorted.filter(o => selected.has(o.id)).length

  const inputCls = 'w-full border border-gray-300 rounded bg-white text-xs px-1.5 py-0.5 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-200'
  const selectCls = 'w-full border border-gray-300 rounded bg-white text-xs px-1.5 py-0.5 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-200'

  function filterRow() {
    const dateLabelCell = (fromKey: keyof ColFilters, toKey: keyof ColFilters) => (
      <td className="px-2 py-1 align-top">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-400 w-9">From:</span>
          <DatePicker value={colFilters[fromKey]} onChange={v => setCf(fromKey, v)} className={inputCls} clearable={false} />
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          <span className="text-[10px] text-gray-400 w-9">To:</span>
          <DatePicker value={colFilters[toKey]} onChange={v => setCf(toKey, v)} className={inputCls} clearable={false} />
        </div>
      </td>
    )
    return (
      <tr className="bg-white text-gray-500 border-b border-gray-200">
        <td className="pl-3 pr-1 py-1 text-gray-300">✎</td>
        <td className="px-2 py-1"><input value={colFilters.code}         onChange={e => setCf('code', e.target.value)}         className={inputCls} /></td>
        {dateLabelCell('deliveryDateFrom', 'deliveryDateTo')}
        <td className="px-2 py-1"><input value={colFilters.createdBy}    onChange={e => setCf('createdBy', e.target.value)}    className={inputCls} /></td>
        <td className="px-2 py-1"><input value={colFilters.customer}     onChange={e => setCf('customer', e.target.value)}     className={inputCls} /></td>
        <td className="px-2 py-1"><input value={colFilters.deliveryBatch} onChange={e => setCf('deliveryBatch', e.target.value)} className={inputCls} /></td>
        <td className="px-2 py-1" />
        <td className="px-2 py-1">
          <select value={colFilters.status} onChange={e => setCf('status', e.target.value)} className={selectCls}>
            <option value=""></option>
            <option value="confirmed">{STATUS_LABEL.confirmed}</option>
            <option value="wave_assigned">{STATUS_LABEL.wave_assigned}</option>
            <option value="in_delivery">{STATUS_LABEL.in_delivery}</option>
            <option value="locked">{STATUS_LABEL.locked}</option>
            <option value="completed">{STATUS_LABEL.completed}</option>
            <option value="cancelled">{STATUS_LABEL.cancelled}</option>
          </select>
        </td>
        <td className="px-2 py-1" />
        <td className="px-2 py-1"><input value={colFilters.salesman}     onChange={e => setCf('salesman', e.target.value)}     className={inputCls} /></td>
        <td className="px-2 py-1" />
      </tr>
    )
  }

  function renderRow(o: Order) {
    const isSelected = selected.has(o.id)

    return (
      <tr
        className={`border-b border-gray-100 cursor-pointer transition-colors ${isSelected ? 'bg-amber-50' : 'hover:bg-gray-50'}`}
        onClick={() => router.push(`${prefix}/classic/operator/orders/${o.id}`)}
      >
        <td className="pl-3 pr-1 py-2" onClick={e => e.stopPropagation()}>
          <input type="checkbox" checked={isSelected}
            onChange={() => setSelected(prev => { const n = new Set(prev); isSelected ? n.delete(o.id) : n.add(o.id); return n })}
            className="w-3.5 h-3.5 accent-purple-600 cursor-pointer" />
        </td>
        <td className="px-2 py-2 whitespace-nowrap">
          <span className="text-sm" style={{ color: '#875A7B' }}>{displayOrderCode(o)}</span>
        </td>
        <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap">{o.deliveryDate ? <DateCell iso={o.deliveryDate} /> : <span className="text-gray-300">—</span>}</td>
        <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap">{getField(o, 'createdByName') || '—'}</td>
        <td className="px-2 py-2 text-sm text-gray-800 max-w-[180px] truncate">{o.restaurantName}</td>
        <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap" onClick={e => e.stopPropagation()}>
          {(() => {
            const originalSlotId = (o as unknown as { assignedDriverSlotId?: string }).assignedDriverSlotId ?? ''
            const pendingVal = pendingBatch[o.id]
            const hasPending = pendingVal !== undefined
            const slotLabel = (id: string) => {
              const s = driverSlots.find(x => x.id === id)
              return s ? `${s.batchNum} ${s.timeOfDay} ${s.driverName}` : ''
            }
            const display = hasPending ? slotLabel(pendingVal) : formatDriverSlotFromOrder(o)
            if (!isReadMode && editBatchId === o.id) {
              return (
                <DriverSlotCombobox
                  slots={driverSlots}
                  value={editBatchVal}
                  onSelect={slotId => { setEditBatchVal(slotId); stageBatch(o.id, slotId, originalSlotId); setEditBatchId(null) }}
                  onClose={() => setEditBatchId(null)}
                />
              )
            }
            return (
              <span
                className={isReadMode ? '' : 'cursor-pointer hover:text-purple-700 hover:underline'}
                style={{ color: hasPending ? '#d97706' : display ? '#875A7B' : undefined }}
                title={hasPending ? (isEn ? 'Unsaved — click "Save" above to submit' : '未保存,点顶部「保存」提交') : undefined}
                onClick={isReadMode ? undefined : () => { setEditBatchId(o.id); setEditBatchVal(hasPending ? pendingVal : originalSlotId) }}
              >
                {display || '—'}
                {hasPending && <span className="ml-1 text-amber-500">●</span>}
              </span>
            )
          })()}
        </td>
        <td className="px-2 py-2 text-right text-sm text-gray-800 whitespace-nowrap tabular-nums">
          € {o.totalAmount.toFixed(2)}
        </td>
        <td className="px-2 py-2 min-w-[72px]">
          <div className="flex items-center gap-1.5">
            <span className={`inline-block whitespace-nowrap px-2 py-0.5 rounded text-xs ${STATUS_COLOR[o.status] ?? 'bg-gray-100 text-gray-600'}`}>
              {STATUS_LABEL[o.status] ?? String(o.status)}
            </span>
            {/* 回单（签收单）核销状态（20261021）：原来把 RETURNED 印成「有退货」——意思反了，
                RETURNED 是签收单已交回会计核销；未回 / 有问题根本不显示。只对货已离仓的单显示 */}
            {['in_delivery', 'completed', 'locked'].includes(String(o.status)) && (
              o.returnStatus === 'RETURNED'
                ? <span className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-xs bg-green-50 text-green-700 font-medium" data-testid="return-badge">{isEn ? 'Receipt ✓' : '回单已核销'}</span>
                : o.returnStatus === 'ISSUE'
                  ? <span className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-700 font-medium" data-testid="return-badge" title={o.returnIssueNote ?? ''}>{isEn ? 'Receipt issue' : '回单有问题'}</span>
                  : <span className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-xs bg-red-50 text-red-600 font-medium" data-testid="return-badge">{isEn ? 'No receipt' : '未回单'}</span>
            )}
            {/* 客退货物处置角标（20261027 M5）：只读展示 OrderReturn/ReturnItem 审核结果，与上面
                「回单核销」(returnStatus) 完全是两件事——不要混用同一个 data-testid 或配色 */}
            {o.goodsReturnStatus === 'APPROVED' && (
              <span className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-xs bg-orange-50 text-orange-700 font-medium" data-testid="goods-return-badge">{isEn ? 'Goods returned' : '有退货'}</span>
            )}
            {o.goodsReturnStatus === 'REJECTED' && (
              <span className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-500 font-medium" data-testid="goods-return-badge">{isEn ? 'Return rejected' : '退货已拒绝'}</span>
            )}
          </div>
        </td>
        {/* Internal Notes */}
        <td className="px-2 py-2 text-sm text-gray-700 max-w-[140px] truncate" title={getField(o, 'internalNote')}>{getField(o, 'internalNote')}</td>
        {/* Salesperson — Order.salesman 快照(下单时冻结),不随客户当前业务员变 */}
        <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap">{getField(o, 'salesman') || '—'}</td>
        <td className="px-2 py-2" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-1">
            {!isReadMode && o.status === 'confirmed' && pendingBatch[o.id] !== undefined && (
              <button
                onClick={async e => {
                  e.stopPropagation()
                  if (!confirm(isEn
                    ? `Revert order ${displayOrderCode(o)} to quotation?`
                    : `确认将订单 ${displayOrderCode(o)} 撤回到报价单？`)) return
                  try {
                    await apiPut(`/api/orders/${o.id}`, { status: 'PENDING', confirmationDate: null })
                    setPendingBatch(prev => {
                      const next = { ...prev }
                      delete next[o.id]
                      return next
                    })
                    toast.success(isEn ? 'Reverted to quotation' : '已撤回到报价单')
                    refresh()
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : (isEn ? 'Revert failed' : '撤回失败'))
                  }
                }}
                className="px-2 py-1 text-xs rounded border border-orange-300 text-orange-600 bg-orange-50 hover:bg-orange-100 whitespace-nowrap">
                {isEn ? 'Revert' : '撤回'}
              </button>
            )}
          </div>
        </td>
      </tr>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: '#f5f5f5' }}>
      <OdooControlPanel
        breadcrumb={isEn ? ['Sales', 'Orders'] : ['销售', '订单']}
        permanentActions={[
          { label: isEn ? 'New' : '新建', onClick: () => router.push(`${prefix}/classic/operator/place-order`), primary: true },
          ...(isReadMode
            ? [
                { label: 'Mode', onClick: () => setIsReadMode(false) },
                { label: 'Read', onClick: () => {}, primary: true },
              ]
            : [
                { label: 'Edit', onClick: () => {}, primary: true },
                ...(pendingCount > 0
                  ? [{ label: savingBatch ? (isEn ? 'Saving…' : '保存中…') : (isEn ? `Save (${pendingCount})` : `保存 (${pendingCount})`), onClick: saveAllBatches, primary: true }]
                  : []),
                { label: 'Mode', onClick: exitEditMode },
              ]),
          ...(selectedConfirmedCount > 0 ? [{
            label: isEn ? `Schedule in Dispatch Console (${selectedConfirmedCount})` : `去调度台排车 (${selectedConfirmedCount})`,
            onClick: goDispatchConsole,
          }] : []),
          { label: exporting === 'summary' ? (isEn ? 'Exporting…' : '导出中…') : (isEn ? 'Export Summary' : '导出汇总'), onClick: () => exportCsv('summary') },
          { label: exporting === 'detail' ? (isEn ? 'Exporting…' : '导出中…') : (isEn ? 'Export Detail' : '导出明细'), onClick: () => exportCsv('detail') },
          { label: exportAction.label, onClick: exportAction.onClick, disabled: exportAction.disabled },
          { label: isEn ? 'Import' : '导入', onClick: () => { setImportParsed([]); setImportResult(null); setShowImportModal(true) } },
        ]}
        actions={selectedVisibleCount > 0 ? [
          { label: isEn ? `Export Selected (${selectedVisibleCount})` : `导出选中 (${selectedVisibleCount})`, onClick: exportSelectedAction.onClick, disabled: exportSelectedAction.disabled },
        ] : []}
        searchValue={search}
        onSearch={v => { setServerSearch(v) }}
        onSearchSubmit={() => {}}
        facetFields={localizeFacetFields(ORDER_FACET_FIELDS, isEn)}
        onFacetAdd={addFacet}
        filterOptions={[
          { label: myActive ? '✓ My Sales Order' : 'My Sales Order', value: '__my__' },
          ...TIME_QUICK_OPTIONS.map(o => ({ label: timeKey === o.value ? `✓ ${o.label}` : o.label, value: `__time__${o.value}` })),
          { label: isEn ? 'To Invoice' : '待开票', value: 'to_invoice' },
          { label: isEn ? 'Receipt not returned' : '未回单', value: 'return_open' },
          { label: STATUS_LABEL.confirmed, value: 'confirmed' },
          { label: STATUS_LABEL.wave_assigned, value: 'wave_assigned' },
          { label: STATUS_LABEL.in_delivery, value: 'in_delivery' },
          { label: STATUS_LABEL.completed, value: 'completed' },
          { label: 'Column filters…', value: '__column_filters__' },
        ]}
        onFilterSelect={v => {
          if (v === '__column_filters__') { setShowFiltersBar(x => !x); return }
          if (v === '__my__') { setMyActive(x => !x); return }
          if (v.startsWith('__time__')) { const k = v.slice(8); setTimeKey(prev => prev === k ? '' : k); return }
          setActiveFilter(v as ActiveFilter)
        }}
        activeFilters={[
          ...groupFacets(facets).map(g => ({ label: g.chipLabel, values: g.values, prefix: g.key === 'all' ? undefined : g.label, onRemove: () => removeFacetGroup(g.key) })),
          ...(myActive ? [{ label: 'My Sales Order', onRemove: () => setMyActive(false) }] : []),
          ...(timeKey ? [{ label: TIME_QUICK_LABEL[timeKey] ?? timeKey, onRemove: () => setTimeKey('') }] : []),
          ...(activeFilter !== 'all' ? [{
            label: activeFilter === 'to_invoice' ? (isEn ? 'To Invoice' : '待开票') : activeFilter === 'return_open' ? (isEn ? 'Receipt not returned' : '未回单') : (STATUS_LABEL[activeFilter as OrderStatus] ?? activeFilter),
            onRemove: () => setActiveFilter('all'),
          }] : []),
        ]}
        groupByOptions={[
          { label: isEn ? 'Customer' : '客户', value: 'restaurantName' },
          { label: isEn ? 'Status' : '状态', value: 'status' },
          { label: isEn ? 'Date' : '日期', value: 'createdAt' },
        ]}
        groupByValue={groupBy}
        onGroupByChange={v => setGroupBy(prev => prev === v ? '' : v)}
        favouriteState={{ search, activeFilter, groupBy, facets, myActive, timeKey, colFilters }}
        onFavouriteApply={s => {
          setServerSearch(String(s.search ?? ''))
          setActiveFilter((s.activeFilter as ActiveFilter) ?? 'all')
          setGroupBy(String(s.groupBy ?? ''))
          setFacets(Array.isArray(s.facets) ? (s.facets as Facet[]) : [])
          setMyActive(Boolean(s.myActive))
          setTimeKey(String(s.timeKey ?? ''))
          // 列级筛选(含 Delivery Date From/To)也纳入收藏,否则点收藏日期区间不恢复(客户反馈)
          setColFilters({ ...EMPTY_FILTERS, ...(s.colFilters as Partial<ColFilters> ?? {}) })
        }}
        storageKey="classic_orders_favs"
        onClearAll={clearAllFilters}
        total={total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
      {exportAction.dialog}
      {exportSelectedAction.dialog}

      {showImportModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowImportModal(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <h3 className="text-base font-semibold">{isEn ? 'Import Sales Orders (CSV)' : '导入销售单 (CSV)'}</h3>
              <button onClick={() => setShowImportModal(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="p-5 space-y-4 text-sm">
              <div className="flex items-center gap-3">
                <button onClick={downloadImportTemplate} className="px-3 py-1.5 border rounded text-[#875A7B] border-[#875A7B] hover:bg-purple-50">
                  {isEn ? 'Download Template' : '下载导入模板'}
                </button>
                <span className="text-gray-500 text-xs">
                  {isEn ? 'Required columns: Customer Name / Product Name / Quantity' : '必填列：客户名称 / 商品名称 / 数量'}
                </span>
              </div>
              <div>
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".csv"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = '' }}
                  className="block w-full text-xs border rounded px-2 py-1.5"
                />
              </div>
              {importParsed.length > 0 && (
                <div className="border rounded overflow-x-auto max-h-56">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        {SO_IMPORT_COLUMNS.map(c => (
                          <th key={c.key} className="px-2 py-1 text-left whitespace-nowrap">{isEn ? c.en : c.zh}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {importParsed.slice(0, 5).map((row, i) => (
                        <tr key={i} className="border-t">
                          {SO_IMPORT_COLUMNS.map(c => (
                            <td key={c.key} className="px-2 py-1 whitespace-nowrap">{row[c.key] ?? ''}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="px-2 py-1 text-[11px] text-gray-500 bg-gray-50 border-t">
                    {isEn ? `${importParsed.length} rows total, showing first 5` : `共 ${importParsed.length} 行，预览前 5 行`}
                  </div>
                </div>
              )}
              {importResult && (
                <div className={`rounded px-3 py-2 text-xs ${importResult.failed > 0 ? 'bg-yellow-50 text-yellow-800' : 'bg-green-50 text-green-800'}`}>
                  <div>{isEn ? `Success: ${importResult.success}, Failed: ${importResult.failed}` : `成功 ${importResult.success} 个，失败 ${importResult.failed} 个`}</div>
                  {importResult.errors.length > 0 && (
                    <ul className="mt-1 list-disc list-inside space-y-0.5">
                      {importResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <div className="px-5 py-3 border-t flex items-center justify-end gap-2">
              <button onClick={() => setShowImportModal(false)} className="px-3 py-1.5 border rounded text-gray-600 hover:bg-gray-50">
                {isEn ? 'Close' : '关闭'}
              </button>
              <button
                onClick={handleImportSubmit}
                disabled={importParsed.length === 0 || importLoading}
                className="px-3 py-1.5 rounded text-white disabled:opacity-50"
                style={{ background: '#875A7B' }}
              >
                {importLoading ? (isEn ? 'Importing…' : '导入中…') : (isEn ? 'Import' : '导入')}
              </button>
            </div>
          </div>
        </div>
      )}

      <OrderMobileList orders={sorted} selected={selected} loading={loading} isEn={isEn} statusLabels={STATUS_LABEL} statusColors={STATUS_COLOR}
        onSelect={(id, checked) => setSelected(previous => { const next = new Set(previous); if (checked) next.add(id); else next.delete(id); return next })}
        filterControls={<>{(['deliveryDateFrom', 'deliveryDateTo'] as const).map((key, index) => <label key={key} className="flex flex-col gap-1">{isEn ? (index ? 'Delivery to' : 'Delivery from') : (index ? '交货截止' : '交货开始')}<input type="date" value={colFilters[key]} onChange={event => setCf(key, event.target.value)} className="min-h-11 border rounded px-2 w-full min-w-0" /></label>)}</>}
        onOpen={order => router.push(`${prefix}/classic/operator/orders/${order.id}`)}
        sortKey={sortField} sortDir={sortDir} onSort={(key, direction) => { setSortField(key); setSortDir(direction) }}
        sortOptions={[{ key: 'code', label: isEn ? 'Number' : '单号' }, { key: 'restaurantName', label: isEn ? 'Customer' : '客户' }, { key: 'deliveryDate', label: isEn ? 'Delivery Date' : '交货日期' }, { key: 'totalAmount', label: isEn ? 'Amount' : '金额' }, { key: 'status', label: isEn ? 'Status' : '状态' }]}
        renderExtra={order => <div className="text-sm text-gray-500 space-y-2"><p>{formatDriverSlotFromOrder(order) || '—'}</p>{!isReadMode && <select aria-label={isEn ? 'Driver / Batch' : '司机/批次'} value={pendingBatch[order.id] ?? (order as unknown as { assignedDriverSlotId?: string }).assignedDriverSlotId ?? ''} onChange={event => stageBatch(order.id, event.target.value, (order as unknown as { assignedDriverSlotId?: string }).assignedDriverSlotId ?? '')} className="w-full min-h-11 border rounded px-2"><option value="">{isEn ? 'Unassigned' : '待分配'}</option>{driverSlots.map(slot => <option key={slot.id} value={slot.id}>{slot.batchNum} {slot.timeOfDay} {slot.driverName}</option>)}</select>}</div>}
      />
      <div className="hidden md:block overflow-auto relative">
        {loading && sorted.length > 0 && (
          <div className="absolute top-0 left-0 right-0 h-0.5 overflow-hidden z-20">
            <div className="h-full w-1/3 animate-pulse" style={{ background: '#875A7B' }} />
          </div>
        )}
        <table className="w-full text-sm border-collapse bg-white">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-gray-200 text-left text-xs font-semibold text-gray-600" style={{ background: '#f9f9f9' }}>
              <th className="pl-3 pr-1 py-3 w-8">
                <input type="checkbox" checked={allSelected} onChange={toggleAll}
                  className="w-3.5 h-3.5 accent-purple-600 cursor-pointer" />
              </th>
              {(
                [
                  { field: 'code',          label: 'Quotation\nNumber', right: false },
                  { field: 'deliveryDate',  label: 'Delivery\nDate',    right: false },
                  { field: null,            label: isEn ? 'Created\nBy' : '创建人', right: false },
                  { field: 'restaurantName',label: 'Customer',          right: false },
                  { field: 'deliveryBatch', label: isEn ? 'Driver' : '司机', right: false },
                  { field: 'totalAmount',   label: 'Untaxed\nTotal',    right: true  },
                  { field: 'status',        label: 'Status',            right: false },
                  { field: null,            label: isEn ? 'Internal\nNotes' : '内部\n备注', right: false },
                  { field: 'salesman',      label: 'Salesperson',       right: false },
                  { field: null,            label: '',                   right: false },
                ] as { field: string | null; label: string; right: boolean }[]
              ).map(({ field, label, right }, i) => {
                const lines = label.split('\n')
                return (
                  <th
                    key={i}
                    className={`px-2 py-3 ${field ? 'cursor-pointer select-none hover:bg-gray-50' : ''} ${right ? 'text-right' : ''}`}
                    onClick={field ? () => {
                      if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
                      else { setSortField(field); setSortDir('asc') }
                    } : undefined}
                  >
                    <div className="leading-tight flex items-end gap-1">
                      <span>{lines.length > 1 ? <>{lines[0]}<br />{lines[1]}</> : lines[0]}</span>
                      {field && sortField === field && (
                        <span className="text-[10px] text-[#875A7B]">{sortDir === 'asc' ? '▲' : '▼'}</span>
                      )}
                    </div>
                  </th>
                )
              })}
            </tr>
            {showFiltersBar && filterRow()}
          </thead>
          <tbody>
            {loading && sorted.length === 0 && (
              <tr><td colSpan={11} className="text-center py-12 text-gray-400 text-sm">{isEn ? 'Loading…' : '加载中…'}</td></tr>
            )}
            {!loading && sorted.length === 0 && (
              <tr><td colSpan={11} className="text-center py-12 text-gray-400 text-sm">{isEn ? 'No orders' : '暂无订单数据'}</td></tr>
            )}
            {sorted.map(o => <Fragment key={o.id}>{renderRow(o)}</Fragment>)}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2 items-center justify-between px-2 py-3">
        <span className="text-xs text-gray-400">{isEn ? `${total} total, page ${page}/${Math.max(totalPages, 1)}` : `共 ${total} 条，第 ${page}/${Math.max(totalPages, 1)} 页`}</span>
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} className="mt-0" />
      </div>
    </div>
  )
}
