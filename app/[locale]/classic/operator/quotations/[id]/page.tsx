'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { priceOf, factorOf } from '@/lib/sale-uom'
import type { SaleUomPriceMode } from '@/lib/sale-uom'
import { useParams, useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import { formatDriverSlotFromOrder, type DriverSlotInfo } from '@/lib/driver-slot'
import OrderLineEditor from '@/components/classic/OrderLineEditor'
import type { Order, Customer, OdooPricelist as Pricelist, CustomerPriceType } from '@/lib/types'
import { displayOrderCode } from '@/lib/order-code'
import { OrderChatter } from '@/components/order/OrderChatter'
import { getSession, type UserSession } from '@/lib/session'
import { resolveCustomerPrice } from '@/lib/pricing-engine'
import { formatPriceSourceBadge } from '@/lib/price-source'
import { lineFieldKeyHandler } from '@/lib/order-line-keys'
import { SalesPriceHistoryButton } from '@/components/classic/SalesPriceHistoryModal'
import SendEmailDialog from '@/components/orders/send-email-dialog'
import { useHotkeys } from '@/components/shared/use-hotkeys'
import { lineDescription } from '@/lib/order-line-description'
import { newDraftLineId, isDraftLineId, toSubmittableLines } from '@/lib/order-line-draft'

const PURPLE = '#875A7B'
const LOW_STOCK_THRESHOLD = 20

interface AllProduct {
  id: string
  name: string
  internalRef?: string | null
  spec?: string | null
  listPrice?: number
  standardPrice?: number
  customerTaxRate?: number
  uomName?: string
  uomId?: string
}

// 多单位销售(20260714 试点)：商品挂的额外可售单位，与 place-order 创建页同构
type SaleUomOption = {
  uomId: string; uomName: string; isDefault?: boolean; factor: number; priceOverride: number | null
  priceMode: SaleUomPriceMode; priceDiscountPct: number; priceSurcharge: number
}

interface CreditInfo {
  outstandingBalance: number
  overdueAmount: number
  paymentTerm: string
  creditLimit: number
  canOrder: boolean
  blockReason?: string
}

interface ForecastRow { productId: string; forecast: number; qtyOnHand: number }

export default function QuotationDetailPage() {
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const params = useParams<{ id: string }>()
  const id = params.id

  const [order, setOrder] = useState<Order | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [pricelist, setPricelist] = useState<Pricelist | null>(null)
  const [pricelists, setPricelists] = useState<Pricelist[]>([])
  const [forecastMap, setForecastMap] = useState<Map<string, ForecastRow>>(new Map())
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  // OrderLineEditor 内部的商品搜索框 ref 是私有的，靠 onReady 把 focus 能力递出来给快捷键用
  const focusLineSearchRef = useRef<(() => void) | null>(null)
  // 插完空行要让那一行立刻进搜索态 —— 与新建页同一套交互
  const activatePickerRef = useRef<(lineId: string) => void>(() => {})
  const handleEditorReady = useCallback(
    (api: { focusSearch: () => void; activateProductPicker: (lineId: string) => void }) => {
      focusLineSearchRef.current = api.focusSearch
      activatePickerRef.current = api.activateProductPicker
    }, [])
  const [sendEmailOpen, setSendEmailOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [cancelModalOpen, setCancelModalOpen] = useState(false)
  // Editable buffer
  const [internalNote, setInternalNote] = useState('')
  const [externalNote, setExternalNote] = useState('')
  const [noteTab, setNoteTab] = useState<'internal' | 'external'>('internal')
  const [salesUserId, setSalesUserId] = useState('')
  const [salesUsers, setSalesUsers] = useState<{ id: string; name: string }[]>([])
  useEffect(() => { apiGet<{ id: string; name: string }[]>('/api/users?role=SALES').then(setSalesUsers).catch(() => {}) }, [])
  const [deliveryDate, setDeliveryDate] = useState('')
  const [deliveryBatch, setDeliveryBatch] = useState('')
  const [driverSlotId, setDriverSlotId] = useState('')
  const [pricelistId, setPricelistId] = useState('')
  const [priceType, setPriceType] = useState('multi')
  const [paymentTerm, setPaymentTerm] = useState('')
  const [driverSlots, setDriverSlots] = useState<DriverSlotInfo[]>([])
  useEffect(() => { apiGet<DriverSlotInfo[]>('/api/driver-slots').then(setDriverSlots).catch(() => {}) }, [])

  type EditLine = NonNullable<Order['lines']>[number]
  const [editLines, setEditLines] = useState<EditLine[]>([])
  // 重复商品检测：同一 productId 在编辑缓冲区中出现多次（与 place-order 创建页一致）
  const duplicateCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const l of editLines) if (l.productId) counts.set(l.productId, (counts.get(l.productId) ?? 0) + 1)
    return counts
  }, [editLines])
  const [allProducts, setAllProducts] = useState<AllProduct[]>([])
  // 本单覆盖：编辑页可临时切换 pricelist/priceType（不写回客户档案），
  // 加行询价必须用叠加后的客户对象，否则永远只按客户档案默认链定价（与 place-order 创建页一致）
  const effectiveCustomer = useMemo(() => customer
    ? { ...customer, priceType: priceType as CustomerPriceType, pricelists: pricelistId ? [{ pricelistId, sequence: 1 }] : customer.pricelists }
    : null,
  [customer, priceType, pricelistId])
  // 多单位销售(20260714 试点)：全局单位 factor 表 + 按商品懒加载的额外可售单位
  const [saleUomOptions, setSaleUomOptions] = useState<Record<string, SaleUomOption[]>>({})
  const [creditInfo, setCreditInfo] = useState<CreditInfo | null>(null)
  const [session, setSession] = useState<UserSession | null>(null)
  useEffect(() => { setSession(getSession()) }, [])

  async function load() {
    setLoading(true)
    try {
      const ord = await apiGet<Order>(`/api/orders/${id}`)
      setOrder(ord)
      setInternalNote(ord.internalNote ?? '')
      setExternalNote((ord as unknown as { externalNote?: string }).externalNote ?? '')
      setSalesUserId((ord as unknown as { salesUserId?: string }).salesUserId ?? '')
      setDeliveryDate(ord.deliveryDate ? new Date(ord.deliveryDate).toISOString().slice(0, 10) : '')
      setDeliveryBatch(ord.deliveryBatch ?? '')
      setDriverSlotId((ord as unknown as { driverSlotId?: string }).driverSlotId ?? '')
      setPricelistId(ord.pricelistId ?? '')
      setPriceType((ord as unknown as { priceType?: string }).priceType ?? 'multi')
      setPaymentTerm((ord as unknown as { paymentTerm?: string }).paymentTerm ?? '')

      const [cs, pls] = await Promise.all([
        apiGet<Customer[]>('/api/customers').catch(() => [] as Customer[]),
        apiGet<Pricelist[]>('/api/pricelists').catch(() => [] as Pricelist[]),
      ])
      setCustomer(cs.find(c => c.id === ord.restaurantId) ?? null)
      setPricelists(pls)
      if (ord.pricelistId) setPricelist(pls.find(p => p.id === ord.pricelistId) ?? null)
      if (ord.restaurantId) {
        apiGet<CreditInfo>(`/api/customers/${ord.restaurantId}/credit`).then(setCreditInfo).catch(() => {})
      }


      const productIds = Array.from(new Set((ord.lines ?? []).map(l => l.productId).filter(Boolean)))
      if (productIds.length > 0) {
        apiGet<ForecastRow[]>(`/api/products/forecast?ids=${productIds.join(',')}`)
          .then(rows => {
            const m = new Map<string, ForecastRow>()
            rows.forEach(r => m.set(r.productId, r))
            setForecastMap(m)
          }).catch(() => {})
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  const [pendingDemand, setPendingDemand] = useState<Record<string, number>>({})

  useEffect(() => {
    apiGet<AllProduct[]>('/api/products?sellable=1&slim=1').then(p => setAllProducts(Array.isArray(p) ? p : [])).catch(() => {})
    apiGet<Record<string, number>>('/api/products/pending-demand').then(setPendingDemand).catch(() => {})
  }, [])

  // 商品管理侧改了 canBeSold 等字段后，希望回到这个已经打开的页面时能看到最新数据，
  // 但又不想引入 SWR/React Query —— 用「重新聚焦/切回本 tab 时刷新，节流 30s」这个轻量方案。
  useEffect(() => {
    let lastFetch = Date.now()
    function refetchProducts() {
      if (Date.now() - lastFetch < 30_000) return
      lastFetch = Date.now()
      apiGet<AllProduct[]>('/api/products?sellable=1&slim=1')
        .then(p => setAllProducts(Array.isArray(p) ? p : []))
        .catch(() => {})
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') refetchProducts()
    }
    window.addEventListener('focus', refetchProducts)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', refetchProducts)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // 缺货提醒(20260729)：编辑期间新增的行不在初次 load() 拉取的 forecastMap 里，单独补一条
  function ensureForecast(productId: string) {
    if (!productId || forecastMap.has(productId)) return
    apiGet<ForecastRow[]>(`/api/products/forecast?ids=${productId}`)
      .then(rows => { if (rows[0]) setForecastMap(prev => new Map(prev).set(productId, rows[0])) })
      .catch(() => {})
  }

  // 多单位销售(20260714 试点)：懒加载某商品配置的额外可售单位；已加载过就跳过
  function ensureSaleUomOptions(productId: string) {
    if (!productId || productId in saleUomOptions) return
    setSaleUomOptions(prev => ({ ...prev, [productId]: [] })) // 占位，避免并发重复请求
    apiGet<Array<{ uomId: string; isDefault: boolean; factor: number | string | null; priceOverride: number | null; active: boolean; priceMode?: SaleUomPriceMode; priceDiscountPct?: number | string | null; priceSurcharge?: number | string | null; uom: { name: string; nameZh?: string | null } }>>(
      `/api/products/${productId}/sale-uoms`,
    )
      .then(rows => {
        // factor 取 ProductSaleUom.factor（这个商品自己的箱规），不是全局 uom.factor
        const opts = rows
          .filter(r => r.active)
          .map(r => ({
            uomId: r.uomId,
            uomName: isEn ? r.uom.name : (r.uom.nameZh ?? r.uom.name),
            isDefault: r.isDefault,
            factor: Number(r.factor ?? 1) || 1,
            priceOverride: r.priceOverride,
            priceMode: r.priceMode ?? 'AUTO',
            priceDiscountPct: r.priceDiscountPct != null ? Number(r.priceDiscountPct) : 0,
            priceSurcharge: r.priceSurcharge != null ? Number(r.priceSurcharge) : 0,
          }))
        setSaleUomOptions(prev => ({ ...prev, [productId]: opts }))
      })
      .catch(() => setSaleUomOptions(prev => ({ ...prev, [productId]: [] })))
  }

  // 切换某行的单位：按换算系数(或该单位的独立售价)重算单价，不重新触发定价引擎，
  // 避免把用户手动改过的单价/来源覆盖掉——与本页"改数量/改单价不触发定价引擎重算"的既有行为一致
  function switchLineUnit(idx: number, newUomId: string) {
    setEditLines(prev => {
      const line = prev[idx]
      if (!line || !line.productId) return prev
      const p = allProducts.find(pp => pp.id === line.productId)
      if (!p) return prev
      const anchorUomId = p.uomId
      const currentUomId = line.uomId ?? anchorUomId
      if (!currentUomId || newUomId === currentUomId) return prev
      const opts = saleUomOptions[p.id] ?? []
      const rows = opts.map(o => ({
        uomId: o.uomId, isDefault: !!o.isDefault, factor: o.factor, priceOverride: o.priceOverride,
        priceMode: o.priceMode, priceDiscountPct: o.priceDiscountPct, priceSurcharge: o.priceSurcharge,
      }))
      const nameOf = (uid: string) => uid === anchorUomId
        ? (p.uomName ?? 'Unit(s)')
        : (opts.find(o => o.uomId === uid)?.uomName ?? line.uomName)
      // 从当前行价倒推基础单价，再按新单位折算 —— 这样用户手改过的单价不会被定价引擎冲掉，
      // 与本页"改数量/改单价不触发定价引擎重算"的既有行为一致。
      // 换算与库存扣减共用 lib/sale-uom.ts，两边不会算得不一样。
      const oldFactor = factorOf(rows, currentUomId)
      const basePrice = oldFactor ? Number(line.unitPrice) / oldFactor : Number(line.unitPrice)
      const newUnitPrice = priceOf(rows, newUomId, basePrice)
      const qty = Number(line.orderedQty)
      const next = [...prev]
      next[idx] = {
        ...line,
        uomId: newUomId,
        uomName: nameOf(newUomId),
        unitPrice: newUnitPrice,
        subtotal: Math.round(qty * newUnitPrice * 100) / 100,
        priceSourceType: null,
        priceSourceDetail: null,
        priceSourceDate: null,
      }
      return next
    })
  }

  // Status flow
  const flowSegment: 'quotation' | 'sale' = useMemo(() => {
    if (!order) return 'quotation'
    return order.status.toUpperCase() === 'PENDING' ? 'quotation' : 'sale'
  }, [order])

  function deleteLine(idx: number) {
    setEditLines(prev => prev.filter((_, i) => i !== idx))
  }

  function moveLine(from: number, to: number) {
    setEditLines(prev => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  function updateLine(idx: number, field: 'orderedQty' | 'unitPrice' | 'taxRate' | 'spec' | 'note', value: number | string) {
    setEditLines(prev => {
      const next = [...prev]
      const line: EditLine = { ...next[idx], [field]: value }
      if (field === 'orderedQty' || field === 'unitPrice') {
        const qty = field === 'orderedQty' ? Number(value) : Number(next[idx].orderedQty)
        const price = field === 'unitPrice' ? Number(value) : Number(next[idx].unitPrice)
        line.subtotal = Math.round(qty * price * 100) / 100
      }
      if (field === 'unitPrice') {
        // 手动改价，原来的来源判断（价格表/牌价/最近成交）不再成立
        line.priceSourceType = null
        line.priceSourceDetail = null
        line.priceSourceDate = null
      }
      next[idx] = line
      return next
    })
  }

  async function handleSave() {
    if (!order) return
    try {
      // 误按 Enter 多出的空行（没选商品）直接丢弃，不提交也不再提示——客户反馈过这类空行会挡住保存
      const validLines = editLines.filter(l => l.productId)
      const newTotalAmount = Math.round(validLines.reduce((s, l) => s + Number(l.subtotal), 0) * 100) / 100
      // 草稿 id 只在前端存活；带着它提交，后端会拿不存在的 id 去 update（见 lib/order-line-draft.ts）
      const orderedLines = toSubmittableLines(validLines)
      const saved = await apiPut<{ pricingWarnings?: string[] }>(`/api/orders/${order.id}`, {
        internalNote, externalNote: externalNote || null, salesUserId: salesUserId || null,
        deliveryDate: deliveryDate ? new Date(deliveryDate).toISOString() : null,
        driverSlotId: driverSlotId || null,
        deliveryBatch: driverSlotId ? (() => { const s = driverSlots.find(x => x.id === driverSlotId); return s ? `${s.batchNum} ${s.timeOfDay} ${s.driverName}` : deliveryBatch })() : deliveryBatch,
        pricelistId: pricelistId || null,
        priceType,
        paymentTerm: paymentTerm || null,
        lines: orderedLines,
        totalAmount: newTotalAmount,
      })
      toast.success('Saved')
      // 见销售单详情页同处注释：接口一直返回 pricingWarnings，前端一直没读
      for (const w of saved?.pricingWarnings ?? []) {
        toast.warning(w, { duration: 10000 })
      }
      setEditing(false)
      setEditLines([])
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    }
  }

  async function handleConfirm() {
    if (!order || confirming) return
    setConfirming(true)
    try {
      await apiPut(`/api/orders/${order.id}`, { status: 'CONFIRMED' })
      toast.success('Quotation confirmed')
      router.push(`${prefix}/classic/operator/orders/${order.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Confirm failed')
      setConfirming(false)
    }
  }

  async function handleSend() {
    if (!order) return
    try {
      await apiPut(`/api/orders/${order.id}`, { sentAt: new Date().toISOString() })
      toast.success('Marked as sent')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    }
  }

  function handleCancel() {
    if (!order) return
    setCancelModalOpen(true)
  }

  async function handleConfirmCancel() {
    if (!order) return
    try {
      await apiPut(`/api/orders/${order.id}`, { status: 'CANCELLED' })
      toast.success(isEn ? 'Quotation cancelled' : '报价单已取消')
      router.push(`${prefix}/classic/operator/quotations`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Cancel failed' : '取消失败'))
    } finally {
      setCancelModalOpen(false)
    }
  }

  const productRefMap = useMemo(() => {
    const m = new Map<string, string>()
    allProducts.forEach(p => { if (p.internalRef) m.set(p.id, p.internalRef) })
    return m
  }, [allProducts])


  // ⚠️ 必须放在所有提前 return 之前。放在后面的话，order 未加载那次渲染不会调用它，
  // 加载完成后才调用 → hook 数量变化 → React error #310。typecheck 与 next build
  // 都查不出这类错误，只有真在浏览器打开才会崩。
  const { helpOverlay } = useHotkeys([
    {
      combo: 'mod+s', label: '保存', group: '编辑',
      when: () => editing,
      run: () => { void handleSave() },
      // 编辑时焦点几乎总在某个输入框里，不放行就等于这条快捷键不存在
      allowInInput: true,
    },
    {
      combo: 'alt+n', label: '新增一行（聚焦商品搜索）', group: '编辑',
      when: () => editing,
      run: () => focusLineSearchRef.current?.(),
      allowInInput: true,
    },
    {
      combo: 'mod+enter', label: '确认报价单', group: '流转',
      // 与 Confirm 按钮的 disabled 保持同一套条件，避免按钮灰着但快捷键还能按下去
      when: () => isQuotation && !editing && !confirming && !creditBlocked,
      run: () => { void handleConfirm() },
      allowInInput: true,
    },
    {
      combo: 'mod+p', label: '打印', group: '流转',
      when: () => !!order,
      run: () => window.open(`${prefix}/classic/print/${order!.id}`, '_blank', 'noopener,noreferrer'),
      allowInInput: true,
    },
  ])

  if (loading) return <div className="text-center py-20 text-gray-400">Loading…</div>
  if (!order) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-400 mb-4">Quotation not found</p>
        <button onClick={() => router.push(`${prefix}/classic/operator/quotations`)}
          className="px-4 py-2 border border-gray-300 rounded text-sm">Back to Quotations</button>
      </div>
    )
  }

  const statusUp = order.status.toUpperCase()
  const isQuotation = statusUp === 'PENDING'
  const canOverrideCredit = session?.roles?.includes('BOSS') || session?.roles?.includes('FINANCE') || session?.role === 'BOSS' || session?.role === 'FINANCE'
  const creditBlocked = creditInfo?.canOrder === false && !canOverrideCredit
  const isSalesOrder = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED'].includes(statusUp)
  const isLocked = statusUp === 'LOCKED' || statusUp === 'CANCELLED'
  const balance = customer ? Number((customer as unknown as { balance?: number }).balance ?? 0) : 0
  const lines = order.lines ?? []
  const displayLines = editing ? editLines : lines
  // 缺货提醒(20260729)：pending-demand 是全库存量按 PENDING/CONFIRMED/WAVE_ASSIGNED 全部订单聚合的，
  // 本单自己也在这些状态里，若不减掉会把"这单自己占的量"算成"跟自己抢库存"，出现假缺货
  const ownDemandMap = new Map<string, number>()
  for (const l of lines) if (l.productId) ownDemandMap.set(l.productId, (ownDemandMap.get(l.productId) ?? 0) + Number(l.orderedQty))
  const atpDemand = (productId: string) => Math.max(0, (pendingDemand[productId] ?? 0) - (ownDemandMap.get(productId) ?? 0))
  const subtotalExTax = displayLines.reduce((s, l) => s + Number(l.subtotal), 0)
  const displayTotal = editing
    ? displayLines.reduce((s, l) => s + Number(l.subtotal), 0)
    : Number(order.totalAmount)

  async function selectProductIntoLine(lineId: string, p: AllProduct) {
    ensureSaleUomOptions(p.id)
    ensureForecast(p.id)
    // priceType='default' 的定价链从不查最近成交价，跳过这次查询
    let lastPriceHit: { price: number; date: string } | undefined
    if (customer && priceType !== 'default') {
      try {
        const res = await apiGet<{ price: number | null; createdAt?: string }>(
          `/api/orders/last-price?customerId=${customer.id}&productId=${p.id}`
        )
        if (res.price != null && res.price > 0) {
          lastPriceHit = { price: res.price, date: res.createdAt ?? '' }
        }
      } catch { /* 查询失败不阻塞加行，回退到价格表/牌价 */ }
    }
    const resolution = effectiveCustomer
      ? resolveCustomerPrice(p as never, effectiveCustomer, pricelists, 1, lastPriceHit?.price)
      : null
    const price = resolution ? resolution.price : Number(p.listPrice ?? 0)
    const newLine = {
      id: lineId,
      orderId: order!.id,
      productId: p.id,
      productName: p.name,
      spec: lineDescription(p),
      note: '',
      uomId: p.uomId ?? null,
      uomName: p.uomName ?? 'Unit(s)',
      unitPrice: price,
      orderedQty: 1,
      deliveredQty: 0,
      invoicedQty: 0,
      subtotal: Math.round(price * 100) / 100,
      taxRate: Number(p.customerTaxRate ?? 0) * 100,
      sequence: editLines.length,
      cost: Number(p.standardPrice ?? 0),
      priceSourceType: resolution ? resolution.sourceType.toUpperCase() : null,
      priceSourceDetail: resolution?.sourceType === 'pricelist' ? resolution.pricelistName : null,
      priceSourceDate: resolution?.sourceType === 'last' ? (lastPriceHit?.date ?? null) : null,
    } as unknown as EditLine
    // 填充的是「已经插好的那一行」，不是往末尾追加 —— 行是点 + Add a product 时就建好的
    setEditLines(prev => prev.map(l => (l.id === lineId ? { ...newLine, id: lineId } : l)))
  }

  /**
   * 点「+ Add a product」：插一个空的草稿行并让它进入搜索态。
   * 与新建页同一个交互模型（见 lib/order-line-draft.ts 说明为什么要草稿 id）。
   */
  function addBlankLine(opts?: { force?: boolean }) {
    // force 只给「Enter 连续录入」用：那一刻 setEditLines 还没落地，
    // 闭包里的末行仍是刚填好的那个草稿行，走守卫会把它再激活一次而不是开新行。
    const last = editLines[editLines.length - 1]
    // 末行还没选商品就别再插 —— 直接把它激活，免得连点攒出一串空行
    if (!opts?.force && last && !last.productId) {
      activatePickerRef.current(last.id)
      return
    }
    const draftId = newDraftLineId()
    setEditLines(prev => [...prev, {
      id: draftId,
      orderId: order!.id,
      productId: '', productName: '', spec: '', note: '',
      uomId: null, uomName: 'Unit(s)',
      unitPrice: 0, orderedQty: 1, deliveredQty: 0, invoicedQty: 0,
      subtotal: 0, taxRate: 0, sequence: prev.length, cost: 0,
      priceSourceType: null, priceSourceDetail: null, priceSourceDate: null,
    } as unknown as EditLine])
    activatePickerRef.current(draftId)
  }
  // 合并重复商品：同一 productId 的行合并为一行，数量相加（与 place-order 创建页一致）
  function mergeDuplicateLines() {
    setEditLines(prev => {
      const seen = new Map<string, EditLine>()
      const result: EditLine[] = []
      for (const l of prev) {
        if (!l.productId) { result.push(l); continue }
        const existing = seen.get(l.productId)
        if (existing) {
          const qty = Number(existing.orderedQty) + Number(l.orderedQty)
          existing.orderedQty = qty
          existing.subtotal = Math.round(Number(existing.unitPrice) * qty * 100) / 100
        } else {
          const copy = { ...l }
          seen.set(l.productId, copy)
          result.push(copy)
        }
      }
      return result
    })
    toast.success(isEn ? 'Duplicate products merged' : '已合并重复商品')
  }
  const totalTax = displayLines.reduce((s, l) => s + Number(l.subtotal) * (Number(l.taxRate ?? 0) / 100), 0)
  const margin = displayLines.reduce((s, l) => {
    const cost = Number((l as unknown as { cost?: number }).cost ?? 0)
    return s + (Number(l.unitPrice) - cost) * Number(l.orderedQty)
  }, 0)
  function StatusPill({ label, active, dim }: { label: string; active?: boolean; dim?: boolean }) {
    return (
      <span className={`px-3 py-1 text-xs rounded-full ${active ? 'text-white font-medium' : dim ? 'text-gray-400' : 'text-gray-600'}`}
        style={active ? { background: PURPLE } : undefined}>{label}</span>
    )
  }


  return (
    <div className="min-h-screen" style={{ background: '#f5f5f5' }}>
      {/* Region 1: Breadcrumb + action bar */}
      <div className="bg-white border-b border-gray-200 px-6 pt-3 pb-2">
        <div className="text-sm">
          <button onClick={() => router.push(`${prefix}/classic/operator/quotations`)}
            className="hover:underline" style={{ color: PURPLE }}>Quotations</button>
          <span className="text-gray-400 mx-1">/</span>
          <span className="text-gray-700">{displayOrderCode(order)}</span>
        </div>
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2">
            {!editing ? (
              <button onClick={() => {
                setEditLines(lines.map(l => {
                  const qty = Number(l.orderedQty)
                  const price = Number(l.unitPrice)
                  return {
                    ...l,
                    subtotal: Math.round(qty * price * 100) / 100,
                  }
                }))
                Array.from(new Set(lines.map(l => l.productId).filter(Boolean))).forEach(pid => ensureSaleUomOptions(pid))
                setEditing(true)
              }} disabled={isLocked}
                className="h-8 px-4 text-sm rounded text-white font-medium disabled:opacity-50"
                style={{ background: PURPLE }}>Edit</button>
            ) : (
              <>
                <button onClick={handleSave}
                  className="h-8 px-4 text-sm rounded text-white font-medium"
                  style={{ background: PURPLE }}>Save</button>
                <button onClick={() => { setEditing(false); setEditLines([]); load() }}
                  className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">Discard</button>
              </>
            )}
            <button onClick={() => router.push(`${prefix}/classic/operator/place-order`)}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">Create</button>
            <div className="h-5 w-px bg-gray-200 mx-1" />
            <button
              onClick={() => window.open(`${prefix}/classic/print/${order.id}`, '_blank', 'noopener,noreferrer')}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
              Print
            </button>
            <button
              onClick={() => setSendEmailOpen(true)}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
              {isEn ? 'Send Email' : '发送邮件'}
            </button>
            {isQuotation && (
              <>
                <button onClick={handleConfirm} disabled={confirming || creditBlocked}
                  className="h-8 px-3 text-sm rounded border border-gray-300 bg-white disabled:opacity-50"
                  style={{ color: PURPLE }}>
                  {confirming ? 'Confirming…' : 'Confirm'}
                </button>
                {creditBlocked && (
                  <span className="px-2 py-1 text-xs rounded bg-red-100 text-red-700 font-medium border border-red-200">{isEn ? 'Credit Blocked' : '信用冻结'}</span>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-1 text-sm text-gray-500">
            <span>1 / 40</span>
            <button className="h-7 w-7 border border-gray-300 rounded ml-2">‹</button>
            <button className="h-7 w-7 border border-gray-300 rounded">›</button>
          </div>
        </div>

        {/* Region 2: secondary actions + status flow */}
        <div className="flex items-center justify-between mt-3">
          <div className="flex items-center gap-2">
            <button onClick={handleCancel} disabled={isLocked}
              className="h-8 px-3 text-sm rounded border border-red-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed">
              {isEn ? 'Cancel Quotation' : '取消报价单'}
            </button>
            <div className="w-px h-5 bg-gray-300 mx-1" />
            <button disabled={!isSalesOrder}
              onClick={() => router.push(`${prefix}/operator/orders/${order.id}#invoice`)}
              className="h-8 px-3 text-sm rounded text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: PURPLE }}>Create Invoice</button>
            <button
              onClick={() => window.open(`${prefix}/classic/print/${order?.id}?preview=1`, '_blank', 'noopener,noreferrer')}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">Preview</button>
            <button disabled={!isLocked}
              onClick={async () => {
                if (!order) return
                await apiPut(`/api/orders/${order.id}`, { status: 'COMPLETED', lockedAt: null })
                toast.success('Unlocked')
                await load()
              }}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed">Unlock</button>
          </div>
          <div className="flex items-center gap-1">
            <StatusPill label="Quotation" active={flowSegment === 'quotation'} dim={flowSegment !== 'quotation'} />
            <span className="text-gray-300">›</span>
            <StatusPill label="Sales Order" active={flowSegment === 'sale'} dim={flowSegment !== 'sale'} />
          </div>
        </div>
      </div>

      {/* Region 3: Main info card */}
      <div className="px-6 py-4">
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
          <div className="flex items-start justify-between">
            <h1 className="text-3xl font-bold text-gray-800">{displayOrderCode(order)}</h1>
            <div className="flex items-center gap-2 px-3 py-2 rounded bg-gray-100">
              <span className="text-xl">🚚</span>
              <div className="text-xs">
                <div className="font-bold text-gray-800">{deliveryBatch ? 1 : 0}</div>
                <div className="text-gray-500">Delivery</div>
              </div>
            </div>
          </div>

          {editing && (
            <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-sm">
              <span>✏️</span>
              <span className="font-medium">Editing</span>
              <span className="text-amber-500 text-xs">— highlighted fields below are editable</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-12 mt-6">
            {/* Left col */}
            <div className="space-y-3 text-sm">
              <div className="flex">
                <div className="w-32 font-bold text-gray-700">Customer</div>
                <div className="flex-1">
                  <div style={{ color: PURPLE }} className="font-medium">{order.restaurantName}</div>
                  {customer?.address && <div className="text-xs text-gray-500">{customer.address}</div>}
                </div>
              </div>
              <div className="flex">
                <div className="w-32 font-bold text-gray-700">Balance</div>
                <div className={balance < 0 ? 'text-red-600' : 'text-gray-800'}>€ {balance.toFixed(2)}</div>
              </div>
              {creditInfo && (
                <div className={`flex flex-wrap gap-3 py-2 px-3 rounded-lg text-xs ${creditInfo.canOrder === false ? 'bg-red-50 border border-red-200' : 'bg-gray-50 border border-gray-200'}`}>
                  <div>
                    <span className="text-gray-500">{isEn ? 'Outstanding Balance' : '欠款余额'}</span>
                    <span className={`ml-1 font-medium ${creditInfo.outstandingBalance > 0 ? 'text-red-600' : 'text-gray-800'}`}>
                      € {creditInfo.outstandingBalance.toFixed(2)}
                    </span>
                  </div>
                  {creditInfo.creditLimit > 0 && (
                    <div>
                      <span className="text-gray-500">{isEn ? 'Credit Limit' : '信用额度'}</span>
                      <span className="ml-1 font-medium text-gray-800">€ {creditInfo.creditLimit.toFixed(2)}</span>
                    </div>
                  )}
                  {creditInfo.paymentTerm && (
                    <div>
                      <span className="text-gray-500">{isEn ? 'Payment Terms' : '付款条件'}</span>
                      <span className="ml-1 font-medium text-gray-800">{creditInfo.paymentTerm}</span>
                    </div>
                  )}
                  {creditInfo.canOrder === false && (
                    <div className="w-full flex items-center gap-1 text-red-700 font-medium">
                      <span>⚠️</span>
                      <span>{creditInfo.blockReason || (isEn ? 'Credit blocked, cannot confirm' : '信用冻结，无法确认')}</span>
                      {canOverrideCredit && <span className="text-gray-500 font-normal">{isEn ? '(overridden with admin privilege)' : '(已用管理员权限覆盖)'}</span>}
                    </div>
                  )}
                </div>
              )}
              <div className={`rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="flex border-b border-gray-200 mb-1">
                  {(['internal', 'external'] as const).map(tab => (
                    <button key={tab} onClick={() => setNoteTab(tab)}
                      className={`px-3 py-1 text-xs font-medium border-b-2 transition-colors ${noteTab === tab ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                      {tab === 'internal' ? (isEn ? 'Internal Note' : '内部备注') : (isEn ? 'External Note' : '外部备注')}
                    </button>
                  ))}
                </div>
                {noteTab === 'internal' ? (
                  editing ? (
                    <textarea value={internalNote} onChange={e => setInternalNote(e.target.value)}
                      rows={3} maxLength={500}
                      className="w-full border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none resize-none"
                      placeholder={isEn ? 'Internal only, not printed for customer' : '仅内部可见，不会打印给客户'} />
                  ) : <div className="text-sm text-gray-700 whitespace-pre-wrap">{internalNote || '—'}</div>
                ) : (
                  editing ? (
                    <textarea value={externalNote} onChange={e => setExternalNote(e.target.value)}
                      rows={3} placeholder={isEn ? 'Printed on quotation and delivery note, visible to customer' : '会打印在报价单和送货单上，客户可见'}
                      className="w-full border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none resize-none" />
                  ) : <div className="text-sm text-gray-700 whitespace-pre-wrap">{externalNote || '—'}</div>
                )}
              </div>
            </div>

            {/* Right col */}
            <div className="space-y-3 text-sm">
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Delivery Date</div>
                {editing ? (
                  <input
                    type="date"
                    value={deliveryDate}
                    onChange={e => setDeliveryDate(e.target.value)}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300"
                  />
                ) : <div className="text-gray-800">{deliveryDate || '—'}</div>}
              </div>
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Driver</div>
                {editing ? (
                  <select value={driverSlotId} onChange={e => { setDriverSlotId(e.target.value); const s = driverSlots.find(x => x.id === e.target.value); setDeliveryBatch(s ? `${s.batchNum} ${s.timeOfDay} ${s.driverName}` : '') }}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300">
                    <option value="">— unassigned —</option>
                    {driverSlots.map(s => <option key={s.id} value={s.id}>{s.batchNum} {s.timeOfDay} {s.driverName}</option>)}
                  </select>
                ) : <div style={{ color: PURPLE }}>{formatDriverSlotFromOrder(order) || '—'}</div>}
              </div>
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Pricelist</div>
                {editing ? (
                  <select value={pricelistId} onChange={e => setPricelistId(e.target.value)}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300">
                    <option value="">— none —</option>
                    {pricelists.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                ) : <div style={{ color: PURPLE }}>{pricelist?.name || '—'}</div>}
              </div>
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Payment Terms</div>
                {editing ? (
                  <input type="text" value={paymentTerm} onChange={e => setPaymentTerm(e.target.value)}
                    placeholder={customer?.paymentTerm ?? ''}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300" />
                ) : <div className="text-gray-800">{(order as unknown as { paymentTerm?: string })?.paymentTerm ?? customer?.paymentTerm ?? '—'}</div>}
              </div>
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Sales Person</div>
                {editing ? (
                  <select
                    value={salesUserId}
                    onChange={e => setSalesUserId(e.target.value)}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300"
                  >
                    <option value="">— none —</option>
                    {salesUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                ) : <div className="text-gray-800">{(order as unknown as { salesman?: string })?.salesman || '—'}</div>}
              </div>
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Price Type</div>
                {editing ? (
                  <select value={priceType} onChange={e => setPriceType(e.target.value)}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300">
                    <option value="multi">Multi-Pricelist</option>
                    <option value="default">Default Price</option>
                    <option value="last">Last Price</option>
                  </select>
                ) : <div className="text-gray-800">{
                  order.priceType === 'multi' ? 'Multi-Pricelist'
                  : order.priceType === 'last' ? 'Last Price'
                  : 'Default Price'
                }</div>}
              </div>
            </div>
          </div>
        </div>

        {/* Region 4: order lines */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
          <div className="border-b border-gray-200 flex">
            <div className="px-4 py-3 text-sm font-bold text-gray-900 border-b-2" style={{ borderColor: PURPLE }}>
              Order Lines
            </div>
          </div>

          {/* Region 5: order lines table */}
          <>
            {editing && (() => {
              const withAtp = editLines
                .filter(l => l.productId)
                .map(l => {
                  const fc = forecastMap.get(l.productId)
                  const atp = fc ? Number(fc.qtyOnHand) - atpDemand(l.productId) : null
                  return { ...l, atp }
                })
              const outOfStockLines = withAtp.filter(l => l.atp != null && l.atp <= 0)
              const lowStockLines = withAtp.filter(l => l.atp != null && l.atp > 0 && l.atp < LOW_STOCK_THRESHOLD)
              if (outOfStockLines.length === 0 && lowStockLines.length === 0) return null
              return (
                <div className="mx-3 mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2.5 flex items-start gap-3">
                  <span className="text-lg leading-none mt-0.5">🚨</span>
                  <div className="text-sm">
                    <span className="font-semibold text-red-700">{isEn ? 'Stock Warning (based on ATP): ' : '库存警告（基于可承诺量）：'}</span>
                    {outOfStockLines.length > 0 && (
                      <span className="text-red-600">
                        {isEn ? `${outOfStockLines.length} product(s) out of stock` : `${outOfStockLines.length} 个商品无可用库存`}
                        <span className="text-xs text-red-500 ml-1">
                          ({outOfStockLines.map(l => l.productName).join(isEn ? ', ' : '、')})
                        </span>
                      </span>
                    )}
                    {outOfStockLines.length > 0 && lowStockLines.length > 0 && (
                      <span className="text-gray-400 mx-1.5">|</span>
                    )}
                    {lowStockLines.length > 0 && (
                      <span className="text-amber-700">
                        {isEn ? `${lowStockLines.length} product(s) low stock` : `${lowStockLines.length} 个商品低库存`}
                        <span className="text-xs text-amber-600 ml-1">
                          ({lowStockLines.map(l => `${l.productName}(ATP: ${l.atp!.toFixed(1)})`).join(isEn ? ', ' : '、')})
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              )
            })()}
            {editing && (() => {
              const dups = [...duplicateCounts.entries()].filter(([, c]) => c > 1)
              if (dups.length === 0) return null
              const nameOf = (pid: string) => editLines.find(l => l.productId === pid)?.productName ?? pid
              return (
                <div className="mx-3 mt-3 rounded-md border border-purple-200 bg-purple-50 px-4 py-2.5 flex items-start gap-3">
                  <span className="text-lg leading-none mt-0.5">🔁</span>
                  <div className="text-sm flex-1">
                    <span className="font-semibold text-purple-700">{isEn ? 'Duplicate product alert: ' : '重复商品提醒：'}</span>
                    <span className="text-purple-600">
                      {isEn ? `${dups.length} product(s) added more than once` : `${dups.length} 个商品被重复添加`}
                      <span className="text-xs text-purple-500 ml-1">
                        ({dups.map(([pid, c]) => `${nameOf(pid)} ×${c}`).join(isEn ? ', ' : '、')})
                      </span>
                    </span>
                    <span className="text-xs text-gray-500 ml-1">{isEn ? '— click "Merge" on the right to combine into one line (quantities added), or leave as-is and adjust manually' : '— 可点右侧「合并」合并为一行（数量相加），或保留现状手动调整'}</span>
                  </div>
                  <button
                    onClick={mergeDuplicateLines}
                    className="shrink-0 px-3 py-1 rounded text-xs font-medium text-white"
                    style={{ background: PURPLE }}
                  >
                    {isEn ? 'Merge Duplicates' : '合并重复项'}
                  </button>
                </div>
              )
            })()}
            <OrderLineEditor
              lines={displayLines}
              editing={editing}
              onReorder={moveLine}
              onDeleteLine={(_lineId, i) => deleteLine(i)}
              products={allProducts}
              onPickProduct={selectProductIntoLine}
              onPickByEnter={() => addBlankLine({ force: true })}
              onAddBlankLine={editing ? addBlankLine : undefined}
              pickerTexts={{
                empty: isEn ? 'No matching products' : '没有匹配商品',
                placeholder: isEn ? 'Click to select product…' : '点击选择商品…',
                search: isEn ? 'Search product…' : '搜索商品…',
              }}
              onReady={handleEditorReady}
              emptyColSpan={16}
              rowStyle={(l) => {
                if (!editing || !l.productId) return undefined
                const fc = forecastMap.get(l.productId)
                if (!fc) return undefined
                const atp = Number(fc.qtyOnHand) - atpDemand(l.productId)
                if (atp <= 0) return { background: '#fee2e2' }
                if (atp < LOW_STOCK_THRESHOLD) return { background: '#fffbeb' }
                return undefined
              }}
              renderHeaders={() => (
                <tr className="border-b border-gray-200 text-xs font-bold text-gray-700 align-bottom">
                  <th className="px-2 py-3 w-6"></th>
                  <th className="px-2 py-3 text-left">NO</th>
                  <th className="px-2 py-3 text-left"><div className="leading-tight">Internal<br/>Reference</div></th>
                  <th className="px-2 py-3 text-left">Product</th>
                  <th className="px-2 py-3 text-left">Description</th>
                  <th className="px-2 py-3 text-right"><div className="leading-tight">Ordered<br/>Qty</div></th>
                  <th className="px-2 py-3 text-left"><div className="leading-tight">Unit of<br/>Measure</div></th>
                  <th className="px-2 py-3 text-right"><div className="leading-tight">Unit<br/>Price</div></th>
                  <th className="px-2 py-3 text-right">Cost</th>
                  <th className="px-2 py-3 text-center">Price</th>
                  <th className="px-2 py-3 text-center">Taxes</th>
                  <th className="px-2 py-3 text-right">Total</th>
                  <th className="px-2 py-3 text-right"><div className="leading-tight">Forecast<br/>Quantity</div></th>
                  <th className="px-2 py-3 text-right"><div className="leading-tight">Quantity<br/>On Hand</div></th>
                  <th className="px-2 py-3 text-right"><div className="leading-tight">Delivered<br/>Quantity</div></th>
                  <th className="px-2 py-3 text-right"><div className="leading-tight">Invoiced<br/>Quantity</div></th>
                </tr>
              )}
              renderRow={(l, i, { inputCls, dragHandle, deleteButton, focusSearch, firstFieldRef, productCell }) => {
                const fc = forecastMap.get(l.productId)
                const cost = Number((l as unknown as { cost?: number }).cost ?? 0)
                const taxPct = l.taxRate != null && Number(l.taxRate) > 0 ? Number(l.taxRate).toFixed(1) + '%' : '0%'
                const isDuplicate = !!l.productId && (duplicateCounts.get(l.productId) ?? 0) > 1
                const atp = editing && fc ? Number(fc.qtyOnHand) - atpDemand(l.productId) : null
                const isOutOfStock = atp != null && atp <= 0
                const isLowStock = atp != null && atp > 0 && atp < LOW_STOCK_THRESHOLD
                return (
                  <>
                    <td className="px-2 py-2">
                      {editing ? (
                        <div className="flex items-center gap-1.5">
                          {dragHandle}
                          {deleteButton}
                        </div>
                      ) : <span className="text-gray-300 select-none" title={isEn ? 'Enable editing to drag and reorder' : '编辑后可拖动调整顺序'}>☰</span>}
                    </td>
                    <td className="px-2 py-2 text-gray-700">
                      {i + 1}
                      {isDuplicate && <span className="ml-1 text-[10px] text-purple-600" title={isEn ? 'Duplicate product' : '重复商品'}>🔁</span>}
                      {isOutOfStock && <span className="ml-1 text-[10px] text-red-600" title={isEn ? 'Out of stock' : '无可用库存'}>🚨</span>}
                      {!isOutOfStock && isLowStock && <span className="ml-1 text-[10px] text-amber-600" title={isEn ? 'Low stock' : '低库存'}>⚠️</span>}
                    </td>
                    <td className="px-2 py-2 text-gray-500 text-xs">{(l as unknown as { internalRef?: string }).internalRef || productRefMap.get(l.productId) || ''}</td>
                    <td className="px-2 py-2" style={{ color: PURPLE }}>
                      {editing
                        ? productCell({
                            lineId: l.id,
                            productName: l.productName,
                            // 已落库的行只读：换 productId 会牵动价格快照、提成快照、
                            // 拣货锁与库存流水，不该由点一下单元格触发
                            readOnly: !isDraftLineId(l.id),
                          })
                        : l.productName}
                    </td>
                    <td className="px-2 py-2 text-gray-600 text-xs">
                      {editing ? (
                        <input
                          type="text"
                          /* Tab 选完商品后焦点落到这里 —— useInlineProductPicker 靠 data-desc-line 定位 */
                          data-desc-line={l.id}
                          className="border border-amber-400 rounded px-1 py-0.5 text-xs bg-amber-50 focus:outline-none focus:ring-1 focus:ring-amber-300 w-24"
                          value={l.spec ?? ''}
                          onChange={e => updateLine(i, 'spec', e.target.value)}
                          onKeyDown={lineFieldKeyHandler({ onNextRow: focusSearch })}
                        />
                      ) : (l.spec || '')}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {editing ? (
                        <input type="number" step="0.001" min="0" className={inputCls}
                          ref={firstFieldRef as React.Ref<HTMLInputElement>}
                          value={Number(l.orderedQty)}
                          onChange={e => updateLine(i, 'orderedQty', Number(e.target.value))}
                          onFocus={e => e.target.select()}
                          onKeyDown={lineFieldKeyHandler({ onNextRow: focusSearch })} />
                      ) : Number(l.orderedQty).toFixed(2)}
                    </td>
                    <td className="px-2 py-2 text-gray-600">
                      {editing && l.productId && (saleUomOptions[l.productId]?.length ?? 0) > 0 ? (
                        (() => {
                          const p = allProducts.find(pp => pp.id === l.productId)
                          const anchorUomId = p?.uomId
                          return (
                            <select
                              value={l.uomId ?? anchorUomId ?? ''}
                              onChange={e => switchLineUnit(i, e.target.value)}
                              onKeyDown={lineFieldKeyHandler({ onNextRow: focusSearch })}
                              className="w-full text-xs border border-amber-400 rounded px-1 py-0.5 bg-amber-50 focus:outline-none focus:ring-1 focus:ring-amber-300"
                            >
                              {anchorUomId && <option value={anchorUomId}>{p?.uomName ?? 'Unit(s)'}</option>}
                              {/* ⛔ 排除锚点，否则默认单位在下拉里出现两次（见 place-order 同处注释） */}
                              {(saleUomOptions[l.productId] ?? [])
                                .filter(o => o.uomId !== anchorUomId)
                                .map(o => (
                                  <option key={o.uomId} value={o.uomId}>{o.uomName}</option>
                                ))}
                            </select>
                          )
                        })()
                      ) : (l.uomName ?? 'Unit(s)')}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {editing ? (
                        <input type="number" step="0.01" min="0" className={inputCls}
                          value={Number(l.unitPrice)}
                          onChange={e => updateLine(i, 'unitPrice', Number(e.target.value))}
                          onFocus={e => e.target.select()}
                          onKeyDown={lineFieldKeyHandler({ onNextRow: focusSearch })} />
                      ) : Number(l.unitPrice).toFixed(2)}
                    </td>
                    <td className="px-2 py-2 text-right text-gray-400">{cost.toFixed(2)}</td>
                    <td className="px-2 py-2 text-center">
                      {(() => {
                        const badge = formatPriceSourceBadge(l as unknown as { priceSourceType?: string | null; priceSourceDetail?: string | null; priceSourceDate?: string | null }, isEn)
                        return (
                          <>
                            <span
                              title={badge.title}
                              className={`inline-block px-2 py-0.5 border rounded text-xs cursor-help ${badge.className}`}
                            >
                              {badge.label}
                            </span>
                            <SalesPriceHistoryButton
                              customerId={customer?.id}
                              productId={l.productId}
                              productName={l.productName}
                              onSelectPrice={editing ? (price) => updateLine(i, 'unitPrice', price) : undefined}
                            />
                          </>
                        )
                      })()}
                    </td>
                    <td className="px-2 py-2 text-center">
                      {editing ? (
                        <select className="w-16 text-right border border-amber-400 rounded px-1 py-0.5 text-xs bg-amber-50 focus:outline-none focus:ring-1 focus:ring-amber-300"
                          value={Number(l.taxRate ?? 0)}
                          onChange={e => updateLine(i, 'taxRate', Number(e.target.value))}
                          onKeyDown={lineFieldKeyHandler({
                            onNextRow: focusSearch,
                            // 税率是本行最后一个可编辑字段。只有最后一行才拦 Tab：
                            // 中间行原生 Tab 本来就走到下一行，拦了反而打断"顺着多行往下改"
                            isLastFieldOfLastRow: i === displayLines.length - 1,
                          })}>
                          <option value={0}>0%</option>
                          <option value={13.5}>13.5%</option>
                          <option value={23}>23%</option>
                        </select>
                      ) : <span className="px-1.5 py-0.5 bg-gray-100 rounded text-xs text-gray-600">{taxPct}</span>}
                    </td>
                    <td className="px-2 py-2 text-right font-bold" style={{ color: PURPLE }}>€ {Number(l.subtotal).toFixed(2)}</td>
                    <td className="px-2 py-2 text-right text-emerald-700">{fc ? Number(fc.forecast).toFixed(2) : '—'}</td>
                    <td className="px-2 py-2 text-right">{fc ? Number(fc.qtyOnHand).toFixed(2) : '—'}</td>
                    <td className="px-2 py-2 text-right text-blue-700">{Number(l.deliveredQty).toFixed(2)}</td>
                    <td className="px-2 py-2 text-right text-purple-700">{Number(l.invoicedQty).toFixed(2)}</td>
                  </>
                )
              }}
            />
          </>

          {/* Region 6: totals */}
          <div className="border-t border-gray-200 px-6 py-4 flex items-start justify-end bg-gray-50">
            <div className="text-sm text-right space-y-1 min-w-[260px]">
              <div className="flex justify-between"><span className="text-gray-600">Untaxed Amount:</span><span className="text-gray-800">€ {subtotalExTax.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-gray-600">Taxes:</span><span className="text-gray-800">€ {totalTax.toFixed(2)}</span></div>
              <div className="border-t border-gray-200 my-1" />
              <div className="flex justify-between text-base"><span className="font-bold text-gray-700">Total:</span><span className="font-bold text-gray-900">€ {(subtotalExTax + totalTax).toFixed(2)}</span></div>
              <div className="flex justify-between text-xs"><span className="text-gray-500">Margin:</span><span className="text-gray-500">€ {margin.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-gray-600">Amount Due:</span><span className="text-gray-800">{(subtotalExTax + totalTax).toFixed(2)}</span></div>
            </div>
          </div>
        </div>

        {/* Region 7: Chatter */}
        <OrderChatter orderId={order.id} status={order.status} />
      </div>

      {cancelModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-bold text-gray-900 mb-2">{isEn ? 'Cancel this quotation?' : '确认取消此报价单？'}</h3>
            <p className="text-sm text-gray-600 mb-6">
              {isEn
                ? 'The order status will change to "Cancelled" and remain visible in the list, but cannot be restored to a quotation.'
                : '取消后订单状态将变为「已取消」，可在列表中查看，但无法恢复为报价中。'}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setCancelModalOpen(false)}
                className="h-9 px-4 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
                {isEn ? 'Dismiss' : '取消操作'}
              </button>
              <button
                onClick={handleConfirmCancel}
                className="h-9 px-4 text-sm rounded bg-red-600 text-white hover:bg-red-700 font-medium">
                {isEn ? 'Confirm Cancel' : '确认取消'}
              </button>
            </div>
          </div>
        </div>
      )}

      <SendEmailDialog
        orderId={order.id}
        orderCode={displayOrderCode(order)}
        open={sendEmailOpen}
        onOpenChange={setSendEmailOpen}
      />
      {helpOverlay}
    </div>
  )
}
