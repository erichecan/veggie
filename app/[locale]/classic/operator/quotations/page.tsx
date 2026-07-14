'use client'
import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut, apiPost, apiDelete } from '@/lib/api'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import type { Order, OrderStatus, Invoice, Customer, Trip } from '@/lib/types'
import { displayOrderCode } from '@/lib/order-code'
import { DateWithDay } from '@/components/shared/date-with-day'
import { formatDateTimeShort } from '@/lib/format-date'
import { buildOrderHtml } from '../../print/[id]/page'
import { getSession } from '@/lib/session'
import { type Facet, ORDER_FACET_FIELDS, applyFacets, TIME_QUICK_OPTIONS, TIME_QUICK_LABEL, computeTimeRange } from '@/lib/list-filters'
import { useServerList } from '@/hooks/use-server-list'
import { Pagination } from '@/components/ui/pagination'

const PAGE_SIZE = 50

// ── Constants ─────────────────────────────────────────────────────────────────

const FAV_KEY = 'veggie_quotations_favourites'

const WEEKDAY_NAMES_ZH = ['日', '一', '二', '三', '四', '五', '六']
const WEEKDAY_NAMES_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const STATUS_LABEL_ZH: Record<string, string> = {
  pending:       'Quotation',
  confirmed:     'Sales Order',
  wave_assigned: 'Sales Order',
  in_delivery:   'Sales Order',
  completed:     'Done',
  cancelled:     '已取消',
}
const STATUS_LABEL_EN: Record<string, string> = {
  pending:       'Quotation',
  confirmed:     'Sales Order',
  wave_assigned: 'Sales Order',
  in_delivery:   'Sales Order',
  completed:     'Done',
  cancelled:     'Cancelled',
}
const STATUS_COLOR: Record<string, string> = {
  pending:       'bg-gray-100 text-gray-600',
  confirmed:     'bg-green-50 text-green-700',
  wave_assigned: 'bg-green-50 text-green-700',
  in_delivery:   'bg-purple-50 text-purple-700',
  completed:     'bg-blue-50 text-blue-700',
  cancelled:     'bg-red-50 text-red-600',
}


type GroupByField = 'none' | 'customer' | 'salesman' | 'salesTeam' | 'status' | 'weekday'
type TabValue = 'all' | 'quotations'

interface SavedFavourite {
  name: string
  colFilters: ColFilters
  tab: TabValue
  orderTodayActive: boolean
  groupBy: GroupByField
  facets?: Facet[]
  myActive?: boolean
  timeKey?: string
}

interface ColFilters {
  code: string
  quotationDateFrom: string
  quotationDateTo: string
  customer: string
  salesman: string
  deliveryDateFrom: string
  deliveryDateTo: string
  salesTeam: string
  status: string
  internalNote: string
  createdAtFrom: string
  createdAtTo: string
  weekday: string
}

