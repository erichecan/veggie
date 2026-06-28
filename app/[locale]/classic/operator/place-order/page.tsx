'use client'
/**
 * 销售代客下单页（经典版 — Odoo Sales Quotation 1:1 还原）
 */
import { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import { getSession } from '@/lib/session'
import { resolveCustomerPrice } from '@/lib/pricing-engine'
import { rankByRelevance } from '@/lib/search-rank'
import type { Product, Customer, OdooPricelist, CustomerPriceType } from '@/lib/types'
import JsBarcode from 'jsbarcode'
import OrderLineEditor from '@/components/classic/OrderLineEditor'

// ─── Constants ───────────────────────────────────────────────────────────────
const LOW_STOCK_THRESHOLD = 20

// ─── Local types ──────────────────────────────────────────────────────────────

type QuotationStatus = 'draft' | 'sent' | 'sale' | 'cancel'

type CreditInfo = {
  paymentTerm: string
  creditLimit: number
  outstandingBalance: number
  overdueAmount: number
  canOrder: boolean
  blockReason?: string
}

type QuotationLine = {
  id: string
  productId: string
  productName: string
  description: string
  note: string
  orderedQty: number
  forecastQty: number | null
  qtyOnHand: number
  uom: string
  uomId?: string
  unitPrice: number
  cost: number
  priceLabel: string       // 'Price' | 'PriceList' | 'Special'
  taxRate: number          // %
  cmsPrice: number
}

type ChatterEntry = {
  type: 'system' | 'message' | 'note' | 'activity'
  text: string
  time: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2, 10)
}

function eur(n: number) {
  return `€${n.toFixed(2)}`
}

function nowLocal() {
  const d = new Date()
  // datetime-local format: YYYY-MM-DDTHH:mm
  return d.toISOString().slice(0, 16)
}

// ─── Code128Barcode (real scannable Code128 via JsBarcode) ───────────────────

function Code128Barcode({ value }: { value: string }) {
  const svgRef = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (!svgRef.current || !value) return
    try {
      JsBarcode(svgRef.current, value, {
        format: 'CODE128',
        width: 1.5,
        height: 32,
        displayValue: false,
        margin: 0,
      })
    } catch {}
  }, [value])
  return <svg ref={svgRef} style={{ width: '100%', maxWidth: 130, display: 'block', margin: '0 auto' }} />
}

// ─── QuotationContent (shared by Preview modal + Print window) ────────────────

type QDocProps = {
  customer: { name: string; address?: string; phone?: string; email?: string } | null
  lines: { productId: string; productName: string; description: string; orderedQty: number; uom: string; unitPrice: number; taxRate: number }[]
  orderDate: string
  salesTeam: string
  quotationNo: string
  untaxed: number
  total: number
  termsConditions: string
}