const EMPTY_CF: ColFilters = {
  code: '', quotationDateFrom: '', quotationDateTo: '',
  customer: '', salesman: '',
  deliveryDateFrom: '', deliveryDateTo: '',
  salesTeam: '', status: '', internalNote: '',
  createdAtFrom: '', createdAtTo: '', weekday: '',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function norm(s: string | null | undefined): string {
  return s ? s.toLowerCase().trim() : ''
}

function getField(o: Order, key: string): string {
  return ((o as unknown as Record<string, unknown>)[key] as string) ?? ''
}


function isSameDay(dateStr: string, today: string) {
  return dateStr.slice(0, 10) === today
}

function DateCell({ iso }: { iso: string | null | undefined }) {
  return (
    <span title={formatDateTimeShort(iso)}>
      <DateWithDay date={iso} />
    </span>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function ClassicQuotationsPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale
  const STATUS_LABEL = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH
  const WEEKDAY_NAMES = isEn ? WEEKDAY_NAMES_EN : WEEKDAY_NAMES_ZH

  const [customers, setCustomers] = useState<Customer[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [trips, setTrips] = useState<Trip[]>([])

  const [activeTab, setActiveTab] = useState<TabValue>('all')
  const [orderTodayActive, setOrderTodayActive] = useState(false)
  // 分面搜索 + 快捷筛选(My / 时间)——全部 7 个维度(含 product/category)现在都直接编码进服务端请求参数，
  // 不再需要客户端 bridge 拉 id 集合再取交集。
  const [facets, setFacets] = useState<Facet[]>([])
  const [myActive, setMyActive] = useState(false)
  const [timeKey, setTimeKey] = useState('')
  const currentUser = useMemo(() => getSession(), [])
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [colFilters, setColFilters] = useState<ColFilters>({ ...EMPTY_CF })
  // code/customer/salesman 列筛选框下推到服务端查询(见 baseUrl),防抖 400ms 避免逐字符触发请求
  const [debouncedColText, setDebouncedColText] = useState({ code: '', customer: '', salesman: '' })
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedColText({ code: colFilters.code, customer: colFilters.customer, salesman: colFilters.salesman })
    }, 400)
    return () => clearTimeout(t)
  }, [colFilters.code, colFilters.customer, colFilters.salesman])
  const [groupBy, setGroupBy] = useState<GroupByField>('none')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [showFiltersBar, setShowFiltersBar] = useState(false)
  const [editDateId, setEditDateId] = useState<string | null>(null)
  const [editDateVal, setEditDateVal] = useState('')
  const [editItemsId, setEditItemsId] = useState<string | null>(null)
  const [editItemsLines, setEditItemsLines] = useState<Array<{ id?: string; productId: string; productName: string; spec: string; quantity: number; price: number; uomName?: string }>>([])
  const [savingItems, setSavingItems] = useState(false)
  const [bulkConfirming, setBulkConfirming] = useState(false)
  const [bulkPrinting, setBulkPrinting] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [duplicating, setDuplicating] = useState(false)

  // ── View mode (Edit vs Read) ──────────────────────────────────────────────
  const [isReadMode, setIsReadMode] = useState(true)

  // ── Import modal ─────────────────────────────────────────────────────────
  const [showImportModal, setShowImportModal] = useState(false)
  const [importParsed, setImportParsed] = useState<Array<Record<string, string>>>([])
  const [importLoading, setImportLoading] = useState(false)
  const [importResult, setImportResult] = useState<{ success: number; failed: number; errors: string[] } | null>(null)
  const importFileRef = useRef<HTMLInputElement>(null)

  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  // ── Batch quick-edit ─────────────────────────────────────────────────────

  async function saveDeliveryDate(orderId: string, date: string) {
    try {
      await apiPut(`/api/orders/${orderId}`, { deliveryDate: date || null })
      refresh()
      toast.success(date ? (isEn ? 'Delivery date scheduled' : '已安排送货日期') : (isEn ? 'Delivery date cleared' : '已清除送货日期'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update delivery date')
    }
    setEditDateId(null)
  }

  async function startEditItems(o: Order) {
    setEditItemsId(o.id)
    if (!o.lines || o.lines.length === 0) {
      try {
        const full = await apiGet<Order>(`/api/orders/${o.id}`)
        const lines = full.lines ?? []
        setEditItemsLines(lines.map(l => ({
          id: l.id,
          productId: l.productId,
          productName: l.productName,
          spec: l.spec ?? '',
          quantity: l.orderedQty,
          price: l.unitPrice,
          uomName: l.uomName ?? undefined,
        })))
      } catch {
        setEditItemsLines(o.items.map(it => ({
          productId: it.productId,
          productName: it.productName,
          spec: it.spec,
          quantity: it.quantity,
          price: it.price,
          uomName: it.uomName,
        })))
      }
    } else {
      setEditItemsLines(o.lines.map(l => ({
        id: l.id,
        productId: l.productId,
        productName: l.productName,
        spec: l.spec ?? '',
        quantity: l.orderedQty,
        price: l.unitPrice,
        uomName: l.uomName ?? undefined,
      })))
    }
  }

  async function saveItems(orderId: string) {
    setSavingItems(true)
    try {
      const hasLineIds = editItemsLines.length > 0 && editItemsLines.every(l => l.id)
      if (hasLineIds) {
        const linesPayload = editItemsLines.map(line => ({
          id: line.id!,
          orderedQty: line.quantity,
          unitPrice: line.price,
          subtotal: line.quantity * line.price,
        }))
        await apiPut(`/api/orders/${orderId}`, { lines: linesPayload })
      } else {
        // Fallback for legacy orders without OrderLine records
        const origOrder = orders.find(o => o.id === orderId)
        const updatedItems = editItemsLines.map(line => {
          const orig = origOrder?.items.find(it => it.productId === line.productId)
          return { ...(orig ?? {}), ...line, subtotal: line.quantity * line.price }
        })
        const totalAmount = updatedItems.reduce((s, it) => s + it.subtotal, 0)
        await apiPut(`/api/orders/${orderId}`, { totalAmount })
      }
      refresh()
      setEditItemsId(null)
      toast.success(isEn ? 'Item details updated' : '已更新商品明细')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
    } finally {
      setSavingItems(false)
    }
  }

  // ── Load ──────────────────────────────────────────────────────────────────
  // 报价单列表改成真正的服务端分页(50/页)，不再一次性拉全量到前端。
  // Status 列筛选决定实际查询的状态集合(默认只查 PENDING，与页面默认只展示待处理报价单的语义一致，
  // 顺带比"总是拉 PENDING+CANCELLED 再客户端丢弃"更省流量)。

  const statusParam = useMemo(() => {
    if (!colFilters.status) return 'PENDING'
    // Odoo state value → 服务端 OrderStatus 枚举
    const map: Record<string, string> = {
      draft: 'PENDING',
      sent: '',       // 系统里没有这个状态，恒空
      sale: 'CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY',
      done: 'COMPLETED',
      cancel: 'CANCELLED',
    }
    return map[colFilters.status] ?? 'PENDING'
  }, [colFilters.status])

  const baseUrl = useMemo(() => {
    const params = new URLSearchParams({ status: statusParam || 'PENDING', include_lines: 'false' })
    // "Sent" 在本系统里不是一个真实状态，用一个恒不匹配的条件让结果恒为空（而不是误变成"不筛状态"）
    if (statusParam === '') params.set('restaurantId', '__none__')
    // 报价日期列筛 → dateField=quotationDate(与交货日期筛选是两套独立参数，互不冲突)
    if (colFilters.quotationDateFrom || colFilters.quotationDateTo) {
      params.set('dateField', 'quotationDate')
      if (colFilters.quotationDateFrom) params.set('fromDate', colFilters.quotationDateFrom)
      if (colFilters.quotationDateTo) params.set('toDate', colFilters.quotationDateTo)
    }
    // 交货日期列筛 → deliveryFrom/deliveryTo
    if (colFilters.deliveryDateFrom) params.set('deliveryFrom', colFilters.deliveryDateFrom)
    if (colFilters.deliveryDateTo) params.set('deliveryTo', colFilters.deliveryDateTo)
    // 单号/客户/销售员列筛选框(与分面 chip 独立,AND 语义) → colCode/colCustomer/colSalesman,
    // 避免"匹配记录不在当前页时误判为空"(客户反馈,和交货日期同一类 bug)
    if (debouncedColText.code) params.set('colCode', debouncedColText.code)
    if (debouncedColText.customer) params.set('colCustomer', debouncedColText.customer)
    if (debouncedColText.salesman) params.set('colSalesman', debouncedColText.salesman)
    // 表头排序(internalNote 列除外,服务端没有对应可排序字段,该列排序仍由前端对当页数据做)
    if (sortField && sortField !== 'internalNote') {
      const sortFieldMap: Record<string, string> = { customer: 'restaurantName', total: 'totalAmount' }
      params.set('sortField', sortFieldMap[sortField] ?? sortField)
      params.set('sortDir', sortDir)
    }
    // 分面聚焦搜索(含 product/category)直接编码进 f_* 参数，服务端原生支持，不再需要客户端 bridge
    applyFacets(params, facets)
    // My Quotations → 按当前登录用户(业务员)过滤
    if (myActive && currentUser?.userId) params.set('salesUserId', currentUser.userId)
    // 时间快捷(Today/This Week…) → 按交货日期；若已手动设置交货日期列筛，以列筛为准，不重复覆盖
    if (!colFilters.deliveryDateFrom && !colFilters.deliveryDateTo) {
      const range = timeKey ? computeTimeRange(timeKey) : null
      if (range) { params.set('deliveryFrom', range.from); params.set('deliveryTo', range.to) }
    }
    return `/api/orders?${params.toString()}`
  }, [statusParam, colFilters.quotationDateFrom, colFilters.quotationDateTo, colFilters.deliveryDateFrom, colFilters.deliveryDateTo, debouncedColText, sortField, sortDir, facets, myActive, currentUser, timeKey])

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

  const orders = useMemo(() => rawOrders.map(o => ({
    ...(o as unknown as Order),
    status: (norm(o.status as string) || 'pending') as OrderStatus,
  })), [rawOrders])

  async function loadRefData() {
    try {
      const [rawCustomers, rawInvoices, rawTrips] = await Promise.all([
        apiGet<Customer[]>('/api/customers?slim=1').catch(() => [] as Customer[]),
        apiGet<Invoice[]>('/api/invoices?slim=1').catch(() => [] as Invoice[]),
        apiGet<Trip[]>('/api/trips').catch(() => [] as Trip[]),
      ])
      setCustomers(rawCustomers)
      setInvoices(rawInvoices)
      setTrips(rawTrips)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败'))
    }
  }

  useEffect(() => { loadRefData() }, [])

  // ── CSV import helpers ────────────────────────────────────────────────────

  // CSV 列名是数据格式契约(与上传文件表头及 row[key] 取值强绑定)，不随界面语言切换；
  // 下方 CSV_HEADER_LABELS 仅用于英文界面下的显示翻译，不影响解析 key。
  const CSV_HEADERS = ['餐馆名称', '商品名称', '规格', '数量', '单价', '配送批次', '内部备注']
  const CSV_TEMPLATE = CSV_HEADERS.join(',') + '\nRestaurant A,白菜,500g,10,2.50,Batch 1,'
  const CSV_HEADER_LABELS: Record<string, string> = {
    '餐馆名称': 'Restaurant Name',
    '商品名称': 'Product Name',
    '规格': 'Spec',
    '数量': 'Quantity',
    '单价': 'Unit Price',
    '配送批次': 'Delivery Batch',
    '内部备注': 'Internal Note',
  }

  function parseCSV(text: string): Array<Record<string, string>> {
    const lines = text.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) return []
    const headers = lines[0].split(',').map(h => h.trim())
    return lines.slice(1).map(line => {
      const cells = line.split(',').map(c => c.trim())
      const row: Record<string, string> = {}
      headers.forEach((h, i) => { row[h] = cells[i] ?? '' })
      return row
    })
  }

  function handleImportFile(file: File) {
    const reader = new FileReader()
    reader.onload = e => {
      const text = e.target?.result as string
      setImportParsed(parseCSV(text))
      setImportResult(null)
    }
    reader.readAsText(file, 'utf-8')
  }

  async function handleImportSubmit() {
    if (!importParsed.length) return
    setImportLoading(true)
    setImportResult(null)

    // 加载商品列表用于名称匹配
    let products: Array<{ id: string; name: string; spec?: string; listPrice?: number }> = []
    try {
      products = await apiGet<typeof products>('/api/products')
    } catch { /* ignore */ }

    // 按餐馆名分组，构建订单
    const groups = new Map<string, typeof importParsed>()
    for (const row of importParsed) {
      const key = row['餐馆名称']?.trim()
      if (!key) continue
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }

    let success = 0
    const errors: string[] = []

    for (const [restaurantName, rows] of groups) {
      const cust = customers.find(c => norm(c.name) === norm(restaurantName))
      if (!cust) { errors.push(isEn ? `Restaurant not found: ${restaurantName}` : `找不到餐馆: ${restaurantName}`); continue }

      const items = rows.map(row => {
        const productName = row['商品名称']?.trim() || ''
        const spec = row['规格']?.trim() || ''
        const quantity = parseFloat(row['数量']) || 1
        const price = parseFloat(row['单价']) || 0
        const matched = products.find(p =>
          norm(p.name) === norm(productName) ||
          (norm(p.name) === norm(productName) && norm(p.spec ?? '') === norm(spec))
        )
        return {
          productId: matched?.id ?? '',
          productName: productName,
          spec,
          quantity,
          price,
          subtotal: quantity * price,
        }
      }).filter(it => it.productName)

      const deliveryBatch = rows[0]['配送批次']?.trim() || ''
      const internalNote = rows[0]['内部备注']?.trim() || ''

      if (!items.length) { errors.push(isEn ? `${restaurantName}: no valid item rows` : `${restaurantName}: 无有效商品行`); continue }

      const missingProducts = items.filter(it => !it.productId)
      if (missingProducts.length) {
        errors.push(isEn
          ? `${restaurantName}: product not found — ${missingProducts.map(i => i.productName).join(', ')}`
          : `${restaurantName}: 商品未找到 — ${missingProducts.map(i => i.productName).join(', ')}`)
        continue
      }

      try {
        await apiPost('/api/orders', {
          restaurantId: cust.id,
          restaurantName: cust.name,
          items,
          deliveryBatch: deliveryBatch || undefined,
          internalNote: internalNote || undefined,
        })
        success++
      } catch (e) {
        errors.push(`${restaurantName}: ${e instanceof Error ? e.message : (isEn ? 'Creation failed' : '创建失败')}`)
      }
    }

    setImportResult({ success, failed: errors.length, errors })
    setImportLoading(false)
    if (success > 0) {
      toast.success(isEn ? `Successfully imported ${success} orders` : `成功导入 ${success} 个订单`)
      refresh()
    }
  }


  // ── Derived maps ─────────────────────────────────────────────────────────

  const invoicedIds = useMemo(() => new Set(invoices.flatMap(inv => inv.saleOrderIds)), [invoices])
  const customerMap = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers])

  const orderDriverMap = useMemo(() => {
    const m = new Map<string, string>()
    trips.forEach(t => {
      if (!t.driverName) return
      t.restaurants?.forEach((r: { orderIds?: string[] }) => r.orderIds?.forEach(id => m.set(id, t.driverName!)))
    })
    return m
  }, [trips])

  // ── Filter pipeline ───────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    let result = [...orders]

    // Quotations page defaults to pending; honor the Status column filter when set
    // (so choosing "Cancelled" actually surfaces cancelled quotations)
    if (!colFilters.status) {
      result = result.filter(o => o.status === 'pending')
    }

    // order today
    if (orderTodayActive) {
      result = result.filter(o => {
        const qd = getField(o, 'quotationDate')
        const ca = o.createdAt ?? ''
        return isSameDay(qd, today) || isSameDay(ca, today)
      })
    }

    // 顶部 Search 框已下推服务端(见 useServerList 的 search/setServerSearch),此处不再客户端二次过滤 ——
    // 避免"匹配记录不在当前页时误判为空"(客户反馈,和交货日期同一类 bug)

    // My Quotations — 按当前登录用户(业务员)过滤
    if (myActive && currentUser?.userId) {
      result = result.filter(o => getField(o, 'salesUserId') === currentUser.userId)
    }

    // 时间快捷(Today/This Week…) — 按交货日期 deliveryDate(与销售单口径一致；未排交货日的报价单不计入)
    const timeRange = timeKey ? computeTimeRange(timeKey) : null
    if (timeRange) {
      result = result.filter(o => {
        const d = getField(o, 'deliveryDate').slice(0, 10)
        return d !== '' && d >= timeRange.from && d <= timeRange.to
      })
    }

    // 分面聚焦搜索：多个 chip 之间 OR(命中任一即可，如 司机:bao 或 单号:260)。
    // 产品/产品类目维度用服务端 xxxFacetIds 交集判定,其余客户端字段直接匹配。
    {
      const facetPredicates: Array<(o: Order) => boolean> = []
      for (const f of facets) {
        const v = f.value.trim().toLowerCase()
        if (!v) continue
        if (f.key === 'all') {
          facetPredicates.push(o =>
            o.restaurantName.toLowerCase().includes(v) ||
            (o.code ?? '').toLowerCase().includes(v) ||
            o.id.toLowerCase().includes(v) ||
            getField(o, 'salesman').toLowerCase().includes(v))
        } else if (f.key === 'code') {
          facetPredicates.push(o => (o.code ?? o.id).toLowerCase().includes(v))
        } else if (f.key === 'customer') {
          facetPredicates.push(o => o.restaurantName.toLowerCase().includes(v))
        } else if (f.key === 'salesman') {
          facetPredicates.push(o => getField(o, 'salesman').toLowerCase().includes(v))
        } else if (f.key === 'driver') {
          facetPredicates.push(o => (orderDriverMap.get(o.id) ?? '').toLowerCase().includes(v))
        }
        // product/category 维度已由服务端 f_product/f_category 原生过滤(见 baseUrl)，
        // 这里拿到的 orders 已经只剩匹配行，不需要再本地判重
      }
      if (facetPredicates.length > 0) {
        result = result.filter(o => facetPredicates.some(p => p(o)))
      }
    }

    // column filters
    const cf = colFilters
    // 单号/客户/销售员已由服务端过滤(见 baseUrl 的 colCode/colCustomer/colSalesman),此处不再客户端二次筛选
    if (cf.quotationDateFrom) result = result.filter(o => getField(o, 'quotationDate').slice(0, 10) >= cf.quotationDateFrom)
    if (cf.quotationDateTo)   result = result.filter(o => getField(o, 'quotationDate').slice(0, 10) <= cf.quotationDateTo)
    if (cf.deliveryDateFrom) result = result.filter(o => { const d = getField(o, 'deliveryDate').slice(0, 10); return d !== '' && d >= cf.deliveryDateFrom })
    if (cf.deliveryDateTo)   result = result.filter(o => { const d = getField(o, 'deliveryDate').slice(0, 10); return d !== '' && d <= cf.deliveryDateTo })
    if (cf.salesTeam)     result = result.filter(o => (orderDriverMap.get(o.id) ?? '').toLowerCase().includes(cf.salesTeam.toLowerCase()))
    if (cf.status) {
      // Odoo state value → internal OrderStatus
      const map: Record<string, OrderStatus[]> = {
        draft:  ['pending'],
        sent:   [],
        sale:   ['confirmed', 'wave_assigned', 'in_delivery'],
        done:   ['completed'],
        cancel: ['cancelled'],
      }
      const allowed = map[cf.status] ?? []
      result = result.filter(o => allowed.includes(o.status))
    }
    if (cf.internalNote) result = result.filter(o => getField(o, 'internalNote').toLowerCase().includes(cf.internalNote.toLowerCase()))
    if (cf.createdAtFrom) result = result.filter(o => (o.createdAt ?? '').slice(0, 10) >= cf.createdAtFrom)
    if (cf.createdAtTo)   result = result.filter(o => (o.createdAt ?? '').slice(0, 10) <= cf.createdAtTo)
    if (cf.weekday) result = result.filter(o => {
      const dd = getField(o, 'deliveryDate')
      if (!dd) return false
      return String(new Date(dd).getDay()) === cf.weekday
    })

    // 其余字段的排序已下推服务端(见 baseUrl),数据到手时已是全局排好序的当页切片,不再客户端二次排序 ——
    // 除了 internalNote 列(服务端无对应可排序字段),仍需客户端排当页数据,是已知局限。
    if (sortField === 'internalNote') {
      result = [...result].sort((a, b) => {
        const av = getField(a, 'internalNote')
        const bv = getField(b, 'internalNote')
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      })
    }

    return result
  }, [orders, activeTab, orderTodayActive, colFilters, invoicedIds, customerMap, orderDriverMap, today, sortField, sortDir, facets, myActive, timeKey, currentUser])

  // ── Group By ─────────────────────────────────────────────────────────────

  const grouped = useMemo(() => {
    if (groupBy === 'none') return null
    const groups = new Map<string, Order[]>()
    filtered.forEach(o => {
      let key = '—'
      if (groupBy === 'customer') key = o.restaurantName
      else if (groupBy === 'salesman') key = getField(o, 'salesman') || '—'
      else if (groupBy === 'salesTeam') key = orderDriverMap.get(o.id) ?? '—'
      else if (groupBy === 'status') key = STATUS_LABEL[o.status] ?? o.status
      else if (groupBy === 'weekday') {
        const dd = getField(o, 'deliveryDate')
        key = dd ? (isEn ? WEEKDAY_NAMES[new Date(dd).getDay()] : `周${WEEKDAY_NAMES[new Date(dd).getDay()]}`) : (isEn ? 'No date' : '无日期')
      }
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(o)
    })
    return groups
  }, [filtered, groupBy, customerMap, orderDriverMap])

  const paginated = filtered

  // ── Tabs ─────────────────────────────────────────────────────────────────

  const toInvoiceCount = useMemo(() => orders.filter(o => o.status === 'completed' && !invoicedIds.has(o.id)).length, [orders, invoicedIds])

  // 默认(无 Status 列筛选)时 baseUrl 恒为 status=PENDING，total 就是真实的待处理总数；
  // 一旦切了 Status 列筛选，退回到用当前页数据估算（跟改造前的近似程度一致，不引入新问题）
  const TABS: { value: TabValue; label: string; count?: number }[] = [
    { value: 'all',        label: isEn ? 'All' : '全部' },
    { value: 'quotations', label: 'Quotations', count: !colFilters.status ? total : orders.filter(o => o.status === 'pending').length },
  ]

  // ── Select helpers ────────────────────────────────────────────────────────

  const allSelected = paginated.length > 0 && paginated.every(o => selected.has(o.id))
  function toggleAll() {
    if (allSelected) setSelected(prev => { const n = new Set(prev); paginated.forEach(o => n.delete(o.id)); return n })
    else setSelected(prev => { const n = new Set(prev); paginated.forEach(o => n.add(o.id)); return n })
  }

  // ── Bulk confirm ─────────────────────────────────────────────────────────

  async function handleBulkConfirm() {
    const ids = [...selected]
    const pendingIds = ids.filter(id => {
      const o = orders.find(o => o.id === id)
      return o?.status === 'pending'
    })
    if (pendingIds.length === 0) {
      toast.info(isEn ? 'All selected orders are already confirmed, nothing to do' : '所选订单均已确认，无需操作')
      return
    }
    setBulkConfirming(true)
    const results = await Promise.allSettled(
      pendingIds.map(id => apiPut(`/api/orders/${id}`, { status: 'CONFIRMED' }))
    )
    const successCount = results.filter(r => r.status === 'fulfilled').length
    const failCount = results.filter(r => r.status === 'rejected').length
    setBulkConfirming(false)
    setSelected(new Set())
    if (failCount === 0) {
      toast.success(isEn ? `Confirmed ${successCount} quotations` : `已确认 ${successCount} 条报价单`)
    } else {
      toast.warning(isEn ? `${successCount} succeeded, ${failCount} failed` : `成功 ${successCount} 条，失败 ${failCount} 条`)
    }
    refresh()
  }

  async function handleBulkDelete() {
    const ids = [...selected]
    if (!confirm(isEn
      ? `Cancel ${ids.length} quotations? You can view them under the "Cancelled" filter afterward.`
      : `确认取消 ${ids.length} 条报价单？取消后可在「已取消」筛选中查看。`)) return
    setBulkDeleting(true)
    const results = await Promise.allSettled(
      ids.map(id => apiPut(`/api/orders/${id}`, { status: 'CANCELLED' }))
    )
    const successCount = results.filter(r => r.status === 'fulfilled').length
    const failCount = results.filter(r => r.status === 'rejected').length
    setBulkDeleting(false)
    setSelected(new Set())
    if (failCount === 0) {
      toast.success(isEn ? `Cancelled ${successCount} quotations` : `已取消 ${successCount} 条报价单`)
    } else {
      toast.warning(isEn ? `${successCount} succeeded, ${failCount} failed` : `成功 ${successCount} 条，失败 ${failCount} 条`)
    }
    refresh()
  }

  async function handleDuplicate() {
    const id = [...selected][0]
    const original = orders.find(o => o.id === id)
    if (!original) return
    setDuplicating(true)
    try {
      const detail = await apiGet<{ id: string; restaurantId: string; restaurantName: string; items: Array<{ productId: string; productName: string; spec?: string; quantity: number; price: number }>; deliveryBatch?: string; internalNote?: string; deliveryDate?: string }>(`/api/orders/${id}`)
      await apiPost('/api/orders', {
        restaurantId: detail.restaurantId,
        restaurantName: detail.restaurantName,
        items: detail.items,
        deliveryBatch: detail.deliveryBatch ?? undefined,
        internalNote: detail.internalNote ?? undefined,
        deliveryDate: detail.deliveryDate ?? undefined,
      })
      toast.success(isEn ? 'Quotation duplicated' : '报价单已复制')
      setSelected(new Set())
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Duplicate failed' : '复制失败'))
    } finally {
      setDuplicating(false)
    }
  }

  async function handleBulkPrint() {
    const ids = [...selected]
    setBulkPrinting(true)
    try {
      const fetched = await Promise.all(
        ids.map(id => apiGet<Order & { code?: string; deliveryDate?: string; internalNote?: string; salesman?: string; deliveryBatch?: string }>(`/api/orders/${id}`))
      )

      const orderSections = fetched.map((o, idx) => {
        const customer = customerMap.get(o.restaurantId) ?? null
        return buildOrderHtml(o, customer, { pageBreakAfter: idx < fetched.length - 1 })
      }).join('')

      const orderCodes = fetched.map(o => o.code ?? o.id.slice(-8).toUpperCase())
      const barcodeInits = orderCodes.map(code => {
        const safe = code.replace(/['"\\]/g, '')
        return `try { JsBarcode('#bc-${safe}', ${JSON.stringify(code)}, { format:'CODE128', width:1.5, height:45, displayValue:false, margin:0 }); } catch(e){}`
      }).join('\n  ')

      const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #111; background:#fff; }
.page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 12mm 12mm 22mm; position: relative; }
.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 7mm; padding-bottom: 3mm; border-bottom: 2px solid #1a3a2a; }
.company-name { font-size: 26pt; font-weight: bold; font-style: italic; color: #1a3a2a; }
.company-addr { text-align: right; font-size: 8.5pt; color: #444; line-height: 1.6; }
.info-table { width: 100%; border-collapse: collapse; margin-bottom: 7mm; }
.info-table td { border: 1px solid #bbb; padding: 3mm 4mm; vertical-align: top; width: 25%; }
.info-head { font-size: 7pt; font-weight: bold; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2mm; }
.info-val  { font-size: 9pt; color: #111; line-height: 1.6; }
.barcode-cell { text-align: center; }
.barcode-svg { max-width: 100%; height: 22mm; display: block; margin: 0 auto; }
.barcode-code { font-size: 9pt; font-weight: bold; margin-top: 1mm; letter-spacing: 1px; }
.lines-table { width: 100%; border-collapse: collapse; margin-bottom: 5mm; }
.lines-table thead tr { background: #1a3a2a; color: #fff; }
.lines-table thead th { padding: 2.5mm 3mm; font-size: 8pt; font-weight: bold; text-transform: uppercase; letter-spacing: 0.3px; }
.lines-table tbody tr.row-even { background: #fff; }
.lines-table tbody tr.row-odd  { background: #f7f7f7; }
.lines-table tbody td { padding: 2mm 3mm; font-size: 9pt; border-bottom: 1px solid #e8e8e8; vertical-align: top; }
.col-qty   { text-align: right; width: 10%; }
.col-unit  { text-align: left;  width: 9%; }
.col-desc  { text-align: left;  width: 43%; }
.col-price { text-align: right; width: 12%; }
.col-vat   { text-align: center; width: 7%; }
.col-incl  { text-align: right; width: 13%; }
.prod-name { font-weight: normal; }
.prod-spec { color: #666; font-size: 8pt; margin-top: 1px; }
.totals-wrap { display: flex; justify-content: flex-end; margin-bottom: 6mm; }
.totals-table { width: 260px; border-collapse: collapse; border: 1px solid #ccc; }
.totals-table tr td { padding: 2mm 4mm; font-size: 9.5pt; border-bottom: 1px solid #e0e0e0; }
.total-label { color: #555; }
.total-value { text-align: right; }
.total-grand td { font-weight: bold; font-size: 11pt; color: #111; border-top: 2px solid #333; border-bottom: none; }
.footer-block { margin-top: 8mm; border-top: 1px solid #ccc; padding-top: 2mm; }
.footer-lines { font-size: 7.5pt; color: #666; line-height: 1.6; }
.footer-page-row { display: flex; justify-content: space-between; font-size: 7.5pt; color: #666; margin-top: 1mm; }
@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { padding: 8mm 12mm 18mm; }
}
`

      const footerHtml = `
<div class="footer-block">
  <div class="footer-lines">
    Tel: (01) 830 8065 / 018308068 / 0879318299 &nbsp;&nbsp; Mail: info@johnstonebros.ie | johnstoneveg@gmail.com<br/>
    Web: https://m.johnstonebros.ie/ &nbsp;&nbsp; VAT: IE9739451J
  </div>
  <div class="footer-page-row">
    <span>Page: 1 / ${fetched.length}</span>
    <span>Print at: <span id="bulk-print-ts"></span></span>
  </div>
</div>`

      const win = window.open('', '_blank')
      if (!win) { toast.error(isEn ? 'Pop-up blocked, please allow pop-ups' : '弹窗被拦截，请允许弹出窗口'); return }
      win.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${isEn ? 'Bulk Print' : '批量打印'} (${ids.length})</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.12.3/dist/JsBarcode.all.min.js"><\/script>
<style>${CSS}</style>
</head>
<body>
${orderSections}
${footerHtml}
<script>
  ${barcodeInits}
  var ts = new Date();
  var pad = function(n){ return n < 10 ? '0'+n : ''+n; };
  document.getElementById('bulk-print-ts').textContent =
    pad(ts.getDate()) + '/' + pad(ts.getMonth()+1) + '/' + ts.getFullYear() +
    ' ' + pad(ts.getHours()) + ':' + pad(ts.getMinutes());
  window.print();
<\/script>
</body>
</html>`)
      win.document.close()
      win.focus()
    } catch {
      toast.error(isEn ? 'Bulk print failed' : '批量打印失败')
    } finally {
      setBulkPrinting(false)
    }
  }


  function setCf(key: keyof ColFilters, value: string) {
    setColFilters(prev => ({ ...prev, [key]: value }))
  }

  function addFacet(key: string, value: string) {
    const field = ORDER_FACET_FIELDS.find(f => f.key === key)
    if (!field) return
    setFacets(prev => [...prev.filter(f => f.key !== key), { key, label: field.label, value }])
  }
  function removeFacet(idx: number) {
    setFacets(prev => prev.filter((_, i) => i !== idx))
  }
  function facetChipLabel(f: Facet) {
    return f.key === 'all' ? f.value : `${f.label}: ${f.value}`
  }

  const hasActiveFilters = Object.values(colFilters).some(v => v !== '')
  const activeFiltersCount = Object.values(colFilters).filter(v => v !== '').length + (orderTodayActive ? 1 : 0)

  // ── Row renderer ──────────────────────────────────────────────────────────

  function renderRow(o: Order) {
    const quotationDate = getField(o, 'quotationDate')
    const internalNote = getField(o, 'internalNote')
    const isSelected = selected.has(o.id)
    const isEditingItems = editItemsId === o.id
    const canEditItems = o.status === 'pending' && !isReadMode

    return (
      <>
        <tr
          key={o.id}
          className={`border-b border-gray-100 cursor-pointer transition-colors ${isSelected ? 'bg-amber-50' : isEditingItems ? 'bg-[#875A7B]/20' : 'hover:bg-gray-50'}`}
          onClick={() => router.push(`${prefix}/classic/operator/quotations/${o.id}`)}
        >
          <td className="pl-3 pr-1 py-2" onClick={e => e.stopPropagation()}>
            <input type="checkbox" checked={isSelected}
              onChange={() => setSelected(prev => { const n = new Set(prev); isSelected ? n.delete(o.id) : n.add(o.id); return n })}
              className="w-3.5 h-3.5 accent-purple-600 cursor-pointer" />
          </td>
          {/* Quotation Number */}
          <td className="px-2 py-2 whitespace-nowrap">
            <span className="text-sm" style={{ color: '#875A7B' }}>{displayOrderCode(o)}</span>
          </td>
          {/* Quotation Date */}
          <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap"><DateCell iso={quotationDate} /></td>
          {/* Customer */}
          <td className="px-2 py-2 text-sm text-gray-800 max-w-[180px] truncate">{o.restaurantName}</td>
          {/* Delivery Date */}
          <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap" onClick={e => e.stopPropagation()}>
            {!isReadMode && editDateId === o.id ? (
              <input
                type="date"
                autoFocus
                value={editDateVal}
                onChange={e => setEditDateVal(e.target.value)}
                onBlur={() => saveDeliveryDate(o.id, editDateVal)}
                className="border border-purple-400 rounded px-1 py-0.5 text-xs bg-white focus:outline-none"
              />
            ) : (
              <span
                className={isReadMode ? '' : 'cursor-pointer hover:text-purple-700 hover:underline'}
                style={{ color: getField(o, 'deliveryDate') ? '#875A7B' : undefined }}
                onClick={isReadMode ? undefined : () => { setEditDateId(o.id); setEditDateVal(getField(o, 'deliveryDate').slice(0, 10)) }}
              >
                {getField(o, 'deliveryDate') ? <DateCell iso={getField(o, 'deliveryDate')} /> : '—'}
              </span>
            )}
          </td>
          {/* Total — clickable for Quotations to open item editor */}
          <td className="px-2 py-2 text-right text-sm text-gray-800 whitespace-nowrap" onClick={e => e.stopPropagation()}>
            {canEditItems ? (
              <button
                onClick={() => isEditingItems ? setEditItemsId(null) : startEditItems(o)}
                className={`tabular-nums hover:underline ${isEditingItems ? 'text-purple-700 font-medium' : 'hover:text-purple-700'}`}
                title={isEn ? 'Click to edit item quantity/price' : '点击编辑商品数量/单价'}
              >
                € {o.totalAmount.toFixed(2)} ✎
              </button>
            ) : (
              <span className="tabular-nums">€ {o.totalAmount.toFixed(2)}</span>
            )}
          </td>
          {/* Status */}
          <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap">{STATUS_LABEL[o.status] ?? o.status}</td>
          {/* Internal Notes */}
          <td className="px-2 py-2 text-sm text-gray-700 max-w-[140px] truncate" title={internalNote}>{internalNote || ''}</td>
          {/* Salesperson — Order.salesman 快照(下单时冻结),不随客户当前业务员变 */}
          <td className="px-2 py-2 text-sm text-gray-700 whitespace-nowrap" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <span>{getField(o, 'salesman') || '—'}</span>
              {canEditItems && (
                <button
                  onClick={async e => {
                    e.stopPropagation()
                    if (!confirm(isEn
                      ? `Cancel quotation ${displayOrderCode(o)}? You can view it under the "Cancelled" filter afterward.`
                      : `确认取消报价单 ${displayOrderCode(o)}？取消后可在「已取消」筛选中查看。`)) return
                    try {
                      await apiPut(`/api/orders/${o.id}`, { status: 'CANCELLED' })
                      toast.success(isEn ? 'Quotation cancelled' : '报价单已取消')
                      refresh()
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : (isEn ? 'Cancel failed' : '取消失败'))
                    }
                  }}
                  className="px-2 py-0.5 text-xs rounded border border-red-300 text-red-600 bg-white hover:bg-red-50 whitespace-nowrap">
                  {isEn ? 'Cancel' : '取消'}
                </button>
              )}
            </div>
          </td>
        </tr>
        {isEditingItems && (
          <tr key={`${o.id}-items`}>
            <td colSpan={13} className="px-4 py-3 bg-[#875A7B]/15 border-b border-[#875A7B]/20">
              <div className="border border-purple-200 rounded bg-white overflow-hidden shadow-sm">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-[#875A7B]/15 border-b border-[#875A7B]/20">
                      <th className="px-3 py-1.5 text-left text-gray-600 font-medium">{isEn ? 'Product Name' : '商品名称'}</th>
                      <th className="px-3 py-1.5 text-left text-gray-500 font-normal">{isEn ? 'Spec' : '规格'}</th>
                      <th className="px-3 py-1.5 text-right text-gray-600 font-medium">{isEn ? 'Quantity' : '数量'}</th>
                      <th className="px-3 py-1.5 text-right text-gray-600 font-medium">{isEn ? 'Unit Price (€)' : '单价 (€)'}</th>
                      <th className="px-3 py-1.5 text-right text-gray-600 font-medium">{isEn ? 'Subtotal' : '小计'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editItemsLines.map((line, idx) => (
                      <tr key={line.productId} className="border-b border-gray-50 last:border-0">
                        <td className="px-3 py-1.5 text-gray-800">{line.productName}</td>
                        <td className="px-3 py-1.5 text-gray-500">{line.spec || '—'}</td>
                        <td className="px-3 py-1.5 text-right">
                          <span className="inline-flex items-center gap-1">
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={line.quantity}
                              onChange={e => {
                                const v = parseFloat(e.target.value) || 0
                                setEditItemsLines(prev => prev.map((l, i) => i === idx ? { ...l, quantity: v } : l))
                              }}
                              className="w-20 text-right border border-purple-300 rounded px-1.5 py-0.5 focus:outline-none focus:border-purple-500 tabular-nums"
                            />
                            {line.uomName && <span className="text-gray-400">{line.uomName}</span>}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.price}
                            onChange={e => {
                              const v = parseFloat(e.target.value) || 0
                              setEditItemsLines(prev => prev.map((l, i) => i === idx ? { ...l, price: v } : l))
                            }}
                            className="w-24 text-right border border-purple-300 rounded px-1.5 py-0.5 focus:outline-none focus:border-purple-500 tabular-nums"
                          />
                        </td>
                        <td className="px-3 py-1.5 text-right font-medium text-gray-800 tabular-nums">
                          € {(line.quantity * line.price).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-[#875A7B]/20 bg-[#875A7B]/15">
                      <td colSpan={4} className="px-3 py-1.5 text-right text-gray-600 font-medium">{isEn ? 'Total' : '合计'}</td>
                      <td className="px-3 py-1.5 text-right font-semibold text-gray-900 tabular-nums">
                        € {editItemsLines.reduce((s, l) => s + l.quantity * l.price, 0).toFixed(2)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
                <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-[#875A7B]/20 bg-[#875A7B]/15">
                  <button
                    onClick={() => setEditItemsId(null)}
                    className="px-3 py-1 text-xs rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
                  >
                    {isEn ? 'Cancel' : '取消'}
                  </button>
                  <button
                    onClick={() => saveItems(o.id)}
                    disabled={savingItems}
                    className="px-4 py-1 text-xs rounded text-white disabled:opacity-60"
                    style={{ background: '#875A7B' }}
                  >
                    {savingItems ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Save' : '保存')}
                  </button>
                </div>
              </div>
            </td>
          </tr>
        )}
      </>
    )
  }

  // ── Column filter row ─────────────────────────────────────────────────────

  const inputCls = 'w-full border border-gray-300 rounded bg-white text-xs px-1.5 py-0.5 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-200'
  const selectCls = 'w-full border border-gray-300 rounded bg-white text-xs px-1.5 py-0.5 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-200'

  function filterRow() {
    const dateLabelCell = (fromKey: keyof ColFilters, toKey: keyof ColFilters) => (
      <td className="px-2 py-1 align-top">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-400 w-9">From:</span>
          <input type="date" value={colFilters[fromKey]} onChange={e => setCf(fromKey, e.target.value)} className={inputCls} />
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          <span className="text-[10px] text-gray-400 w-9">To:</span>
          <input type="date" value={colFilters[toKey]} onChange={e => setCf(toKey, e.target.value)} className={inputCls} />
        </div>
      </td>
    )
    return (
      <tr className="bg-white text-gray-500 border-b border-gray-200">
        <td className="pl-3 pr-1 py-1 text-gray-300">✎</td>
        <td className="px-2 py-1"><input value={colFilters.code} onChange={e => setCf('code', e.target.value)} className={inputCls} /></td>
        {dateLabelCell('quotationDateFrom', 'quotationDateTo')}
        <td className="px-2 py-1"><input value={colFilters.customer}  onChange={e => setCf('customer', e.target.value)}  className={inputCls} /></td>
        {dateLabelCell('deliveryDateFrom', 'deliveryDateTo')}
        <td className="px-2 py-1" />
        <td className="px-2 py-1">
          <select value={colFilters.status} onChange={e => setCf('status', e.target.value)} className={selectCls}>
            <option value=""></option>
            <option value="draft">Quotation</option>
            <option value="sent">Quotation Sent</option>
            <option value="sale">Sales Order</option>
            <option value="done">Locked</option>
            <option value="cancel">Cancelled</option>
          </select>
        </td>
        <td className="px-2 py-1"><input value={colFilters.internalNote} onChange={e => setCf('internalNote', e.target.value)} className={inputCls} /></td>
        <td className="px-2 py-1"><input value={colFilters.salesman} onChange={e => setCf('salesman', e.target.value)} className={inputCls} /></td>
      </tr>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const GROUP_BY_OPTIONS: { value: GroupByField; label: string }[] = [
    { value: 'none',      label: isEn ? 'No Grouping' : '不分组' },
    { value: 'customer',  label: isEn ? 'By Customer' : '按客户' },
    { value: 'salesman',  label: isEn ? 'By Salesperson' : '按业务员' },
    { value: 'salesTeam', label: isEn ? 'By Driver/Batch' : '按司机/批次' },
    { value: 'status',    label: isEn ? 'By Status' : '按状态' },
    { value: 'weekday',   label: isEn ? 'By Delivery Weekday' : '按交货星期' },
  ]

  return (
    <div className="min-h-screen" style={{ background: '#f5f5f5' }}>
      {/* ── Header ── */}
      <OdooControlPanel
        breadcrumb={isEn ? ['Sales', 'Quotations'] : ['销售', 'Quotations']}
        permanentActions={[
          { label: 'Create', onClick: () => router.push(`${prefix}/classic/operator/place-order`), primary: true },
          { label: 'Import', onClick: () => { setShowImportModal(true); setImportParsed([]); setImportResult(null) } },
          ...(isReadMode
            ? [
                { label: 'Mode', onClick: () => setIsReadMode(false) },
                { label: 'Read', onClick: () => {}, primary: true },
              ]
            : [
                { label: 'Edit', onClick: () => {}, primary: true },
                { label: 'Mode', onClick: () => { setIsReadMode(true); setEditDateId(null); setEditItemsId(null) } },
              ]),
          ...(selected.size >= 2 ? [{ label: bulkConfirming ? (isEn ? 'Confirming...' : '确认中...') : (isEn ? `Bulk Confirm (${selected.size})` : `批量确认 (${selected.size})`), onClick: handleBulkConfirm, primary: true, style: 'green' as const, disabled: bulkConfirming }] : []),
          ...(selected.size >= 2 ? [{ label: bulkDeleting ? (isEn ? 'Cancelling...' : '取消中...') : (isEn ? `Bulk Cancel (${selected.size})` : `批量取消 (${selected.size})`), onClick: handleBulkDelete, primary: true, style: 'red' as const, disabled: bulkDeleting }] : []),
          ...(selected.size === 1 ? [{ label: duplicating ? (isEn ? 'Duplicating...' : '复制中...') : 'Duplicate', onClick: handleDuplicate, primary: true, disabled: duplicating }] : []),
          ...(selected.size >= 1 ? [{ label: bulkPrinting ? (isEn ? 'Generating...' : '生成中...') : (isEn ? `Bulk Print (${selected.size})` : `批量打印 (${selected.size})`), onClick: handleBulkPrint, primary: true, disabled: bulkPrinting }] : []),
        ]}
        searchValue={search}
        onSearch={v => { setServerSearch(v) }}
        facetFields={ORDER_FACET_FIELDS}
        onFacetAdd={addFacet}
        filterOptions={[
          { label: myActive ? '✓ My Quotations' : 'My Quotations', value: '__my__' },
          ...TIME_QUICK_OPTIONS.map(o => ({ label: timeKey === o.value ? `✓ ${o.label}` : o.label, value: `__time__${o.value}` })),
          { label: 'Order Today', value: '__order_today__' },
          { label: 'Column filters…', value: '__column_filters__' },
        ]}
        onFilterSelect={v => {
          if (v === '__order_today__') { setOrderTodayActive(x => !x) }
          else if (v === '__column_filters__') setShowFiltersBar(x => !x)
          else if (v === '__my__') { setMyActive(x => !x) }
          else if (v.startsWith('__time__')) { const k = v.slice(8); setTimeKey(prev => prev === k ? '' : k) }
          else { setActiveTab(v as TabValue) }
        }}
        activeFilters={[
          ...facets.map((f, i) => ({ label: facetChipLabel(f), onRemove: () => removeFacet(i) })),
          ...(myActive ? [{ label: 'My Quotations', onRemove: () => setMyActive(false) }] : []),
          ...(timeKey ? [{ label: TIME_QUICK_LABEL[timeKey] ?? timeKey, onRemove: () => setTimeKey('') }] : []),
          ...(orderTodayActive ? [{ label: 'Order Today', onRemove: () => { setOrderTodayActive(false) } }] : []),
          ...(activeTab !== 'all' ? [{ label: 'Quotations only', onRemove: () => { setActiveTab('all') } }] : []),
        ]}
        groupByOptions={GROUP_BY_OPTIONS}
        groupByValue={groupBy}
        onGroupByChange={v => { setGroupBy(v as GroupByField) }}
        storageKey={FAV_KEY}
        favouriteState={{ colFilters, tab: activeTab, orderTodayActive, groupBy, facets, myActive, timeKey }}
        onFavouriteApply={state => {
          const s = state as unknown as SavedFavourite
          if (s.colFilters) setColFilters(s.colFilters)
          if (s.tab) setActiveTab(s.tab)
          setOrderTodayActive(s.orderTodayActive ?? false)
          if (s.groupBy) setGroupBy(s.groupBy)
          setFacets(Array.isArray(s.facets) ? s.facets : [])
          setMyActive(Boolean(s.myActive))
          setTimeKey(String(s.timeKey ?? ''))
        }}
        total={total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      {/* ── Table ── */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm bg-white">
          <thead>
            <tr className="border-b border-gray-200 text-left text-sm font-bold text-gray-700 align-bottom">
              <th className="pl-3 pr-1 py-3 w-8">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} className="w-3.5 h-3.5 accent-purple-600 cursor-pointer" />
              </th>
              {(
                [
                  { field: 'code',          label: 'Quotation\nNumber', right: false },
                  { field: 'quotationDate', label: 'Quotation\nDate',   right: false },
                  { field: 'customer',      label: 'Customer',          right: false },
                  { field: 'deliveryDate',  label: 'Delivery\nDate',    right: false },
                  { field: 'total',         label: 'Total',             right: true  },
                  { field: 'status',        label: 'Status',            right: false },
                  { field: 'internalNote',  label: 'Internal\nNotes',   right: false },
                  { field: 'salesman',      label: 'Salesperson',       right: false },
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
                      <span>{lines.length > 1 ? <>{lines[0]}<br/>{lines[1]}</> : lines[0]}</span>
                      {field && sortField === field && (
                        <span className="text-[10px] text-[#875A7B]">{sortDir === 'asc' ? '▲' : '▼'}</span>
                      )}
                    </div>
                  </th>
                )
              })}
            </tr>
            {filterRow()}
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={13} className="text-center py-12 text-gray-400 text-sm">{isEn ? 'Loading…' : '加载中…'}</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={13} className="text-center py-12 text-gray-400 text-sm">{isEn ? 'No data' : '暂无数据'}</td></tr>
            )}
            {!loading && grouped ? (
              Array.from(grouped.entries()).map(([groupName, groupOrders]) => (
                <Fragment key={groupName}>
                  <tr className="bg-gray-100 border-b border-gray-200">
                    <td colSpan={13} className="px-4 py-1.5 text-xs font-semibold text-gray-600">
                      {groupName} <span className="ml-2 text-gray-400">({groupOrders.length})</span>
                    </td>
                  </tr>
                  {groupOrders.map(o => <Fragment key={o.id}>{renderRow(o)}</Fragment>)}
                </Fragment>
              ))
            ) : (
              !loading && paginated.map(o => <Fragment key={o.id}>{renderRow(o)}</Fragment>)
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between px-2 py-3">
        <span className="text-xs text-gray-400">{isEn ? `${total} total, page ${page}/${Math.max(totalPages, 1)}` : `共 ${total} 条，第 ${page}/${Math.max(totalPages, 1)} 页`}</span>
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} className="mt-0" />
      </div>

      {/* ── Import Modal ── */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowImportModal(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900">{isEn ? 'Import Orders (CSV)' : '导入订单 (CSV)'}</h2>
              <button onClick={() => setShowImportModal(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
            </div>
            <div className="px-5 py-4 space-y-4">
              {/* Template download */}
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-600">{isEn ? '1. Download the template, fill in data, then upload' : '1. 下载模板，填写数据后上传'}</span>
                <button
                  onClick={() => {
                    const blob = new Blob(['﻿' + CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' })
                    const a = document.createElement('a')
                    a.href = URL.createObjectURL(blob)
                    a.download = 'import_template.csv'
                    a.click()
                  }}
                  className="px-3 py-1 text-xs rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                >
                  {isEn ? '↓ Download Template' : '↓ 下载模板'}
                </button>
              </div>

              {/* File input */}
              <div>
                <span className="text-sm text-gray-600 block mb-2">{isEn ? '2. Select CSV file' : '2. 选择 CSV 文件'}</span>
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="text-sm text-gray-600 file:mr-3 file:px-3 file:py-1 file:rounded file:border file:border-gray-300 file:bg-white file:text-xs file:text-gray-700 file:hover:bg-gray-50 file:cursor-pointer"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f) }}
                />
              </div>

              {/* Preview table */}
              {importParsed.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">{isEn ? `Preview (first 5 of ${importParsed.length} rows):` : `预览（前 5 行，共 ${importParsed.length} 行）：`}</p>
                  <div className="overflow-x-auto border rounded">
                    <table className="text-xs w-full">
                      <thead>
                        <tr className="bg-gray-50 border-b">
                          {CSV_HEADERS.map(h => <th key={h} className="px-2 py-1 text-left font-medium text-gray-600 whitespace-nowrap">{isEn ? (CSV_HEADER_LABELS[h] ?? h) : h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {importParsed.slice(0, 5).map((row, i) => (
                          <tr key={i} className="border-b last:border-0">
                            {CSV_HEADERS.map(h => <td key={h} className="px-2 py-1 text-gray-700 whitespace-nowrap">{row[h] || '—'}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {(() => {
                    const seen = new Map<string, { rest: string; product: string; count: number }>()
                    for (const row of importParsed) {
                      const rest = (row['餐馆名称'] ?? '').trim()
                      const product = (row['商品名称'] ?? '').trim()
                      const spec = (row['规格'] ?? '').trim()
                      if (!rest || !product) continue
                      const key = `${rest.toLowerCase()}|${product.toLowerCase()}|${spec.toLowerCase()}`
                      const e = seen.get(key)
                      if (e) e.count++
                      else seen.set(key, { rest, product, count: 1 })
                    }
                    const dups = [...seen.values()].filter(d => d.count > 1)
                    if (dups.length === 0) return null
                    return (
                      <div className="mt-2 rounded-md border border-purple-200 bg-purple-50 px-3 py-2 text-xs text-purple-700">
                        🔁 <span className="font-semibold">{isEn ? 'Duplicate product alert: ' : '重复商品提醒：'}</span>
                        {isEn ? `${dups.length} items were added more than once for the same restaurant —` : `${dups.length} 项在同一餐馆被重复添加 —`}
                        <span className="text-purple-600 ml-1">
                          {dups.map(d => `${d.rest} / ${d.product} ×${d.count}`).join(isEn ? '; ' : '；')}
                        </span>
                        <span className="text-gray-500 ml-1">{isEn ? 'Please confirm this is not a duplicate order' : '请确认是否重复下单'}</span>
                      </div>
                    )
                  })()}
                </div>
              )}

              {/* Import result */}
              {importResult && (
                <div className={`rounded-lg px-4 py-3 text-sm ${importResult.failed === 0 ? 'bg-green-50 text-green-800' : 'bg-yellow-50 text-yellow-800'}`}>
                  <p className="font-medium">{isEn ? `${importResult.success} orders succeeded, ${importResult.failed} failed` : `成功 ${importResult.success} 个订单，失败 ${importResult.failed} 个`}</p>
                  {importResult.errors.length > 0 && (
                    <ul className="mt-1 list-disc list-inside text-xs space-y-0.5 text-red-700">
                      {importResult.errors.map((err, i) => <li key={i}>{err}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-200">
              <button onClick={() => setShowImportModal(false)} className="px-4 py-2 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
                {isEn ? 'Close' : '关闭'}
              </button>
              <button
                onClick={handleImportSubmit}
                disabled={importParsed.length === 0 || importLoading}
                className="px-4 py-2 text-sm rounded text-white disabled:opacity-50"
                style={{ background: '#875A7B' }}
              >
                {importLoading ? (isEn ? 'Importing…' : '导入中…') : (isEn ? `Import ${importParsed.length} rows` : `导入 ${importParsed.length} 行`)}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