function QuotationContent({ customer, lines, orderDate, salesTeam, quotationNo, untaxed, total, termsConditions }: QDocProps) {
  const validLines = lines.filter(l => l.productId)
  const printAt = new Date().toLocaleString('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
  const deliveryDate = orderDate
    ? new Date(orderDate).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
    : printAt

  const cell: React.CSSProperties = { border: '1px solid #ccc', padding: '6px 8px', verticalAlign: 'top' }
  const th: React.CSSProperties = { ...cell, backgroundColor: '#f5f5f5', fontWeight: 600, fontSize: 11 }

  return (
    <div style={{ fontFamily: 'Arial, sans-serif', fontSize: 12, color: '#222', maxWidth: 780, margin: '0 auto', padding: 24 }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div style={{ fontSize: 32, fontWeight: 900, color: '#4a7c1f', letterSpacing: -0.5 }}>JohnstoneBros</div>
        <div style={{ textAlign: 'right', fontSize: 11, lineHeight: 1.6 }}>
          <div>141 slaney close</div>
          <div>Dublin11, D11 C3NX</div>
        </div>
      </div>

      {/* ── Info grid ── */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16, tableLayout: 'fixed' }}>
        <thead>
          <tr>
            <th style={{ ...th, width: '28%' }}>Customer</th>
            <th style={{ ...th, width: '26%', textAlign: 'center' }}>Invoice NO</th>
            <th style={{ ...th, width: '30%' }}>Delivery</th>
            <th style={{ ...th, width: '16%' }}>Comment</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={cell}>
              <div style={{ fontWeight: 'bold' }}>{customer?.name ?? '—'}</div>
              {customer?.address && <div style={{ color: '#555', marginTop: 2, fontSize: 11 }}>{customer.address}</div>}
              {/* salesTeam 是业务员(Salesman),不是司机;司机由配送批次(wave)决定。旧 Odoo 用 salesteam 代司机已废弃。 */}
            </td>
            <td style={{ ...cell, textAlign: 'center', verticalAlign: 'middle' }}>
              <div style={{ fontSize: 15, fontWeight: 'bold', letterSpacing: 3 }}>{quotationNo}</div>
              <Code128Barcode value={quotationNo} />
            </td>
            <td style={cell}>
              <div>{deliveryDate}</div>
              <div style={{ marginTop: 4 }}><strong>Salesman:</strong> {salesTeam || 'Admin'}</div>
            </td>
            <td style={cell} />
          </tr>
        </tbody>
      </table>

      {/* ── Lines table ── */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
        <thead>
          <tr>
            <th style={{ ...th, width: '8%' }}>QTY</th>
            <th style={{ ...th, width: '10%' }}>UNIT</th>
            <th style={th}>DESCRIPTION</th>
            <th style={{ ...th, textAlign: 'right', width: '13%' }}>PRICE</th>
            <th style={{ ...th, textAlign: 'right', width: '8%' }}>VAT</th>
            <th style={{ ...th, textAlign: 'right', width: '13%' }}>INCL VAT</th>
          </tr>
        </thead>
        <tbody>
          {validLines.length === 0
            ? <tr><td colSpan={6} style={{ ...cell, height: 48 }} /></tr>
            : validLines.map((line, i) => {
                const inclVat = line.unitPrice * line.orderedQty * (1 + line.taxRate / 100)
                const desc = line.description && line.description !== line.productName
                  ? `${line.productName} — ${line.description}`
                  : line.productName
                return (
                  <tr key={i}>
                    <td style={cell}>{line.orderedQty}</td>
                    <td style={cell}>{line.uom}</td>
                    <td style={cell}>{desc}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>€{line.unitPrice.toFixed(2)}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>{line.taxRate > 0 ? `${line.taxRate}%` : ''}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>€{inclVat.toFixed(2)}</td>
                  </tr>
                )
              })
          }
        </tbody>
      </table>

      {/* ── Totals ── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 28 }}>
        <table style={{ borderCollapse: 'collapse' }}>
          <tbody>
            <tr>
              <td style={{ ...cell, fontWeight: 'bold', paddingRight: 24 }}>Subtotal</td>
              <td style={{ ...cell, textAlign: 'right', minWidth: 80 }}>€{untaxed.toFixed(2)}</td>
            </tr>
            <tr>
              <td style={{ ...cell, fontWeight: 'bold' }}>Total</td>
              <td style={{ ...cell, textAlign: 'right' }}>€{total.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {termsConditions && (
        <div style={{ fontSize: 11, color: '#555', marginBottom: 20, borderTop: '1px solid #eee', paddingTop: 8 }}>
          {termsConditions}
        </div>
      )}

      {/* ── Footer ── */}
      <div style={{ borderTop: '1px solid #bbb', paddingTop: 8, fontSize: 10, color: '#666', marginTop: 40 }}>
        <div style={{ textAlign: 'center' }}>
          Tel: (01) 830 8065 / 018308068 / 0879318299 &nbsp;·&nbsp; Mail: info@johnstonebros.ie | johnstoneveg@gmail.com
        </div>
        <div style={{ textAlign: 'center', marginTop: 2 }}>
          Web: https://m.johnstonebros.ie/ &nbsp;&nbsp; VAT: IE9739451J
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, color: '#888' }}>
          <span>Page: 1 / 1</span>
          <span>Print at: {printAt}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ClassicPlaceOrderPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  // ── Raw data ──────────────────────────────────────────────────────────────
  const [customers, setCustomers] = useState<Customer[]>([])
  const [products,  setProducts]  = useState<Product[]>([])
  const [pricelists, setPricelists] = useState<OdooPricelist[]>([])
  const [loading, setLoading] = useState(true)
  // 完整客户对象（含 specialPrices），在选中客户后懒加载
  const [selectedCustomerFull, setSelectedCustomerFull] = useState<Customer | null>(null)

  // ── Quotation header ──────────────────────────────────────────────────────
  const [status, setStatus]           = useState<QuotationStatus>('draft')
  const [customerId, setCustomerId]   = useState('')
  const [orderDate, setOrderDate]     = useState(nowLocal)
  const [deliveryDate, setDeliveryDate] = useState(() => nowLocal().slice(0, 10))
  const [salesTeam, setSalesTeam]     = useState('')
  const [salesUsers, setSalesUsers]   = useState<{ id: string; name: string }[]>([])
  const [pricelistId, setPricelistId] = useState('')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [priceType, setPriceType]     = useState<CustomerPriceType>('multi')
  const [internalNotes, setInternalNotes]     = useState('')
  const [externalNote, setExternalNote]       = useState('')
  const [noteTab, setNoteTab]                 = useState<'internal' | 'external'>('internal')
  const [termsConditions, setTermsConditions] = useState('')

  // ── Order lines ───────────────────────────────────────────────────────────
  const [lines, setLines] = useState<QuotationLine[]>([])

  // ── 复制历史订单 ──────────────────────────────────────────────────────────
  type HistoryLine = { productId: string; productName: string; orderedQty: number | string; note?: string | null }
  type HistoryOrder = { id: string; code?: string | null; createdAt: string; totalAmount: number | string; lines?: HistoryLine[]; items?: HistoryLine[] }
  const [showHistory, setShowHistory] = useState(false)
  const [historyOrders, setHistoryOrders] = useState<HistoryOrder[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // ── Pending demand (ATP) ────────────────────────────────────────────────────
  // key = productId, value = 所有未出库订单已占用量
  const [pendingDemand, setPendingDemand] = useState<Record<string, number>>({})

  // 重复商品检测：同一 productId 在订单行中出现多次（客户/录单员可能重复添加）
  const duplicateCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const l of lines) if (l.productId) counts.set(l.productId, (counts.get(l.productId) ?? 0) + 1)
    return counts
  }, [lines])

  // ── Last-price cache ──────────────────────────────────────────────────────
  // key = productId, value = 最近一次成交单价（€）
  // 仅本客户当前会话有效，切客户时清空。Object 中没有的 productId 表示"无历史"。
  const [lastPrices, setLastPrices] = useState<Record<string, number>>({})

  // ── Customer dropdown ─────────────────────────────────────────────────────
  const [custSearch, setCustSearch]       = useState('')
  const [custOpen,   setCustOpen]         = useState(false)
  const [custHighlight, setCustHighlight] = useState(0)
  const custRef     = useRef<HTMLDivElement>(null)
  const custListRef = useRef<HTMLDivElement>(null)

  // ── Pricelist dropdown ────────────────────────────────────────────────────
  const [plSearch, setPlSearch]       = useState('')
  const [plOpen,   setPlOpen]         = useState(false)
  const [plHighlight, setPlHighlight] = useState(0)
  const plRef     = useRef<HTMLDivElement>(null)
  const plListRef = useRef<HTMLDivElement>(null)

  // ── Inline product search (one row active at a time) ──────────────────────
  const [activeLineId, setActiveLineId]   = useState<string | null>(null)
  const [lineSearch,   setLineSearch]     = useState('')
  const [lineHighlight, setLineHighlight] = useState(0)
  const lineDropRef  = useRef<HTMLDivElement>(null)
  const lineListRef  = useRef<HTMLDivElement>(null)
  // Fixed-position anchor: stores the input element's bounding rect so the
  // dropdown can be rendered via a portal outside the overflow-x-auto container
  const [dropRect, setDropRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const lineInputRef = useRef<HTMLInputElement>(null)
  // ── Odoo-style Tab navigation ─────────────────────────────────────────────
  const orderDateRef = useRef<HTMLInputElement>(null)
  const salesRef     = useRef<HTMLSelectElement>(null)
  const priceTypeRef = useRef<HTMLSelectElement>(null)
  const qtyInputRef  = useRef<HTMLInputElement>(null)

  // ── Credit control ────────────────────────────────────────────────────────
  const [userRole,   setUserRole]   = useState<string>('')
  const [creditInfo, setCreditInfo] = useState<CreditInfo | null>(null)

  // ── UI state ──────────────────────────────────────────────────────────────
  const [qtyRawMap, setQtyRawMap]     = useState<Record<string, string>>({})
  const [activeTab, setActiveTab]     = useState<'lines' | 'optional' | 'auto' | 'other'>('lines')
  const [logs, setLogs]               = useState<ChatterEntry[]>([
    { type: 'system', text: 'Creating a new record...', time: new Date().toLocaleString('en-GB') },
  ])
  const [submitting, setSubmitting]   = useState(false)

  // ── Preview / Print / Email ───────────────────────────────────────────────
  const [showPreview,     setShowPreview]     = useState(false)
  const [showEmailDialog, setShowEmailDialog] = useState(false)
  const [emailTo,         setEmailTo]         = useState('')
  const [emailSubject,    setEmailSubject]    = useState('')
  const [emailBody,       setEmailBody]       = useState('')
  const [emailSending,    setEmailSending]    = useState(false)

  // Draft quotation number (generated once; real number comes from backend after save)
  const quotationNo = useMemo(() => {
    const now = new Date()
    const p = (n: number, d = 2) => String(n).padStart(d, '0')
    return `D${p(now.getDate())}${p(now.getMonth() + 1)}${String(now.getFullYear()).slice(2)}${p(now.getHours())}${p(now.getMinutes())}`
  }, [])

  // ── Derived ───────────────────────────────────────────────────────────────
  const customer = useMemo(
    () => customers.find(c => c.id === customerId) ?? null,
    [customers, customerId],
  )

  // 销售可在本页临时覆盖客户档案上的 priceType（不写回客户表）。
  // 优先使用懒加载的完整客户对象（含 specialPrices），确保定价引擎拿到特殊价格。
  const effectiveCustomer = useMemo(() => {
    const base = selectedCustomerFull?.id === customerId ? selectedCustomerFull : customer
    // 本单选定的价格表优先于客户档案默认值（操作员可临时切换价格体系）
    return base ? { ...base, priceType, pricelistId: pricelistId || base.pricelistId } : null
  }, [customer, selectedCustomerFull, customerId, priceType, pricelistId])

  const filteredCustomers = useMemo(
    () => rankByRelevance(customers, custSearch, c => c.name),
    [customers, custSearch],
  )

  const filteredPricelists = useMemo(() => {
    const active = pricelists.filter(p => p.active !== false)
    return rankByRelevance(active, plSearch, p => p.name)
  }, [pricelists, plSearch])

  const filteredProducts = useMemo(
    () => rankByRelevance(products, lineSearch, p => [p.name, p.internalRef]),
    [products, lineSearch],
  )

  // ── Click-outside handler (all dropdowns) ─────────────────────────────────
  useEffect(() => {
    function onMouse(e: MouseEvent) {
      if (custRef.current && !custRef.current.contains(e.target as Node)) {
        setCustOpen(false)
      }
      if (plRef.current && !plRef.current.contains(e.target as Node)) {
        setPlOpen(false)
      }
      if (lineDropRef.current && !lineDropRef.current.contains(e.target as Node)) {
        setActiveLineId(null)
        setLineSearch('')
        setDropRect(null)
      }
    }
    document.addEventListener('mousedown', onMouse)
    return () => document.removeEventListener('mousedown', onMouse)
  }, [])

  // ── Load user role for credit-control bypass check ────────────────────────
  useEffect(() => {
    const s = getSession()
    setUserRole(s?.role ?? '')
  }, [])

  // ── Keyboard highlight — reset on search change ────────────────────────────
  useEffect(() => { setCustHighlight(0) }, [custSearch])
  useEffect(() => { setPlHighlight(0) }, [plSearch])
  useEffect(() => { setLineHighlight(0) }, [lineSearch])

  // ── Keyboard highlight — scroll into view ─────────────────────────────────
  useEffect(() => {
    if (!custOpen) return
    const el = custListRef.current?.querySelector(`[data-idx="${custHighlight}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [custHighlight, custOpen])

  useEffect(() => {
    if (!plOpen) return
    const el = plListRef.current?.querySelector(`[data-idx="${plHighlight}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [plHighlight, plOpen])

  useEffect(() => {
    if (!activeLineId) return
    const el = lineListRef.current?.querySelector(`[data-idx="${lineHighlight}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [lineHighlight, activeLineId])

  // ── Reposition portal dropdown when active line changes ──────────────────
  useEffect(() => {
    if (!activeLineId) { setDropRect(null); return }
    // Small delay to let the input render, then measure it
    const t = setTimeout(() => {
      const r = lineInputRef.current?.getBoundingClientRect()
      if (r) setDropRect({ top: r.bottom + 2, left: r.left, width: Math.max(288, r.width) })
    }, 20)
    return () => clearTimeout(t)
  }, [activeLineId])

  // ── Load data ─────────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      // slim=1: 跳过 specialPrices JOIN，客户选定后再懒加载完整对象
      apiGet<Customer[]>('/api/customers?slim=1').catch(() => []),
      // status=ACTIVE: 服务端过滤，不传输已归档商品
      apiGet<Product[]>('/api/products?status=ACTIVE').catch(() => []),
      apiGet<OdooPricelist[]>('/api/pricelists').catch(() => []),
      // role=SALES: 服务端过滤，只拉销售人员
      apiGet<{ id: string; name: string; role: string; roles?: string[] }[]>('/api/users?role=SALES').catch(() => []),
      apiGet<Record<string, number>>('/api/products/pending-demand').catch(() => ({})),
    ])
      .then(([cs, ps, pls, us, pd]) => {
        setCustomers(cs.filter(c => c.isActive !== false))
        setProducts(ps)
        setPricelists(pls)
        setSalesUsers(us)
        setPendingDemand(pd)
      })
      .catch(() => toast.error('加载数据失败'))
      .finally(() => setLoading(false))
  }, [])

  // ── Keyboard navigation handlers ──────────────────────────────────────────
  function handleCustKey(e: React.KeyboardEvent) {
    if (e.key === 'Tab') {
      e.preventDefault()
      setCustOpen(false)
      orderDateRef.current?.focus()
      return
    }
    if (!custOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); setCustOpen(true) }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCustHighlight(i => Math.min(i + 1, filteredCustomers.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCustHighlight(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filteredCustomers[custHighlight]) selectCustomer(filteredCustomers[custHighlight])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setCustOpen(false)
    }
  }

  function handlePlKey(e: React.KeyboardEvent) {
    // +1 for the "— 无 —" clear option at index 0
    const total = filteredPricelists.length + 1
    if (!plOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); setPlOpen(true) }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setPlHighlight(i => Math.min(i + 1, total - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setPlHighlight(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (plHighlight === 0) {
        setPricelistId(''); setPlOpen(false)
      } else {
        const pl = filteredPricelists[plHighlight - 1]
        if (pl) { setPricelistId(pl.id); setPlOpen(false); setPlSearch('') }
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setPlOpen(false)
    }
  }

  function handleLineKey(e: React.KeyboardEvent) {
    const items = filteredProducts.slice(0, 30)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setLineHighlight(i => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setLineHighlight(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeLineId && items[lineHighlight]) {
        // 回车选中商品后立即开下一个商品行，支持连续录入（再次回车进下一个产品）
        selectProduct(activeLineId, items[lineHighlight])
        setDropRect(null)
        addLine()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setActiveLineId(null)
      setLineSearch('')
      setDropRect(null)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      if (activeLineId && items[lineHighlight]) {
        // Tab 选中商品后聚焦到该行第一个字段（备注），再 Tab 依次到 数量→价格→税率
        const targetLineId = activeLineId
        selectProduct(activeLineId, items[lineHighlight])
        setDropRect(null)
        setTimeout(() => {
          document.querySelector<HTMLInputElement>(`[data-desc-line="${targetLineId}"]`)?.focus()
        }, 50)
      } else if (activeLineId && lineSearch.trim() === '') {
        // Empty product field — close the line
        setActiveLineId(null)
        setLineSearch('')
        setDropRect(null)
      }
    }
  }

  // 订单行字段内的键盘流：回车 → 进入下一个商品（开新行）；在最后一个字段(税率) Tab → 同样进下一个商品
  function handleFieldKey(e: React.KeyboardEvent, opts?: { last?: boolean }) {
    if (e.key === 'Enter') {
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).blur()
      addLine()
    } else if (e.key === 'Tab' && opts?.last && !e.shiftKey) {
      e.preventDefault()
      addLine()
    }
  }

  // ── Select customer ───────────────────────────────────────────────────────
  function selectCustomer(c: Customer) {
    if (lines.length > 0 && c.id !== customerId) {
      if (!confirm('切换客户将清空当前订单行，是否继续？')) return
      setLines([])
    }
    setCustomerId(c.id)
    setSelectedCustomerFull(null)  // 先清除旧客户的完整对象
    setCustOpen(false)
    setCustSearch('')
    if (c.pricelistId) setPricelistId(c.pricelistId)
    if (c.paymentTerm) setPaymentTerms(c.paymentTerm)
    if (c.priceType)   setPriceType(c.priceType)
    // 业务员默认带入客户绑定的业务员(可手动改);下单时会快照进 Order.salesman
    if (c.salesman)    setSalesTeam(c.salesman)
    // 切客户必须清空 lastPrice 缓存，否则会把旧客户的成交价用到新客户身上
    setLastPrices({})
    setCreditInfo(null)
    // 异步拉取含 specialPrices 的完整客户对象，供定价引擎使用
    apiGet<Customer>(`/api/customers/${c.id}`)
      .then(full => setSelectedCustomerFull(full))
      .catch(() => {/* 静默失败 — 引擎会回退到标准价 */})
    // 异步拉取信用信息
    apiGet<CreditInfo>(`/api/customers/${c.id}/credit`)
      .then(info => setCreditInfo(info))
      .catch(() => setCreditInfo(null))
  }

  // ── Last-price fetcher ────────────────────────────────────────────────────
  // 批量拉指定 productIds 的最近成交价，结果合并进缓存。
  // 返回最新合并后的 map，方便调用方拿到结果立刻使用（不必等 setState 提交）。
  async function fetchLastPrices(productIds: string[]): Promise<Record<string, number>> {
    if (!customerId || productIds.length === 0) return lastPrices
    // 过滤掉已缓存的，避免重复请求
    const unknown = productIds.filter(pid => !(pid in lastPrices))
    if (unknown.length === 0) return lastPrices
    try {
      const qs = encodeURIComponent(unknown.join(','))
      const res = await apiGet<{ prices: Record<string, number>; missing: string[] }>(
        `/api/customers/${customerId}/last-prices?productIds=${qs}`,
      )
      // missing 也写入缓存（占位为 0），避免反复请求"无历史"的商品
      const merged = { ...lastPrices }
      for (const pid of unknown) {
        if (res.prices[pid] != null) merged[pid] = res.prices[pid]
        else merged[pid] = 0  // 0 = 已查过、无历史
      }
      setLastPrices(merged)
      return merged
    } catch {
      // 静默失败 — 引擎会回退到 listPrice
      return lastPrices
    }
  }

  // 从缓存里取一个有效的 lastPrice 传给引擎（0 / 缺省都视为"无历史"）
  function getLastPrice(productId: string, cache: Record<string, number> = lastPrices): number | undefined {
    const v = cache[productId]
    return v != null && v > 0 ? v : undefined
  }

  // ── Select product for a line ─────────────────────────────────────────────
  // 异步：选商品后会异步拉一次该商品的 lastPrice，拉到后再 patch 行价。
  // 第一次渲染时 lastPrice 还没回来，引擎会按 fallback 走（multi → listPrice / last → listPrice）。
  function selectProduct(lineId: string, p: Product) {
    const computeLine = (cache: Record<string, number>) => {
      const lastPrice = getLastPrice(p.id, cache)
      const res = effectiveCustomer
        ? resolveCustomerPrice(p, effectiveCustomer, pricelists, 1, lastPrice)
        : null
      const unitPrice = res?.price ?? (p.listPrice ?? p.price ?? 0)
      const priceLabel = res?.isSpecialPrice
        ? 'Special'
        : res && !res.isFallback
          ? 'PriceList'
          : 'Price'
      return { unitPrice, priceLabel }
    }

    const { unitPrice, priceLabel } = computeLine(lastPrices)

    // ATP 检查：无库存时阻止添加
    const onHand = p.qtyOnHand ?? 0
    const demand = pendingDemand[p.id] ?? 0
    const atp = onHand - demand
    if (atp <= 0) {
      toast.error(`⚠️ 库存警告：「${p.name}」可承诺量为 ${atp.toFixed(1)}（在手 ${onHand} - 待出 ${demand}），无可用库存！`, { duration: 5000 })
      return
    }

    setLines(prev =>
      prev.map(l =>
        l.id !== lineId
          ? l
          : {
              ...l,
              productId:   p.id,
              productName: p.name,
              description: p.spec ?? p.name,
              orderedQty:  1,
              qtyOnHand:   p.qtyOnHand ?? 0,
              forecastQty: null,
              uom:         (p as Product & { uomName?: string }).uomName ?? 'Unit(s)',
              uomId:       (p as Product & { uomId?: string }).uomId ?? undefined,
              unitPrice,
              cost:        p.standardPrice ?? 0,
              priceLabel,
              taxRate:     (p.customerTaxRate ?? 0) * 100,
              cmsPrice:    p.commissionPrice ?? 0,
            },
      ),
    )
    setActiveLineId(null)
    setLineSearch('')

    // 后台拉 lastPrice，回来后如有变化再 patch 一次
    if (effectiveCustomer && !(p.id in lastPrices)) {
      void fetchLastPrices([p.id]).then(merged => {
        const recomputed = computeLine(merged)
        if (recomputed.unitPrice !== unitPrice || recomputed.priceLabel !== priceLabel) {
          patchLine(lineId, recomputed)
        }
      })
    }
  }

  // ── 复制历史订单 ──────────────────────────────────────────────────────────
  async function openHistory() {
    if (!customerId) { toast.warning('请先选择客户，再复制历史订单'); setCustOpen(true); return }
    setShowHistory(true)
    setHistoryLoading(true)
    try {
      const data = await apiGet<HistoryOrder[] | { data: HistoryOrder[] }>(
        `/api/orders?restaurantId=${customerId}&include_lines=true&pageSize=5`,
      )
      const arr = Array.isArray(data) ? data : (data.data ?? [])
      setHistoryOrders(arr.slice(0, 5))
    } catch {
      toast.error('加载历史订单失败')
    } finally {
      setHistoryLoading(false)
    }
  }

  // 用当前价格表/lastPrice 为历史行的商品重算价格，构造一条订单行
  function buildHistoryLine(p: Product, qty: number, note: string, cache: Record<string, number>): QuotationLine {
    const lastPrice = getLastPrice(p.id, cache)
    const res = effectiveCustomer ? resolveCustomerPrice(p, effectiveCustomer, pricelists, qty, lastPrice) : null
    const unitPrice = res?.price ?? (p.listPrice ?? p.price ?? 0)
    const priceLabel = res?.isSpecialPrice ? 'Special' : res && !res.isFallback ? 'PriceList' : 'Price'
    return {
      id: uid(), productId: p.id, productName: p.name,
      description: p.spec ?? p.name, note,
      orderedQty: qty, forecastQty: null, qtyOnHand: p.qtyOnHand ?? 0,
      uom: (p as Product & { uomName?: string }).uomName ?? 'Unit(s)',
      uomId: (p as Product & { uomId?: string }).uomId ?? undefined,
      unitPrice, cost: p.standardPrice ?? 0, priceLabel,
      taxRate: (p.customerTaxRate ?? 0) * 100, cmsPrice: p.commissionPrice ?? 0,
    }
  }

  function importHistoryOrder(order: HistoryOrder) {
    const histLines = order.lines ?? order.items ?? []
    const newLines: QuotationLine[] = []
    const missing: string[] = []
    for (const hl of histLines) {
      const p = products.find(pp => pp.id === hl.productId)
      if (!p) { missing.push(hl.productName); continue }
      const rawQty = Number(hl.orderedQty) || 1
      // 历史脏数据（如 0.001 占位值）规整为 1，避免把不合理小数带入新订单
      const qty = rawQty > 0 && rawQty < 0.01 ? 1 : rawQty
      newLines.push(buildHistoryLine(p, qty, hl.note ?? '', lastPrices))
    }
    if (newLines.length === 0) { toast.error('该订单商品均已下架，无法导入'); return }
    setLines(prev => [...prev, ...newLines])
    setShowHistory(false)
    // 异步拉 lastPrice 后重算价格（与手动选品体验一致）
    const ids = newLines.map(l => l.productId).filter(id => !(id in lastPrices))
    if (effectiveCustomer && ids.length > 0) {
      void fetchLastPrices(ids).then(merged => {
        setLines(prev => prev.map(l => {
          if (!ids.includes(l.productId)) return l
          const p = products.find(pp => pp.id === l.productId)
          if (!p || !effectiveCustomer) return l
          const res = resolveCustomerPrice(p, effectiveCustomer, pricelists, l.orderedQty, getLastPrice(p.id, merged))
          if (!res) return l
          return { ...l, unitPrice: res.price ?? l.unitPrice, priceLabel: res.isSpecialPrice ? 'Special' : !res.isFallback ? 'PriceList' : 'Price' }
        }))
      })
    }
    toast.success(`已导入 ${newLines.length} 个商品` + (missing.length ? `，${missing.length} 个已下架已跳过` : ''))
    if (missing.length) toast.warning(`跳过下架商品：${missing.join('、')}`)
  }

  // 合并重复商品：同一 productId 的行合并为一行，数量相加，保留第一行的价格等
  function mergeDuplicates() {
    setLines(prev => {
      const seen = new Map<string, QuotationLine>()
      const result: QuotationLine[] = []
      for (const l of prev) {
        if (!l.productId) { result.push(l); continue }
        const existing = seen.get(l.productId)
        if (existing) {
          existing.orderedQty += l.orderedQty
        } else {
          const copy = { ...l }
          seen.set(l.productId, copy)
          result.push(copy)
        }
      }
      return result
    })
    toast.success('已合并重复商品')
  }

  // ── Line CRUD ─────────────────────────────────────────────────────────────
  function addLine() {
    if (!customerId) {
      toast.warning('请先选择客户，再添加商品')
      setCustOpen(true)
      return
    }
    const newId = uid()
    setLines(prev => [
      ...prev,
      {
        id: newId, productId: '', productName: '', description: '', note: '',
        orderedQty: 1, forecastQty: null, qtyOnHand: 0, uom: '', uomId: undefined,
        unitPrice: 0, cost: 0, priceLabel: 'Price', taxRate: 0, cmsPrice: 0,
      },
    ])
    // Auto-activate the search for the new row
    setActiveLineId(newId)
    setLineSearch('')
  }

  function removeLine(id: string) {
    setLines(prev => prev.filter(l => l.id !== id))
  }

  function patchLine(id: string, patch: Partial<QuotationLine>) {
    setLines(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)))
  }

  function updateQty(lineId: string, qty: number) {
    const line = lines.find(l => l.id === lineId)
    if (!line) return
    let unitPrice = line.unitPrice
    if (effectiveCustomer && line.productId) {
      const p = products.find(pp => pp.id === line.productId)
      if (p) {
        const lastPrice = getLastPrice(line.productId)
        unitPrice = resolveCustomerPrice(p, effectiveCustomer, pricelists, qty, lastPrice).price
      }
    }
    patchLine(lineId, { orderedQty: qty, unitPrice })
  }

  // ── 当 priceType / pricelistId / customerId / lastPrices 变化时，重算所有已添加 line。
  // - 切下拉 Multi/Default/Last → 立即生效
  // - 切价格表（本单选其他价格体系）→ 现有行立即按新价格表重算
  // - 切客户 → effectiveCustomer 重建，价格重算
  // - 后台批量拉到 lastPrice → 现有行立即用上历史价
  useEffect(() => {
    if (!effectiveCustomer) return
    setLines(prev => {
      if (prev.length === 0) return prev
      let changed = false
      const next = prev.map(l => {
        if (!l.productId) return l
        const p = products.find(pp => pp.id === l.productId)
        if (!p) return l
        const lastPrice = getLastPrice(l.productId)
        const res = resolveCustomerPrice(p, effectiveCustomer, pricelists, l.orderedQty || 1, lastPrice)
        const newLabel = res.isSpecialPrice
          ? 'Special'
          : !res.isFallback
            ? 'PriceList'
            : 'Price'
        if (l.unitPrice === res.price && l.priceLabel === newLabel) return l
        changed = true
        return { ...l, unitPrice: res.price, priceLabel: newLabel }
      })
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceType, pricelistId, customerId, lastPrices])

  // 切客户后，对当前已有行批量拉一次 lastPrice
  useEffect(() => {
    if (!customerId) return
    const ids = Array.from(new Set(lines.map(l => l.productId).filter(Boolean)))
    if (ids.length === 0) return
    void fetchLastPrices(ids)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId])

  // ── Totals ────────────────────────────────────────────────────────────────
  const untaxed   = lines.reduce((s, l) => s + l.unitPrice * l.orderedQty, 0)
  const taxes     = lines.reduce((s, l) => s + l.unitPrice * l.orderedQty * (l.taxRate / 100), 0)
  const total     = untaxed + taxes
  const cmsTotal  = lines.reduce((s, l) => s + l.cmsPrice * l.orderedQty, 0)
  const cost      = lines.reduce((s, l) => s + l.cost * l.orderedQty, 0)
  const margin    = untaxed - cost

  // ── Submit ────────────────────────────────────────────────────────────────

  function buildOrderPayload(statusOverride: string) {
    const valid = lines.filter(l => l.productId)
    return {
      restaurantId:   customer!.id,
      restaurantName: customer!.name,
      items: valid.map(l => ({
        productId:   l.productId,
        productName: l.productName,
        spec:        l.description,
        note:        l.note || undefined,
        price:       l.unitPrice,
        quantity:    Math.max(0.001, Number(l.orderedQty)),
        subtotal:    l.unitPrice * l.orderedQty,
        uomId:       l.uomId || undefined,
        uomName:     l.uom || undefined,
        taxRate:     l.taxRate,
        commissionPrice: l.cmsPrice || undefined,
      })),
      totalAmount:    total,
      status:         statusOverride,
      paymentMethod:  'online',
      pricelistId:    pricelistId || null,
      priceType,
      salesman:       salesTeam || null,
      internalNote:   internalNotes || null,
      externalNote:   externalNote || null,
      quotationDate:  orderDate ? new Date(orderDate).toISOString() : null,
      deliveryDate:   deliveryDate ? new Date(deliveryDate).toISOString() : null,
    }
  }

  async function handleSave() {
    if (!customer) { toast.warning('请先选择客户'); return }
    const valid = lines.filter(l => l.productId)
    if (valid.length === 0) { toast.warning('请至少添加一个商品'); return }
    if (submitting) return
    setSubmitting(true)
    try {
      const created = await apiPost<{ id: string }>('/api/orders', buildOrderPayload('pending'))
      toast.success('报价单已保存')
      router.push(
        created?.id
          ? `${prefix}/classic/operator/quotations/${created.id}`
          : `${prefix}/classic/operator/quotations`,
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleConfirm() {
    if (!customer) { toast.warning('请先选择客户'); return }
    const valid = lines.filter(l => l.productId)
    if (valid.length === 0) { toast.warning('请至少添加一个商品'); return }
    if (submitting) return
    setSubmitting(true)
    try {
      const created = await apiPost<{ id: string }>('/api/orders', buildOrderPayload('confirmed'))
      setStatus('sale')
      toast.success('订单已确认')
      router.push(
        created?.id
          ? `${prefix}/classic/operator/quotations/${created.id}`
          : `${prefix}/classic/operator/quotations`,
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '下单失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  function handleDiscard() {
    if ((lines.length > 0 || customerId) && !confirm('放弃当前修改？')) return
    setLines([])
    setCustomerId('')
    setPricelistId('')
    setPaymentTerms('')
    setInternalNotes('')
    setTermsConditions('')
    setStatus('draft')
    setCreditInfo(null)
  }

  // ── Preview / Print / Email handlers ─────────────────────────────────────

  function handlePrint() {
    const el = document.getElementById('quotation-print-source')
    if (!el) return
    const w = window.open('', '_blank', 'noopener,width=900,height=720')
    if (!w) { toast.error('请允许弹出窗口以打印'); return }
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Quotation ${quotationNo}</title><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:Arial,sans-serif;background:#fff}
      @media print{@page{margin:1cm;size:A4 portrait}}
    </style></head><body>${el.innerHTML}<script>window.print();<\/script></body></html>`)
    w.document.close()
    w.focus()
  }

  function openEmailDialog() {
    if (!customer) { toast.warning('请先选择客户'); return }
    setEmailTo(customer.email ?? '')
    setEmailSubject(`${customer.name} Quotation (Ref ${quotationNo})`)
    setEmailBody(
      `Dear ${customer.name},\n\nHere is the quotation ${quotationNo} amounting in €${total.toFixed(2)} from Johnstone Fruit & Veg Ltd.\n\nDo not hesitate to contact us if you have any question.`
    )
    setShowEmailDialog(true)
  }

  async function handleSendEmail() {
    if (!emailTo.trim()) { toast.warning('请填写收件人'); return }
    setEmailSending(true)
    await new Promise(r => setTimeout(r, 900))
    setEmailSending(false)
    setShowEmailDialog(false)
    setStatus('sent')
    setLogs(prev => [
      ...prev,
      { type: 'message', text: `邮件已发送至 ${emailTo}：${emailSubject}`, time: new Date().toLocaleString('en-GB') },
    ])
    toast.success('邮件已发送')
  }

  // ── Status bar ────────────────────────────────────────────────────────────
  const STEPS: { key: QuotationStatus; label: string }[] = [
    { key: 'draft', label: 'Quotation' },
    { key: 'sent',  label: 'Quotation Sent' },
    { key: 'sale',  label: 'Sales Order' },
  ]
  const stepIdx = STEPS.findIndex(s => s.key === status)

  // ─────────────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
        加载中…
      </div>
    )
  }

  return (
    <div className="bg-[#f9f9f9] -mx-4 -my-6 min-h-screen">

      {/* ══ Top action bar ════════════════════════════════════════════════════ */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-20">

        {/* Breadcrumb */}
        <div className="px-6 pt-2.5 pb-0.5 text-[13px] text-gray-500 flex items-center gap-1">
          <button
            onClick={() => router.push(`${prefix}/classic/operator/orders`)}
            className="hover:text-[#875A7B] transition-colors"
          >
            Quotations
          </button>
          <span className="text-gray-300 mx-1">›</span>
          <span className="text-gray-800 font-medium">New</span>
        </div>

        {/* Action buttons + status bar */}
        <div className="px-6 py-2 flex items-center gap-2 flex-wrap min-h-[44px]">

          {/* Primary: Save — 保存为待确认的报价单 */}
          <button
            onClick={handleSave}
            disabled={submitting}
            className="h-8 px-4 text-sm font-medium rounded text-white transition-colors disabled:opacity-50"
            style={{ background: '#00adef' }}
            onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = '#0098d4')}
            onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = '#00adef')}
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>

          <button
            onClick={handleDiscard}
            className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
          >
            Discard
          </button>

          <div className="w-px h-5 bg-gray-200" />

          <button
            onClick={openEmailDialog}
            className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
          >
            Send by Email
          </button>
          <button
            onClick={handlePrint}
            className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
          >
            Print
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitting || status === 'sale' || (!!creditInfo && !creditInfo.canOrder && !['BOSS', 'FINANCE'].includes(userRole))}
            className="h-8 px-3 text-sm rounded text-white disabled:opacity-50 transition-colors"
            style={{ background: '#875A7B' }}
            onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = '#7a5070')}
            onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = '#875A7B')}
          >
            Confirm
          </button>
          <button
            onClick={() => setShowPreview(true)}
            className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
          >
            Preview
          </button>
          {status !== 'cancel' && (
            <button
              onClick={() => { if (confirm('取消此报价单？')) setStatus('cancel') }}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-red-500 hover:bg-red-50"
            >
              Cancel
            </button>
          )}

          {/* Status bar — right side */}
          <div className="ml-auto flex items-center">
            {STEPS.map((step, i) => {
              const isActive = i === stepIdx && status !== 'cancel'
              const isDone   = i < stepIdx  && status !== 'cancel'
              const isCancel = status === 'cancel'
              const bg = isCancel && i === stepIdx
                ? '#ef4444'
                : isActive ? '#875A7B'
                  : isDone  ? '#b08da8'
                    : '#e5e7eb'
              const fg = (isActive || isDone || (isCancel && i === stepIdx)) ? '#fff' : '#6b7280'

              return (
                <div key={step.key} className="flex items-center">
                  {/* Left arrow gap for steps after first */}
                  {i > 0 && (
                    <div
                      className="w-0 h-0 -ml-[1px]"
                      style={{
                        borderTop:    '18px solid transparent',
                        borderBottom: '18px solid transparent',
                        borderLeft:   `12px solid ${
                          (i - 1 < stepIdx && status !== 'cancel') ? '#b08da8'
                            : (i - 1 === stepIdx && status !== 'cancel') ? '#875A7B'
                              : '#e5e7eb'
                        }`,
                      }}
                    />
                  )}
                  {/* Step label */}
                  <div
                    className="relative h-9 flex items-center px-4 text-xs font-medium select-none"
                    style={{
                      background: bg,
                      color: fg,
                      paddingLeft: i === 0 ? '16px' : '20px',
                    }}
                  >
                    {step.label}
                    {/* Right arrow */}
                    {i < STEPS.length - 1 && (
                      <div
                        className="absolute right-0 translate-x-full top-0 w-0 h-0 z-10"
                        style={{
                          borderTop:    '18px solid transparent',
                          borderBottom: '18px solid transparent',
                          borderLeft:   `12px solid ${bg}`,
                        }}
                      />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ══ Form body ════════════════════════════════════════════════════════ */}
      <div className="px-6 py-4">

        {/* Two-column header form */}
        <div className="bg-white rounded border border-gray-200 p-5 mb-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-10 gap-y-3">

            {/* ── Left column ────────────────────────────────────────────── */}
            <div className="space-y-3">

              {/* Customer */}
              <div className="flex items-start gap-3">
                <label className="text-sm text-gray-600 w-36 pt-1.5 shrink-0">
                  Customer <span className="text-red-400">*</span>
                </label>
                <div ref={custRef} className="relative flex-1" onKeyDown={handleCustKey}>
                  <div
                    tabIndex={0}
                    onClick={() => setCustOpen(o => !o)}
                    className="border border-gray-300 rounded px-3 py-1.5 text-sm flex items-center justify-between cursor-pointer bg-white hover:border-[#875A7B] min-h-[34px]"
                  >
                    <span className={customer ? 'text-gray-900' : 'text-gray-400'}>
                      {customer ? customer.name : '搜索客户…'}
                    </span>
                    <span className="text-gray-400 text-xs ml-2">▾</span>
                  </div>
                  {custOpen && (
                    <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white border border-gray-200 rounded shadow-lg">
                      <div className="p-2 border-b border-gray-100">
                        <input
                          autoFocus
                          type="text"
                          value={custSearch}
                          onChange={e => setCustSearch(e.target.value)}
                          placeholder="搜索客户…"
                          className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-[#875A7B]/40"
                          onClick={e => e.stopPropagation()}
                        />
                      </div>
                      <div ref={custListRef} className="max-h-52 overflow-y-auto">
                        {filteredCustomers.length === 0 ? (
                          <div className="px-3 py-2 text-sm text-gray-400 text-center">没有匹配客户</div>
                        ) : (
                          filteredCustomers.map((c, idx) => (
                            <div
                              key={c.id}
                              data-idx={idx}
                              onMouseEnter={() => setCustHighlight(idx)}
                              onClick={() => selectCustomer(c)}
                              className={`px-3 py-2 text-sm cursor-pointer hover:bg-[#875A7B]/20 ${
                                idx === custHighlight ? 'bg-[#875A7B]/20' : ''
                              } ${
                                c.id === customerId
                                  ? 'text-[#875A7B] font-medium'
                                  : 'text-gray-700'
                              }`}
                            >
                              {c.name}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Credit Info */}
              {customerId && (
                <div className={`rounded px-3 py-2 text-xs ${
                  creditInfo
                    ? !creditInfo.canOrder
                      ? 'bg-red-50 border border-red-200 text-red-700'
                      : creditInfo.overdueAmount > 0
                        ? 'bg-amber-50 border border-amber-200 text-amber-700'
                        : 'bg-green-50 border border-green-200 text-green-700'
                    : 'bg-gray-50 border border-gray-200 text-gray-400'
                }`}>
                  {!creditInfo ? (
                    <span>加载信用信息...</span>
                  ) : (
                    <>
                      <div className="flex items-center justify-between flex-wrap gap-1">
                        <span className="font-medium">
                          {!creditInfo.canOrder ? '⛔ 信用冻结' : creditInfo.overdueAmount > 0 ? '⚠️ 有逾期欠款' : '✅ 信用正常'}
                        </span>
                        <span>
                          欠款 €{creditInfo.outstandingBalance.toFixed(2)}
                          {creditInfo.creditLimit > 0 && ` / 额度 €${creditInfo.creditLimit.toFixed(2)}`}
                        </span>
                      </div>
                      {!creditInfo.canOrder && creditInfo.blockReason && (
                        <div className="mt-1">{creditInfo.blockReason}</div>
                      )}
                      {!creditInfo.canOrder && !['BOSS', 'FINANCE'].includes(userRole) && (
                        <div className="mt-1 font-medium">需 BOSS 或财务特批</div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Customer Address (read-only, shown after customer selected) */}
              {customer?.address && (
                <div className="flex items-start gap-3">
                  <span className="text-sm text-gray-600 w-36 shrink-0">Address</span>
                  <span className="text-sm text-gray-500">{customer.address}</span>
                </div>
              )}

              {/* Notes Tabs */}
              <div className="flex items-start gap-3">
                <label className="text-sm text-gray-600 w-36 pt-1 shrink-0">备注</label>
                <div className="flex-1">
                  <div className="flex border-b border-gray-200 mb-1">
                    {(['internal', 'external'] as const).map(tab => (
                      <button key={tab} onClick={() => setNoteTab(tab)}
                        className={`px-3 py-1 text-xs font-medium border-b-2 transition-colors ${noteTab === tab ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                        {tab === 'internal' ? '内部备注' : '外部备注'}
                      </button>
                    ))}
                  </div>
                  {noteTab === 'internal' ? (
                    <div className="relative">
                      <textarea
                        rows={2}
                        maxLength={30}
                        value={internalNotes}
                        onChange={e => setInternalNotes(e.target.value.slice(0, 30))}
                        placeholder="仅内部可见，不会打印给客户"
                        className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#875A7B]/40 resize-none"
                      />
                      <span className="absolute bottom-2 right-2 text-xs text-gray-400 pointer-events-none">
                        {internalNotes.length}/30
                      </span>
                    </div>
                  ) : (
                    <textarea
                      rows={3}
                      value={externalNote}
                      onChange={e => setExternalNote(e.target.value)}
                      placeholder="会打印在报价单和送货单上，客户可见"
                      className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#875A7B]/40 resize-none"
                    />
                  )}
                </div>
              </div>
            </div>

            {/* ── Right column ───────────────────────────────────────────── */}
            <div className="space-y-3">

              {/* Order Date */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-600 w-36 shrink-0">Order Date</label>
                <input
                  ref={orderDateRef}
                  type="datetime-local"
                  value={orderDate}
                  onChange={e => setOrderDate(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Tab') {
                      e.preventDefault()
                      salesRef.current?.focus()
                    }
                  }}
                  className="text-sm border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#875A7B]/40"
                />
              </div>

              {/* Delivery Date */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-600 w-36 shrink-0">Delivery Date</label>
                <input
                  type="date"
                  value={deliveryDate}
                  onChange={e => setDeliveryDate(e.target.value)}
                  className="text-sm border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#875A7B]/40"
                />
              </div>

              {/* Sales */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-600 w-36 shrink-0">Sales</label>
                <select
                  ref={salesRef}
                  value={salesTeam}
                  onChange={e => setSalesTeam(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Tab') {
                      e.preventDefault()
                      priceTypeRef.current?.focus()
                    }
                  }}
                  className="flex-1 text-sm border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#875A7B]/40 bg-white"
                >
                  <option value="">— 选择业务员 —</option>
                  {salesUsers.map(u => (
                    <option key={u.id} value={u.name}>{u.name}</option>
                  ))}
                </select>
              </div>

              {/* Pricelist */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-600 w-36 shrink-0">Pricelist</label>
                <div ref={plRef} className="relative flex-1" onKeyDown={handlePlKey}>
                  <div
                    tabIndex={0}
                    onClick={() => setPlOpen(o => !o)}
                    className="border border-gray-300 rounded px-3 py-1.5 text-sm flex items-center justify-between cursor-pointer bg-white hover:border-[#875A7B] min-h-[34px]"
                  >
                    <span className={pricelistId ? 'text-gray-900' : 'text-gray-400'}>
                      {pricelistId
                        ? (pricelists.find(p => p.id === pricelistId)?.name ?? pricelistId)
                        : '— 选择价格表 —'}
                    </span>
                    <span className="text-gray-400 text-xs ml-2">▾</span>
                  </div>
                  {plOpen && (
                    <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white border border-gray-200 rounded shadow-lg">
                      <div className="p-2 border-b border-gray-100">
                        <input
                          autoFocus
                          type="text"
                          value={plSearch}
                          onChange={e => setPlSearch(e.target.value)}
                          placeholder="搜索价格表…"
                          className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-[#875A7B]/40"
                          onClick={e => e.stopPropagation()}
                        />
                      </div>
                      <div ref={plListRef} className="max-h-48 overflow-y-auto">
                        <div
                          data-idx={0}
                          onMouseEnter={() => setPlHighlight(0)}
                          onClick={() => { setPricelistId(''); setPlOpen(false) }}
                          className={`px-3 py-2 text-sm cursor-pointer text-gray-400 hover:bg-gray-50 ${plHighlight === 0 ? 'bg-gray-100' : ''}`}
                        >
                          — 无 —
                        </div>
                        {filteredPricelists.map((pl, idx) => (
                          <div
                            key={pl.id}
                            data-idx={idx + 1}
                            onMouseEnter={() => setPlHighlight(idx + 1)}
                            onClick={() => { setPricelistId(pl.id); setPlOpen(false); setPlSearch('') }}
                            className={`px-3 py-2 text-sm cursor-pointer hover:bg-[#875A7B]/20 ${
                              idx + 1 === plHighlight ? 'bg-[#875A7B]/20' : ''
                            } ${
                              pl.id === pricelistId
                                ? 'text-[#875A7B] font-medium'
                                : 'text-gray-700'
                            }`}
                          >
                            {pl.name}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Payment Terms */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-600 w-36 shrink-0">Payment Terms</label>
                <input
                  type="text"
                  value={paymentTerms}
                  onChange={e => setPaymentTerms(e.target.value)}
                  placeholder="付款条件"
                  className="flex-1 text-sm border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#875A7B]/40"
                />
              </div>

              {/* Price Type */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-600 w-36 shrink-0">Price Type</label>
                <select
                  ref={priceTypeRef}
                  value={priceType}
                  onChange={e => setPriceType(e.target.value as CustomerPriceType)}
                  onKeyDown={e => {
                    if (e.key === 'Tab') {
                      e.preventDefault()
                      addLine()
                    }
                  }}
                  className="flex-1 text-sm border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#875A7B]/40 bg-white"
                >
                  <option value="multi">Multi Price</option>
                  <option value="default">Default Price</option>
                  <option value="last">Last Purchase Price</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* ══ Tabs ══════════════════════════════════════════════════════════ */}
        <div className="bg-white rounded border border-gray-200 mb-4">

          {/* Tab headers */}
          <div className="flex border-b border-gray-200 overflow-x-auto">
            {([
              { key: 'lines',    label: 'Order Lines' },
              // 以下 tab 已隐藏：Optional Products / Automation Information / Other Information
            ] as { key: typeof activeTab; label: string }[]).map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-5 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                  activeTab === tab.key
                    ? 'border-[#875A7B] text-[#875A7B]'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* ── Order Lines tab ──────────────────────────────────────────── */}
          {activeTab === 'lines' && (
            <div>
              {/* 复制历史订单工具条 */}
              <div className="px-3 pt-3 flex items-center gap-2 flex-wrap">
                <button
                  onClick={openHistory}
                  className="px-3 py-1.5 rounded text-sm font-medium text-white inline-flex items-center gap-1.5"
                  style={{ background: '#875A7B' }}
                >
                  📋 复制历史订单
                </button>
                <span className="text-xs text-gray-400">按所选客户最近 5 单复制商品到当前订单，导入后可继续增删改</span>
              </div>

              {showHistory && createPortal(
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowHistory(false)}>
                  <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
                      <h2 className="text-base font-semibold" style={{ color: '#875A7B' }}>复制历史订单 · 最近 5 单</h2>
                      <button onClick={() => setShowHistory(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
                    </div>
                    <div className="px-5 py-4 max-h-[60vh] overflow-y-auto space-y-2">
                      {historyLoading && <div className="py-10 text-center text-sm text-gray-400">加载中…</div>}
                      {!historyLoading && historyOrders.length === 0 && <div className="py-10 text-center text-sm text-gray-400">该客户暂无历史订单</div>}
                      {!historyLoading && historyOrders.map(o => {
                        const hl = o.lines ?? o.items ?? []
                        return (
                          <div key={o.id} className="border rounded-lg px-4 py-3 flex items-center justify-between gap-3" style={{ borderColor: '#e5e7eb' }}>
                            <div className="min-w-0">
                              <div className="text-sm font-medium" style={{ color: '#875A7B' }}>{o.code ?? o.id.slice(0, 8)}</div>
                              <div className="text-xs text-gray-500 mt-0.5">{new Date(o.createdAt).toLocaleDateString('en-GB')} · {hl.length} 项 · €{Number(o.totalAmount).toFixed(2)}</div>
                              <div className="text-xs text-gray-400 mt-0.5 truncate">{hl.slice(0, 3).map(x => x.productName).join('、')}{hl.length > 3 ? ` 等 ${hl.length} 项` : ''}</div>
                            </div>
                            <button onClick={() => importHistoryOrder(o)} className="px-3 py-1.5 rounded text-sm font-medium text-white shrink-0" style={{ background: '#875A7B' }}>导入</button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>,
                document.body,
              )}

              {/* Low stock alert banner (based on ATP) */}
              {(() => {
                const linesWithAtp = lines.filter(l => l.productId).map(l => ({
                  ...l,
                  atp: l.qtyOnHand - (pendingDemand[l.productId] ?? 0),
                }))
                const outOfStockLines = linesWithAtp.filter(l => l.atp <= 0)
                const lowStockLines = linesWithAtp.filter(l => l.atp > 0 && l.atp < LOW_STOCK_THRESHOLD)
                if (outOfStockLines.length === 0 && lowStockLines.length === 0) return null
                return (
                  <div className="mx-3 mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2.5 flex items-start gap-3">
                    <span className="text-lg leading-none mt-0.5">🚨</span>
                    <div className="text-sm">
                      <span className="font-semibold text-red-700">库存警告（基于可承诺量）：</span>
                      {outOfStockLines.length > 0 && (
                        <span className="text-red-600">
                          {outOfStockLines.length} 个商品无可用库存
                          <span className="text-xs text-red-500 ml-1">
                            ({outOfStockLines.map(l => l.productName).join('、')})
                          </span>
                        </span>
                      )}
                      {outOfStockLines.length > 0 && lowStockLines.length > 0 && (
                        <span className="text-gray-400 mx-1.5">|</span>
                      )}
                      {lowStockLines.length > 0 && (
                        <span className="text-amber-700">
                          {lowStockLines.length} 个商品低库存
                          <span className="text-xs text-amber-600 ml-1">
                            ({lowStockLines.map(l => `${l.productName}(ATP: ${l.atp.toFixed(1)})`).join('、')})
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                )
              })()}

              {/* 重复商品提醒 banner */}
              {(() => {
                const dups = [...duplicateCounts.entries()].filter(([, c]) => c > 1)
                if (dups.length === 0) return null
                const nameOf = (pid: string) => lines.find(l => l.productId === pid)?.productName ?? pid
                return (
                  <div className="mx-3 mt-3 rounded-md border border-purple-200 bg-purple-50 px-4 py-2.5 flex items-start gap-3">
                    <span className="text-lg leading-none mt-0.5">🔁</span>
                    <div className="text-sm flex-1">
                      <span className="font-semibold text-purple-700">重复商品提醒：</span>
                      <span className="text-purple-600">
                        {dups.length} 个商品被重复添加
                        <span className="text-xs text-purple-500 ml-1">
                          ({dups.map(([pid, c]) => `${nameOf(pid)} ×${c}`).join('、')})
                        </span>
                      </span>
                      <span className="text-xs text-gray-500 ml-1">— 可点右侧「合并」合并为一行（数量相加），或保留现状手动调整</span>
                    </div>
                    <button
                      onClick={mergeDuplicates}
                      className="shrink-0 px-3 py-1 rounded text-xs font-medium text-white"
                      style={{ background: '#875A7B' }}
                    >
                      合并重复项
                    </button>
                  </div>
                )
              })()}

              {/* Horizontally scrollable 14-column table */}
              <OrderLineEditor
                lines={lines}
                editing={true}
                tableClassName="text-xs border-collapse"
                tableStyle={{ minWidth: '1340px', width: '100%' }}
                tbodyClassName="divide-y divide-gray-100"
                emptyColSpan={15}
                emptyMessage='暂无订单行，点击下方 "+ Add a product" 开始添加'
                renderHeaders={() => (
                  <tr className="bg-gray-50 border-b border-gray-200 text-gray-500 font-medium">
                    <th className="px-2 py-2 text-left"  style={{ width: 40  }}>NO</th>
                    <th className="px-2 py-2 text-left"  style={{ width: 170 }}>Product</th>
                    <th className="px-2 py-2 text-left"  style={{ width: 180 }}>Description</th>
                    <th className="px-2 py-2 text-left"  style={{ width: 130 }}>Note</th>
                    <th className="px-2 py-2 text-right" style={{ width: 90  }}>Ordered Qty</th>
                    <th className="px-2 py-2 text-right" style={{ width: 100 }}>Forecast Qty</th>
                    <th className="px-2 py-2 text-right" style={{ width: 100 }} title="可承诺量 = 在手量 - 待履行量">ATP</th>
                    <th className="px-2 py-2 text-left"  style={{ width: 70  }}>UoM</th>
                    <th className="px-2 py-2 text-right" style={{ width: 90  }}>Unit Price</th>
                    <th className="px-2 py-2 text-right" style={{ width: 80  }}>Cost</th>
                    <th className="px-2 py-2 text-left"  style={{ width: 80  }}>Price</th>
                    <th className="px-2 py-2 text-left"  style={{ width: 70  }}>Taxes</th>
                    <th className="px-2 py-2 text-right" style={{ width: 80  }}>Cms Price</th>
                    <th className="px-2 py-2 text-right" style={{ width: 70  }}>Cms Sub</th>
                    <th className="px-2 py-2 text-right" style={{ width: 100 }}>Cms Total</th>
                  </tr>
                )}
                renderRow={(line, idx) => {
                  const cmsSub    = line.cmsPrice  * line.orderedQty
                  const lineTotal = line.unitPrice * line.orderedQty
                  const isActive  = activeLineId === line.id
                  const lineAtp = line.productId ? line.qtyOnHand - (pendingDemand[line.productId] ?? 0) : line.qtyOnHand
                  const isOutOfStock = line.productId && lineAtp <= 0
                  const isLowStock   = line.productId && lineAtp > 0 && lineAtp < LOW_STOCK_THRESHOLD
                  const isDuplicate  = !!line.productId && (duplicateCounts.get(line.productId) ?? 0) > 1
                  return (
                    <>
                      {/* NO */}
                      <td className="px-2 py-1 text-gray-400 select-none">
                        {idx + 1}
                        {isDuplicate && <span className="ml-1 text-[10px] text-purple-600" title="重复商品">🔁</span>}
                      </td>

                      {/* Product — inline search */}
                      <td className="px-2 py-1 relative">
                        {isActive ? (
                          <div ref={lineDropRef}>
                            <input
                              ref={lineInputRef}
                              autoFocus
                              type="text"
                              value={lineSearch}
                              onChange={e => setLineSearch(e.target.value)}
                              onKeyDown={handleLineKey}
                              placeholder="搜索商品…"
                              className="w-full border border-[#875A7B] rounded px-2 py-0.5 text-xs focus:outline-none"
                              onClick={e => e.stopPropagation()}
                              onFocus={() => {
                                const r = lineInputRef.current?.getBoundingClientRect()
                                if (r) setDropRect({ top: r.bottom + 2, left: r.left, width: Math.max(288, r.width) })
                              }}
                            />
                          </div>
                        ) : (
                          <div
                            onClick={() => { setActiveLineId(line.id); setLineSearch('') }}
                            className={`px-2 py-0.5 rounded cursor-pointer hover:bg-[#875A7B]/20 min-h-[22px] truncate ${
                              line.productName ? 'text-[#875A7B] underline-offset-2' : 'text-gray-400 italic'
                            }`}
                            title={line.productName || '点击选择商品'}
                          >
                            {line.productName || '点击选择商品…'}
                          </div>
                        )}
                      </td>

                      {/* Description */}
                      <td className="px-2 py-1">
                        <input
                          type="text"
                          data-desc-line={line.id}
                          value={line.description}
                          onChange={e => patchLine(line.id, { description: e.target.value })}
                          onKeyDown={e => handleFieldKey(e)}
                          className="w-full px-1.5 py-0.5 text-xs border border-transparent rounded hover:border-gray-200 focus:border-[#875A7B] focus:outline-none bg-transparent"
                        />
                      </td>

                      {/* Note */}
                      <td className="px-2 py-1">
                        <input
                          type="text"
                          data-note-line={line.id}
                          value={line.note}
                          onChange={e => patchLine(line.id, { note: e.target.value })}
                          onKeyDown={e => handleFieldKey(e)}
                          placeholder="备注…"
                          className="w-full px-1.5 py-0.5 text-xs border border-transparent rounded hover:border-gray-200 focus:border-[#875A7B] focus:outline-none bg-transparent placeholder:text-gray-300"
                        />
                      </td>

                      {/* Ordered Qty */}
                      <td className="px-2 py-1">
                        <input
                          ref={isActive ? qtyInputRef : undefined}
                          data-qty-line={line.id}
                          type="text"
                          inputMode="decimal"
                          value={qtyRawMap[line.id] ?? String(line.orderedQty)}
                          onChange={e => {
                            const raw = e.target.value
                            setQtyRawMap(prev => ({ ...prev, [line.id]: raw }))
                            const n = parseFloat(raw)
                            if (!isNaN(n) && n >= 0) updateQty(line.id, n)
                          }}
                          onBlur={() => {
                            const raw = qtyRawMap[line.id] ?? ''
                            const n = parseFloat(raw)
                            const committed = isNaN(n) || n < 0 ? 0 : n
                            updateQty(line.id, committed)
                            setQtyRawMap(prev => { const next = { ...prev }; delete next[line.id]; return next })
                          }}
                          onKeyDown={e => handleFieldKey(e)}
                          className="w-full text-right px-1.5 py-0.5 text-xs border border-transparent rounded hover:border-gray-200 focus:border-[#875A7B] focus:outline-none bg-transparent"
                        />
                      </td>

                      {/* Forecast Qty */}
                      <td className="px-2 py-1 text-right text-gray-400">
                        {line.forecastQty != null ? line.forecastQty.toFixed(3) : '—'}
                      </td>

                      {/* ATP */}
                      <td className="px-2 py-1 text-right" title={line.productId ? `在手: ${line.qtyOnHand.toFixed(1)} | 待出: ${(pendingDemand[line.productId] ?? 0).toFixed(1)} | 可承诺: ${lineAtp.toFixed(1)}` : ''}>
                        {isOutOfStock ? (
                          <span className="inline-flex items-center gap-1 text-red-600 font-semibold">
                            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                            {lineAtp.toFixed(1)}
                          </span>
                        ) : isLowStock ? (
                          <span className="inline-flex items-center gap-1 text-amber-600 font-medium">
                            <span className="w-2 h-2 rounded-full bg-amber-500" />
                            {lineAtp.toFixed(1)}
                          </span>
                        ) : (
                          <span className="text-gray-500">
                            {lineAtp > 0 ? lineAtp.toFixed(1) : '—'}
                          </span>
                        )}
                      </td>

                      {/* UoM */}
                      <td className="px-2 py-1 text-gray-500 truncate">{line.uom || '—'}</td>

                      {/* Unit Price */}
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.unitPrice}
                          onChange={e => patchLine(line.id, { unitPrice: parseFloat(e.target.value) || 0 })}
                          onKeyDown={e => handleFieldKey(e)}
                          className="w-full text-right px-1.5 py-0.5 text-xs border border-transparent rounded hover:border-gray-200 focus:border-[#875A7B] focus:outline-none bg-transparent"
                        />
                      </td>

                      {/* Cost */}
                      <td className="px-2 py-1 text-right text-gray-500">
                        {line.cost > 0 ? eur(line.cost) : '—'}
                      </td>

                      {/* Price label */}
                      <td className="px-2 py-1">
                        {line.productId ? (
                          <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded font-medium ${
                            line.priceLabel === 'Special'
                              ? 'bg-green-100 text-green-700'
                              : line.priceLabel === 'PriceList'
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-gray-100 text-gray-600'
                          }`}>
                            {line.priceLabel}
                          </span>
                        ) : <span className="text-gray-300">—</span>}
                      </td>

                      {/* Taxes */}
                      <td className="px-2 py-1">
                        <select
                          value={line.taxRate}
                          onChange={e => patchLine(line.id, { taxRate: Number(e.target.value) })}
                          onKeyDown={e => handleFieldKey(e, { last: true })}
                          className="w-full text-xs px-1 py-0.5 border border-transparent rounded hover:border-gray-200 focus:border-[#875A7B] focus:outline-none bg-transparent cursor-pointer"
                        >
                          <option value={0}>0%</option>
                          <option value={13.5}>13.5%</option>
                          <option value={23}>23%</option>
                        </select>
                      </td>

                      {/* Cms Price */}
                      <td className="px-2 py-1 text-right text-gray-500">
                        {line.cmsPrice > 0 ? eur(line.cmsPrice) : '—'}
                      </td>

                      {/* Cms Sub */}
                      <td className="px-2 py-1 text-right text-gray-500">
                        {cmsSub > 0 ? eur(cmsSub) : '—'}
                      </td>

                      {/* Cms Total + delete */}
                      <td className="px-2 py-1 text-right">
                        <span className="font-medium text-gray-700">
                          {lineTotal > 0 ? eur(lineTotal) : '—'}
                        </span>
                        <button
                          onClick={() => removeLine(line.id)}
                          className="ml-2 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity align-middle"
                          title="删除此行"
                        >
                          🗑
                        </button>
                      </td>
                    </>
                  )
                }}
                rowStyle={(line) => ({
                  background: (line.productId && (line.qtyOnHand - (pendingDemand[line.productId] ?? 0)) <= 0) ? '#fee2e2'
                    : (line.productId && (line.qtyOnHand - (pendingDemand[line.productId] ?? 0)) > 0 && (line.qtyOnHand - (pendingDemand[line.productId] ?? 0)) < LOW_STOCK_THRESHOLD) ? '#fffbeb'
                    : undefined,
                  boxShadow: (!!line.productId && (duplicateCounts.get(line.productId) ?? 0) > 1) ? 'inset 3px 0 0 0 #875A7B' : undefined,
                })}
                defaultRowCls="group align-middle"
                footer={
                  <div className="px-4 py-2.5 border-t border-gray-100 flex items-center gap-3 flex-wrap">
                    <button
                      onClick={addLine}
                      className="text-sm text-[#875A7B] hover:underline font-medium"
                    >
                      + Add a product
                    </button>
                    <span className="text-gray-300 text-xs">|</span>
                    <button className="text-xs text-gray-400 hover:text-gray-600">Configure a product</button>
                    <span className="text-gray-300 text-xs">|</span>
                    <button className="text-xs text-gray-400 hover:text-gray-600">Add a section</button>
                    <span className="text-gray-300 text-xs">|</span>
                    <button className="text-xs text-gray-400 hover:text-gray-600">Add a note</button>
                  </div>
                }
              />
            </div>
          )}

          {/* Other tabs — placeholder */}
          {activeTab !== 'lines' && (
            <div className="px-6 py-10 text-center text-sm text-gray-400">
              {activeTab === 'optional' && 'Optional Products — not configured'}
              {activeTab === 'auto'     && 'Automation Information — not configured'}
              {activeTab === 'other'    && 'Other Information — not configured'}
            </div>
          )}
        </div>

        {/* ══ Summary row ═══════════════════════════════════════════════════ */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">

          {/* Left: commission total + terms */}
          <div className="bg-white rounded border border-gray-200 p-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600">Commission Total</span>
              <span className="font-medium text-gray-700">{eur(cmsTotal)}</span>
            </div>
            <div>
              <label className="text-sm text-gray-600 block mb-1">Terms &amp; Conditions</label>
              <textarea
                rows={4}
                value={termsConditions}
                onChange={e => setTermsConditions(e.target.value)}
                placeholder="合同条款与条件…"
                className="w-full text-sm border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[#875A7B]/40 resize-none"
              />
            </div>
          </div>

          {/* Right: financial summary */}
          <div className="bg-white rounded border border-gray-200 p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Untaxed Amount</span>
              <span className="text-gray-700">{eur(untaxed)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Taxes</span>
              <span className="text-gray-700">{eur(taxes)}</span>
            </div>
            <div className="flex justify-between border-t border-gray-100 pt-2">
              <span className="font-semibold text-gray-800 text-base">Total</span>
              <span className="text-xl font-bold text-[#875A7B]">{eur(total)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Margin</span>
              <span className={`font-medium ${margin >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                {eur(margin)}
                {untaxed > 0 && (
                  <span className="text-xs text-gray-400 ml-1">
                    ({((margin / untaxed) * 100).toFixed(1)}%)
                  </span>
                )}
              </span>
            </div>
            <div className="flex justify-between text-sm pt-1 border-t border-gray-100">
              <span className="font-semibold text-gray-800">Amount Due</span>
              <span className="font-bold text-gray-800">{eur(total)}</span>
            </div>
          </div>
        </div>

        {/* ══ Chatter ═══════════════════════════════════════════════════════ */}
        <div className="bg-white rounded border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">操作日志</h3>

          {/* Log entries */}
          <div className="mt-4 space-y-0 divide-y divide-gray-50">
            {logs.slice().reverse().map((entry, i) => (
              <div key={i} className="flex items-start gap-3 py-2.5">
                <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-xs text-gray-500 shrink-0 mt-0.5">
                  {entry.type === 'system'   ? '⚙'
                    : entry.type === 'note'  ? '📝'
                    : entry.type === 'activity' ? '📅'
                    : '💬'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800">{entry.text}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">{entry.time}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Hidden print source (always rendered, invisible on screen) ────────── */}
      <div id="quotation-print-source" style={{ display: 'none' }}>
        <QuotationContent
          customer={customer}
          lines={lines}
          orderDate={orderDate}
          salesTeam={salesTeam}
          quotationNo={quotationNo}
          untaxed={untaxed}
          total={total}
          termsConditions={termsConditions}
        />
      </div>

      {/* ── Preview modal ──────────────────────────────────────────────────── */}
      {showPreview && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto"
          style={{ background: 'rgba(0,0,0,0.55)' }}
          onClick={e => { if (e.target === e.currentTarget) setShowPreview(false) }}
        >
          <div className="bg-white rounded shadow-2xl mt-10 mb-10 w-full max-w-3xl relative">
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-gray-50 rounded-t">
              <span className="text-sm font-semibold text-gray-700">Quotation Preview — {quotationNo}</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePrint}
                  className="h-7 px-3 text-xs rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                >
                  🖨 Print
                </button>
                <button
                  onClick={() => setShowPreview(false)}
                  className="h-7 w-7 flex items-center justify-center rounded text-gray-400 hover:bg-gray-200 text-lg leading-none"
                >
                  ×
                </button>
              </div>
            </div>
            {/* PDF layout */}
            <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 140px)' }}>
              <QuotationContent
                customer={customer}
                lines={lines}
                orderDate={orderDate}
                salesTeam={salesTeam}
                quotationNo={quotationNo}
                untaxed={untaxed}
                total={total}
                termsConditions={termsConditions}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Send by Email dialog ────────────────────────────────────────────── */}
      {showEmailDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={e => { if (e.target === e.currentTarget) setShowEmailDialog(false) }}
        >
          <div className="bg-white rounded shadow-2xl w-full max-w-2xl" style={{ maxHeight: '90vh', overflowY: 'auto' }}>

            {/* Dialog header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <span className="font-semibold text-gray-800">Odoo</span>
              <button
                onClick={() => setShowEmailDialog(false)}
                className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 text-xl leading-none"
              >
                ×
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-4">

              {/* Recipients */}
              <div className="flex items-start gap-3">
                <label className="text-sm font-medium text-gray-700 w-24 pt-2 shrink-0">Recipients</label>
                <div className="flex-1 space-y-1.5">
                  <div className="text-sm text-gray-500">Followers of the document and</div>
                  <input
                    type="text"
                    value={emailTo}
                    onChange={e => setEmailTo(e.target.value)}
                    placeholder="Add contacts to notify..."
                    className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#875A7B]/40"
                  />
                </div>
              </div>

              {/* Subject */}
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-700 w-24 shrink-0">Subject</label>
                <input
                  type="text"
                  value={emailSubject}
                  onChange={e => setEmailSubject(e.target.value)}
                  className="flex-1 border border-[#c0a8d0] bg-[#f3ecf8] rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#875A7B]/40"
                />
              </div>

              {/* Body */}
              <div className="border border-gray-200 rounded">
                {/* Mini toolbar */}
                <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-100 bg-gray-50 rounded-t flex-wrap">
                  {['✏', 'B', 'I', 'U'].map(t => (
                    <button key={t} className="w-6 h-6 text-xs rounded hover:bg-gray-200 text-gray-600 font-medium">{t}</button>
                  ))}
                  <div className="w-px h-4 bg-gray-200 mx-1" />
                  <button className="w-6 h-6 text-xs rounded hover:bg-gray-200 text-gray-500">A</button>
                  <button className="w-6 h-6 text-xs rounded hover:bg-gray-200 text-gray-500">≡</button>
                </div>
                <textarea
                  rows={6}
                  value={emailBody}
                  onChange={e => setEmailBody(e.target.value)}
                  className="w-full px-3 py-2 text-sm focus:outline-none resize-none rounded-b"
                />
              </div>

              {/* Attachment */}
              <div className="flex items-start gap-4 flex-wrap">
                <div className="flex items-start gap-2">
                  {/* PDF attachment chip */}
                  <div className="flex flex-col items-center">
                    <div
                      className="w-16 h-16 border border-gray-200 rounded flex flex-col items-center justify-center bg-gray-50 cursor-pointer hover:bg-gray-100 relative group"
                      title={`${quotationNo}.pdf`}
                    >
                      <svg viewBox="0 0 24 24" className="w-8 h-8 text-red-500" fill="currentColor">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11zM8 15h2v2H8zm0-4h8v2H8zm4-4h4v2h-4z"/>
                      </svg>
                      <span className="absolute -top-1 -right-1 w-4 h-4 bg-white rounded-full flex items-center justify-center text-gray-400 text-xs border border-gray-200 opacity-0 group-hover:opacity-100 cursor-pointer">×</span>
                    </div>
                    <span className="text-[10px] text-gray-500 mt-1 max-w-[64px] truncate text-center">{quotationNo}.pdf</span>
                  </div>
                  <button className="text-xs text-[#875A7B] hover:underline mt-1 flex items-center gap-1">
                    <span>📎</span> Attach a file
                  </button>
                </div>

                {/* Use template */}
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-sm text-gray-600">Use template</span>
                  <select className="text-sm border border-gray-300 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-[#875A7B]/40">
                    <option>Sales Order: Send by email</option>
                    <option>Sales Order: Quotation</option>
                  </select>
                  <button className="text-gray-400 hover:text-[#875A7B]">↗</button>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50 rounded-b">
              <button
                onClick={handleSendEmail}
                disabled={emailSending}
                className="h-8 px-5 text-sm font-medium rounded text-white disabled:opacity-60 transition-colors"
                style={{ background: '#875A7B' }}
              >
                {emailSending ? 'Sending…' : 'Send'}
              </button>
              <button
                onClick={() => setShowEmailDialog(false)}
                className="h-8 px-4 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button className="ml-auto text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
                💾 Save as new template
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Product search portal ─────────────────────────────────────────────
          Rendered at document.body so it escapes the overflow-x:auto table
          container and is never clipped. Positioned via fixed coords from
          the input element's getBoundingClientRect().
      ──────────────────────────────────────────────────────────────────────── */}
      {activeLineId && dropRect && typeof document !== 'undefined' && createPortal(
        <div
          style={{
            position: 'fixed',
            top:   dropRect.top,
            left:  dropRect.left,
            width: dropRect.width,
            zIndex: 9999,
          }}
          onMouseDown={e => e.preventDefault()}   // keep input focused
        >
          <div ref={lineListRef} className="bg-white border border-gray-200 rounded shadow-xl max-h-52 overflow-y-auto">
            {filteredProducts.slice(0, 30).length === 0 ? (
              <div className="px-3 py-2 text-xs text-gray-400 text-center">没有匹配商品</div>
            ) : (
              filteredProducts.slice(0, 30).map((p, idx) => (
                <div
                  key={p.id}
                  data-idx={idx}
                  onMouseEnter={() => setLineHighlight(idx)}
                  onMouseDown={e => {
                    e.preventDefault()
                    selectProduct(activeLineId, p)
                    setDropRect(null)
                  }}
                  className={`px-3 py-1.5 text-xs cursor-pointer hover:bg-[#875A7B]/20 flex items-center gap-2 ${idx === lineHighlight ? 'bg-[#875A7B]/20' : ''}`}
                >
                  <span className="font-medium text-gray-800 truncate flex-1">{p.name}</span>
                  {p.internalRef && (
                    <span className="text-gray-400 text-[10px] shrink-0">[{p.internalRef}]</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
