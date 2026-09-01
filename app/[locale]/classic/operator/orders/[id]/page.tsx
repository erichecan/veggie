'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'
import OrderLineEditor from '@/components/classic/OrderLineEditor'
import { formatDriverSlotFromOrder, type DriverSlotInfo } from '@/lib/driver-slot'
import type { Order, Customer, OdooPricelist as Pricelist, CustomerPriceType } from '@/lib/types'
import { displayOrderCode } from '@/lib/order-code'
import SendEmailDialog from '@/components/orders/send-email-dialog'
import { OrderChatter } from '@/components/order/OrderChatter'
import { resolveCustomerPrice } from '@/lib/pricing-engine'
import { formatPriceSourceBadge } from '@/lib/price-source'
import { lineFieldKeyHandler } from '@/lib/order-line-keys'
import { priceOf, factorOf, UNSET_UOM_LABEL } from '@/lib/sale-uom'
import type { SaleUomPriceMode } from '@/lib/sale-uom'
import { SalesPriceHistoryButton } from '@/components/classic/SalesPriceHistoryModal'
import { useHotkeys } from '@/components/shared/use-hotkeys'
import { lineDescription } from '@/lib/order-line-description'
import { newDraftLineId, isDraftLineId, toSubmittableLines } from '@/lib/order-line-draft'

const PURPLE = '#875A7B'

type SaleUomOption = {
  uomId: string; uomName: string; isDefault?: boolean; factor: number; priceOverride: number | null
  priceMode: SaleUomPriceMode; priceDiscountPct: number; priceSurcharge: number
}

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

interface ForecastRow { productId: string; forecast: number; qtyOnHand: number }

const STATUS_LABEL_ZH: Record<string, string> = {
  PENDING: '待处理',
  CONFIRMED: '已确认',
  WAVE_ASSIGNED: '已生成拣货单',
  IN_DELIVERY: '配送中',
  COMPLETED: '已完成',
  LOCKED: '已锁定',
  CANCELLED: '已取消',
}

const STATUS_LABEL_EN: Record<string, string> = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  WAVE_ASSIGNED: 'Picking List Generated',
  IN_DELIVERY: 'In Delivery',
  COMPLETED: 'Completed',
  LOCKED: 'Locked',
  CANCELLED: 'Cancelled',
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: 'bg-yellow-50 text-yellow-700',
  CONFIRMED: 'bg-blue-50 text-blue-700',
  WAVE_ASSIGNED: 'bg-indigo-50 text-indigo-700',
  IN_DELIVERY: 'bg-purple-50 text-purple-700',
  COMPLETED: 'bg-green-50 text-green-700',
  LOCKED: 'bg-gray-200 text-gray-700',
  CANCELLED: 'bg-red-50 text-red-600',
}

export default function SalesOrderDetailPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale
  const STATUS_LABEL = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH
  const params = useParams<{ id: string }>()
  const id = params.id

  const [order, setOrder] = useState<Order | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [pricelist, setPricelist] = useState<Pricelist | null>(null)
  const [pricelists, setPricelists] = useState<Pricelist[]>([])
  const [forecastMap, setForecastMap] = useState<Map<string, ForecastRow>>(new Map())
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  // 同报价单页：OrderLineEditor 的商品搜索框 ref 是私有的，靠 onReady 递出来
  const focusLineSearchRef = useRef<(() => void) | null>(null)
  // 插完空行要让那一行立刻进搜索态 —— 与新建页同一套交互
  const activatePickerRef = useRef<(lineId: string) => void>(() => {})
  const handleEditorReady = useCallback(
    (api: { focusSearch: () => void; activateProductPicker: (lineId: string) => void }) => {
      focusLineSearchRef.current = api.focusSearch
      activatePickerRef.current = api.activateProductPicker
    }, [])
  const [printing, setPrinting] = useState(false)
  const [printingDelivery, setPrintingDelivery] = useState(false)
  const [sendEmailOpen, setSendEmailOpen] = useState(false)
  const [internalNote, setInternalNote] = useState('')
  const [externalNote, setExternalNote] = useState('')
  const [deliveryNote, setDeliveryNote] = useState('')
  const [showDeliveryNoteModal, setShowDeliveryNoteModal] = useState(false)
  const [savingDeliveryNote, setSavingDeliveryNote] = useState(false)
  const [noteTab, setNoteTab] = useState<'internal' | 'external'>('internal')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [salesUserId, setSalesUserId] = useState('')
  const [salesUsers, setSalesUsers] = useState<{ id: string; name: string }[]>([])
  useEffect(() => { apiGet<{ id: string; name: string }[]>('/api/users?role=SALES').then(setSalesUsers).catch(() => {}) }, [])
  const [deliveryBatch, setDeliveryBatch] = useState('')
  const [driverSlotId, setDriverSlotId] = useState('')
  const [pricelistId, setPricelistId] = useState('')
  const [priceType, setPriceType] = useState('multi')
  const [paymentTerm, setPaymentTerm] = useState('')
  const [driverSlots, setDriverSlots] = useState<DriverSlotInfo[]>([])

  useEffect(() => {
    apiGet<DriverSlotInfo[]>('/api/driver-slots').then(d => setDriverSlots(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  /** 懒加载某商品配置的可售单位；已加载过就跳过 */
  function ensureSaleUomOptions(productId: string) {
    if (!productId || productId in saleUomOptions) return
    setSaleUomOptions(prev => ({ ...prev, [productId]: [] })) // 占位，避免并发重复请求
    apiGet<Array<{ uomId: string; isDefault: boolean; factor: number | string | null; priceOverride: number | null; active: boolean; priceMode?: SaleUomPriceMode; priceDiscountPct?: number | string | null; priceSurcharge?: number | string | null; uom: { name: string; nameZh?: string | null } }>>(
      `/api/products/${productId}/sale-uoms`,
    )
      .then(rows => {
        const opts = rows.filter(r => r.active).map(r => ({
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

  /**
   * 切换某行的下单单位：按该商品自己的换算系数（或独立售价）重算单价。
   * 不重新触发定价引擎 —— 与本页「改数量/改单价不重算」的既有行为一致，
   * 否则用户手改过的价会被悄悄冲掉。
   */
  function switchLineUnit(idx: number, newUomId: string) {
    setEditLines(prev => {
      const line = prev[idx]
      if (!line || !line.productId) return prev
      const p = allProducts.find(pp => pp.id === line.productId)
      if (!p) return prev
      const anchorUomId = (p as { uomId?: string | null }).uomId ?? null
      const currentUomId = line.uomId ?? anchorUomId
      if (!currentUomId || newUomId === currentUomId) return prev
      const opts = saleUomOptions[p.id] ?? []
      const rows = opts.map(o => ({
        uomId: o.uomId, isDefault: !!o.isDefault, factor: o.factor, priceOverride: o.priceOverride,
        priceMode: o.priceMode, priceDiscountPct: o.priceDiscountPct, priceSurcharge: o.priceSurcharge,
      }))
      const nameOf = (uid: string) => uid === anchorUomId
        ? ((p as { uomName?: string }).uomName ?? UNSET_UOM_LABEL)
        : (opts.find(o => o.uomId === uid)?.uomName ?? line.uomName)
      // 单位限定价格表规则（决策#6）优先：命中就直接用规则算出的最终价，不走"从旧价倒推基础价"
      // 那套 factor 换算——否则用户手改过的价没关系，但如果价格表已经给这个单位单独定过价，
      // 换单位就该按那条规则来，而不是继续沿用旧单位的价格比例。
      const uomScoped = effectiveCustomer
        ? resolveCustomerPrice(p as never, effectiveCustomer, pricelists, Number(line.orderedQty) || 1, undefined, newUomId)
        : null
      const oldFactor = factorOf(rows, currentUomId)
      const basePrice = oldFactor ? Number(line.unitPrice) / oldFactor : Number(line.unitPrice)
      const uomMatched = uomScoped?.matchedUomId === newUomId
      const newUnitPrice = uomMatched ? uomScoped.price : priceOf(rows, newUomId, basePrice)
      const qty = Number(line.orderedQty)
      // Cost 也要跟着单位换算，不然切到非默认单位后 Cost 列还停在换单位前那个分母上，
      // 和已经按新单位算好的 unitPrice 对不上（客户 20260827 反馈价格低于成本，实为显示误导）。
      const newCost = Math.round(Number(p.standardPrice ?? 0) * factorOf(rows, newUomId) * 100) / 100
      const next = [...prev]
      next[idx] = {
        ...line,
        uomId: newUomId,
        uomName: nameOf(newUomId),
        unitPrice: newUnitPrice,
        cost: newCost,
        subtotal: Math.round(qty * newUnitPrice * 100) / 100,
        // 换单位换算出的新价要如实标来源，不能留着换单位前那份旧标签——
        // 之前这里完全不碰这三个字段，导致价格已经变了，来源徽章还显示旧单位的那条
        // pricelist 规则描述，看着像是新价格也来自那条规则，其实对不上。
        priceSourceType: uomMatched ? 'PRICELIST' : 'DEFAULT',
        priceSourceDetail: uomMatched ? (uomScoped.pricelistName ?? null) : null,
        priceSourceDate: null,
      }
      return next
    })
  }

  type EditLine = NonNullable<Order['lines']>[number]
  const [editLines, setEditLines] = useState<EditLine[]>([])
  // 重复商品检测：同一 productId **且同一可售单位** 在编辑缓冲区中出现多次才算重复
  // （与 place-order 创建页一致）——同商品配两个不同单位（比如 2×CASE + 5×1KG）是合法的
  // 两行，不该被当成重复，之前只按 productId 判重会把这种正常用法也误报成"重复商品"
  const dupKey = (l: EditLine) => `${l.productId}__${l.uomId ?? ''}`
  const duplicateCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const l of editLines) if (l.productId) counts.set(dupKey(l), (counts.get(dupKey(l)) ?? 0) + 1)
    return counts
  }, [editLines])
  const [allProducts, setAllProducts] = useState<AllProduct[]>([])
  /**
   * 多规格：商品 → 可售单位（含商品级换算系数）。
   *
   * ⛔ 这一块此前**只有下单页与报价单编辑页有**，销售单编辑页的 UoM 列是纯文本。
   * 后果是：报价阶段选好的规格，一旦转成销售单就再也改不了，
   * 在这里新加的行也只能用基础单位 —— 客户要改只能把单撤回报价单状态。
   * 20260819 补齐，三个订单页至此口径一致。
   */
  const [saleUomOptions, setSaleUomOptions] = useState<Record<string, SaleUomOption[]>>({})

  // 本单覆盖：编辑页可临时切换 pricelist/priceType（不写回客户档案），
  // 加行询价必须用叠加后的客户对象，否则永远只按客户档案默认链定价（与 place-order 创建页一致）
  const effectiveCustomer = useMemo(() => customer
    ? { ...customer, priceType: priceType as CustomerPriceType, pricelists: pricelistId ? [{ pricelistId, sequence: 1 }] : customer.pricelists }
    : null,
  [customer, priceType, pricelistId])

  // P1-5: audit log

  async function load() {
    setLoading(true)
    try {
      const ord = await apiGet<Order>(`/api/orders/${id}`)
      setOrder(ord)
      setInternalNote(ord.internalNote ?? '')
      setExternalNote((ord as unknown as { externalNote?: string }).externalNote ?? '')
      setDeliveryNote((ord as unknown as { deliveryNote?: string }).deliveryNote ?? '')
      setDeliveryDate(ord.deliveryDate ? new Date(ord.deliveryDate).toISOString().slice(0, 10) : '')
      setSalesUserId((ord as unknown as { salesUserId?: string }).salesUserId ?? '')
      setDeliveryBatch(ord.deliveryBatch ?? '')
      // 编辑态司机预选与显示态同源:优先用所属 wave 派生的 currentDriverSlotId,回退下单意向列
      setDriverSlotId((ord as unknown as { currentDriverSlotId?: string; driverSlotId?: string }).currentDriverSlotId
        ?? (ord as unknown as { driverSlotId?: string }).driverSlotId ?? '')
      setPricelistId(ord.pricelistId ?? '')
      setPriceType((ord as unknown as { priceType?: string }).priceType ?? 'multi')
      setPaymentTerm((ord as unknown as { paymentTerm?: string }).paymentTerm ?? '')

      // 首屏只依赖订单本身:拿到订单即渲染,客户/价格表异步补(不再为一条订单 await 全量客户表)
      if (ord.restaurantId) {
        apiGet<Customer>(`/api/customers/${ord.restaurantId}`).then(setCustomer).catch(() => {})
      }
      apiGet<Pricelist[]>('/api/pricelists')
        .then(pls => {
          setPricelists(pls)
          if (ord.pricelistId) setPricelist(pls.find(p => p.id === ord.pricelistId) ?? null)
        }).catch(() => {})

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
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  useEffect(() => {
    apiGet<AllProduct[]>('/api/products?sellable=1&slim=1').then(p => setAllProducts(Array.isArray(p) ? p : [])).catch(() => {})
  }, [])

  function fetchLatestProducts() {
    return apiGet<AllProduct[]>('/api/products?sellable=1&slim=1')
      .then(p => setAllProducts(Array.isArray(p) ? p : []))
      .catch(() => {})
  }

  // 商品管理侧改了 canBeSold 等字段后，希望回到这个已经打开的页面时能看到最新数据，
  // 但又不想引入 SWR/React Query —— 用「重新聚焦/切回本 tab 时刷新，节流 30s」这个轻量方案。
  useEffect(() => {
    let lastFetch = Date.now()
    function refetchProducts() {
      if (Date.now() - lastFetch < 30_000) return
      lastFetch = Date.now()
      fetchLatestProducts()
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

  function deleteLine(idx: number) {
    setEditLines(prev => prev.filter((_, i) => i !== idx))
  }

  function reorderLine(from: number, to: number) {
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
      const newTotalAmount = validLines.length > 0
        ? Math.round(validLines.reduce((s, l) => s + Number(l.subtotal), 0) * 100) / 100
        : undefined
      const slot = driverSlots.find(s => s.id === driverSlotId)
      const batchStr = slot ? `${slot.batchNum} ${slot.timeOfDay} ${slot.driverName}` : deliveryBatch
      const saved = await apiPut<{ pricingWarnings?: string[] }>(`/api/orders/${order.id}`, {
        internalNote, externalNote: externalNote || null, salesUserId: salesUserId || null,
        deliveryDate: deliveryDate ? new Date(deliveryDate).toISOString() : null,
        deliveryBatch: batchStr, driverSlotId: driverSlotId || null,
        pricelistId: pricelistId || null, priceType,
        paymentTerm: paymentTerm || null,
        // 草稿 id 只在前端存活；带着它提交，后端会拿不存在的 id 去 update（见 lib/order-line-draft.ts）
        ...(validLines.length > 0 && { lines: toSubmittableLines(validLines), totalAmount: newTotalAmount }),
      })
      toast.success(isEn ? 'Saved' : '已保存')
      // 定价引擎对价格另有说法时必须说出来。此前接口一直返回 pricingWarnings，
      // 而前端**没有任何代码读它** —— 于是操作员改价被静默换成价格表价，
      // 只看到"已保存"（客户 20260814 反馈的就是这个）。
      // 用 duration 拉长 + 逐条显示：这类提示一闪而过等于没说。
      for (const w of saved?.pricingWarnings ?? []) {
        toast.warning(w, { duration: 10000 })
      }
      setEditing(false)
      setEditLines([])
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
    }
  }

  async function handleWithdraw() {
    if (!order) return
    if (!confirm(isEn
      ? `Revert sales order ${displayOrderCode(order)} to quotation status?`
      : `确认将销售单 ${displayOrderCode(order)} 撤回到报价单状态？`)) return
    try {
      await apiPut(`/api/orders/${order.id}`, { status: 'PENDING', confirmationDate: null })
      toast.success(isEn ? 'Reverted to quotation' : '已撤回到报价单')
      router.push(`${prefix}/classic/operator/quotations/${order.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Revert failed' : '撤回失败'))
    }
  }

  async function handleDeleteOrder() {
    if (!order) return
    if (!confirm(isEn
      ? `Delete quotation ${displayOrderCode(order)}? This action cannot be undone.`
      : `确认删除报价单 ${displayOrderCode(order)}？此操作不可撤销。`)) return
    try {
      await apiDelete(`/api/orders/${order.id}`)
      toast.success(isEn ? 'Quotation deleted' : '报价单已删除')
      router.push(`${prefix}/classic/operator/quotations`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Delete failed' : '删除失败'))
    }
  }

  async function handlePrint() {
    if (!order || printing) return
    setPrinting(true)
    try {
      await apiPost(`/api/orders/${order.id}/mark-printed`, { type: 'SALES' })
      window.open(`${prefix}/classic/print/${order.id}`, '_blank', 'noopener,noreferrer')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Print failed' : '打印失败'))
    } finally {
      setPrinting(false)
    }
    load().catch(() => {})
  }

  async function handlePrintDelivery() {
    if (!order || printingDelivery) return
    setPrintingDelivery(true)
    try {
      await apiPost(`/api/orders/${order.id}/mark-printed`, { type: 'DELIVERY' })
      window.open(`${prefix}/classic/print/${order.id}?doc=delivery`, '_blank', 'noopener,noreferrer')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Print failed' : '打印失败'))
    } finally {
      setPrintingDelivery(false)
    }
    load().catch(() => {})
  }

  async function handleSaveDeliveryNote() {
    if (!order || savingDeliveryNote) return
    setSavingDeliveryNote(true)
    try {
      await apiPut(`/api/orders/${order.id}`, { deliveryNote: deliveryNote || null })
      toast.success(isEn ? 'Delivery Note saved' : 'Delivery Note 已保存')
      setShowDeliveryNoteModal(false)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
    } finally {
      setSavingDeliveryNote(false)
    }
  }

  const productRefMap = useMemo(() => {
    const m = new Map<string, string>()
    allProducts.forEach(p => { if (p.internalRef) m.set(p.id, p.internalRef) })
    return m
  }, [allProducts])

  // ⚠️ 必须放在所有提前 return 之前，否则 hook 数量随渲染变化 → React error #310（见报价单详情页同处注释）
  const { helpOverlay } = useHotkeys([
    {
      combo: 'mod+s', label: '保存', group: '编辑',
      when: () => editing,
      run: () => { void handleSave() },
      allowInInput: true,
    },
    {
      combo: 'alt+n', label: '新增一行（聚焦商品搜索）', group: '编辑',
      when: () => editing,
      run: () => focusLineSearchRef.current?.(),
      allowInInput: true,
    },
    {
      combo: 'mod+p', label: '打印销售单', group: '流转',
      // 与 Print 按钮同条件：打印中不可重复触发，锁定单不可打
      when: () => !!order && !printing,
      run: () => { void handlePrint() },
      allowInInput: true,
    },
  ])

  if (loading) return <div className="text-center py-20 text-gray-400">Loading…</div>
  if (!order) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-400 mb-4">{isEn ? 'Order not found' : '订单不存在'}</p>
        <button onClick={() => router.push(`${prefix}/classic/operator/orders`)}
          className="px-4 py-2 border border-gray-300 rounded text-sm">{isEn ? 'Back to Sales Orders' : '返回销售单'}</button>
      </div>
    )
  }

  const statusUp = order.status.toUpperCase()
  const isConfirmed = statusUp === 'CONFIRMED'
  const isLocked = statusUp === 'LOCKED' || statusUp === 'CANCELLED'
  // 已出发及以后:司机归属由调度台管，详情页不可改派(后端亦拒绝)，编辑态司机字段只读
  const driverLocked = ['IN_DELIVERY', 'COMPLETED', 'LOCKED', 'CANCELLED'].includes(statusUp)
  // WAVE_ASSIGNED 起(已入某个波次，哪怕还没出发):assign 时波次会强制把 deliveryDate 回写成
  // wave.waveDate，这里再直接改会让两者分裂(后端亦拒绝，见 orders/[id]/route.ts)。
  // 比 driverLocked 多盖 WAVE_ASSIGNED 这一档——driverSlotId 在这一档还能改(会同步波次)，
  // 但 deliveryDate 的改动没有联动同步逻辑，必须先到调度台移出待分配、状态退回 CONFIRMED 才能改期。
  const dateLocked = statusUp === 'WAVE_ASSIGNED' || driverLocked
  const balance = customer ? Number((customer as unknown as { balance?: number }).balance ?? 0) : 0
  const lines = order.lines ?? []
  const displayLines = editing && editLines.length > 0 ? editLines : lines
  const subtotalExTax = displayLines.reduce((s, l) => s + Number(l.subtotal), 0)
  const displayTotal = editing && editLines.length > 0
    ? displayLines.reduce((s, l) => s + Number(l.subtotal), 0)
    : Number(order.totalAmount)

  const totalTax = displayLines.reduce((s, l) => s + Number(l.subtotal) * (Number(l.taxRate ?? 0) / 100), 0)
  const margin = displayLines.reduce((s, l) => {
    const cost = Number((l as unknown as { cost?: number }).cost ?? 0)
    return s + (Number(l.unitPrice) - cost) * Number(l.orderedQty)
  }, 0)
  async function selectProductIntoLine(lineId: string, p: AllProduct) {
    // 新选的商品也要把可售单位拉起来，否则这一行的 UoM 下拉不出现
    ensureSaleUomOptions(p.id)
    // priceType='default' 的定价链从不查最近成交价，跳过这次查询
    let lastPriceHit: { price: number; date: string } | undefined
    if (customer && priceType !== 'default') {
      try {
        const res = await apiGet<{ price: number | null; createdAt?: string }>(
          `/api/orders/last-price?customerId=${customer.id}&productId=${p.id}${p.uomId ? `&uomId=${p.uomId}` : ''}`
        )
        if (res.price != null && res.price > 0) {
          lastPriceHit = { price: res.price, date: res.createdAt ?? '' }
        }
      } catch { /* 查询失败不阻塞加行，回退到价格表/牌价 */ }
    }
    const resolution = effectiveCustomer
      ? resolveCustomerPrice(p as never, effectiveCustomer, pricelists, 1, lastPriceHit?.price, p.uomId ?? undefined)
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
      uomName: p.uomName ?? UNSET_UOM_LABEL,
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
    setEditLines(prev => {
      // 这个商品(同一 productId+同一可售单位)已经在单子里有一行了 —— 不再插新行，
      // 直接给已有那行数量+1，并把这次刚插的空白草稿行去掉。避免"选两次同一个商品
      // 出现两行、价格还对不上"，客户 20260826 报过。商品相同但单位不同不算重复，
      // 正常插成新行。
      const key = dupKey({ productId: newLine.productId, uomId: newLine.uomId } as EditLine)
      const existing = prev.find(l => l.id !== lineId && l.productId && dupKey(l) === key)
      if (existing) {
        const qty = Number(existing.orderedQty) + 1
        const merged = prev
          .filter(l => l.id !== lineId)
          .map(l => (l.id === existing.id ? { ...l, orderedQty: qty, subtotal: Math.round(Number(l.unitPrice) * qty * 100) / 100 } : l))
        toast.success(isEn ? 'Already on this order — quantity increased by 1' : '这个商品已经在单子里了，数量+1')
        return merged
      }
      // 填充「已经插好的那一行」，不是往末尾追加
      return prev.map(l => (l.id === lineId ? { ...newLine, id: lineId } : l))
    })
  }

  /**
   * 点「+ Add a product」：插一个空的草稿行并让它进入搜索态。
   * force 只给「Enter 连续录入」用：那一刻 setEditLines 还没落地，
   * 闭包里的末行仍是刚填好的草稿行，走守卫会把它再激活一次而不是开新行。
   */
  function addBlankLine(opts?: { force?: boolean }) {
    const last = editLines[editLines.length - 1]
    if (!opts?.force && last && !last.productId) {
      activatePickerRef.current(last.id)
      return
    }
    const draftId = newDraftLineId()
    setEditLines(prev => [...prev, {
      id: draftId,
      orderId: order!.id,
      productId: '', productName: '', spec: '', note: '',
      uomId: null, uomName: UNSET_UOM_LABEL,
      unitPrice: 0, orderedQty: 1, deliveredQty: 0, invoicedQty: 0,
      subtotal: 0, taxRate: 0, sequence: prev.length, cost: 0,
      priceSourceType: null, priceSourceDetail: null, priceSourceDate: null,
    } as unknown as EditLine])
    activatePickerRef.current(draftId)
  }
  // 合并重复商品：同一 productId 且同一可售单位的行合并为一行，数量相加（与 place-order 创建页一致）
  function mergeDuplicateLines() {
    setEditLines(prev => {
      const seen = new Map<string, EditLine>()
      const result: EditLine[] = []
      for (const l of prev) {
        if (!l.productId) { result.push(l); continue }
        const existing = seen.get(dupKey(l))
        if (existing) {
          const qty = Number(existing.orderedQty) + Number(l.orderedQty)
          existing.orderedQty = qty
          existing.subtotal = Math.round(Number(existing.unitPrice) * qty * 100) / 100
        } else {
          const copy = { ...l }
          seen.set(dupKey(l), copy)
          result.push(copy)
        }
      }
      return result
    })
    toast.success(isEn ? 'Duplicate products merged' : '已合并重复商品')
  }


  return (
    <div className="min-h-screen" style={{ background: '#f5f5f5' }}>
      {/* Action bar */}
      <div className="bg-white border-b border-gray-200 px-6 pt-3 pb-2">
        <div className="text-sm">
          <button onClick={() => router.push(`${prefix}/classic/operator/orders`)}
            className="hover:underline" style={{ color: PURPLE }}>{isEn ? 'Sales Orders' : '销售单'}</button>
          <span className="text-gray-400 mx-1">/</span>
          <span className="text-gray-700">{displayOrderCode(order)}</span>
        </div>
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2">
            {!editing ? (
              <button onClick={() => {
                setEditLines(lines.map(l => ({
                  ...l,
                  subtotal: Math.round(Number(l.orderedQty) * Number(l.unitPrice) * 100) / 100,
                })))
                // 现有行涉及的商品先把可售单位拉起来，否则 UoM 下拉一进编辑态是空的
                for (const l of lines) if (l.productId) ensureSaleUomOptions(l.productId)
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
            <div className="h-5 w-px bg-gray-200 mx-1" />
            <button
              onClick={handlePrint}
              disabled={printing}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              Print
            </button>
            <button
              onClick={() => setSendEmailOpen(true)}
              className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
              {isEn ? 'Send Email' : '发送邮件'}
            </button>
            {isConfirmed && !editing && (
              <button onClick={handleWithdraw}
                className="h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
                {isEn ? 'Revert to Quotation' : '撤回到报价单'}
              </button>
            )}
            {statusUp === 'PENDING' && !editing && (
              <button onClick={handleDeleteOrder}
                className="h-8 px-3 text-sm rounded border border-red-300 bg-white text-red-600 hover:bg-red-50">
                {isEn ? 'Delete' : '删除'}
              </button>
            )}
          </div>
          <span className={`inline-block px-3 py-1 rounded text-xs font-medium ${STATUS_COLOR[statusUp] ?? 'bg-gray-100 text-gray-600'}`}>
            {STATUS_LABEL[statusUp] ?? order.status}
          </span>
        </div>

        {/* Status flow */}
        <div className="flex items-center gap-1 mt-3 pb-1">
          <span className="px-3 py-1 text-xs rounded-full text-gray-400">Quotation</span>
          <span className="text-gray-300">›</span>
          <span className="px-3 py-1 text-xs rounded-full text-gray-400">Quotation Sent</span>
          <span className="text-gray-300">›</span>
          <span className="px-3 py-1 text-xs rounded-full text-white font-medium" style={{ background: PURPLE }}>Sales Order</span>
        </div>
      </div>

      <div className="px-6 py-4">
        {/* Header card */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
          <div className="flex items-start justify-between">
            <h1 className="text-3xl font-bold text-gray-800">{displayOrderCode(order)}</h1>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowDeliveryNoteModal(true)}
                title={isEn ? 'Record info about a third party delivering on our behalf; will be printed on the delivery note' : '记录第三方替我们送货的信息，会打印在送货单上'}
                className={`h-9 px-3 text-sm rounded border ${deliveryNote ? 'border-[#fdba74] bg-[#fff7ed] text-[#9a3412]' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`}>
                🚚 Delivery Note{deliveryNote ? ' ●' : ''}
              </button>
              <div className="flex items-center gap-2 px-3 py-2 rounded bg-gray-100">
                <span className="text-xl">🚚</span>
                <div className="text-xs">
                  <div className="font-bold text-gray-800">{deliveryBatch ? 1 : 0}</div>
                  <div className="text-gray-500">Delivery</div>
                </div>
              </div>
            </div>
          </div>

          {editing && (
            <div className="mt-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-sm">
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
                      placeholder={isEn ? 'Internal only, not printed for the customer' : '仅内部可见，不会打印给客户'} />
                  ) : <div className="text-sm text-gray-700 whitespace-pre-wrap">{internalNote || '—'}</div>
                ) : (
                  editing ? (
                    <textarea value={externalNote} onChange={e => setExternalNote(e.target.value)}
                      rows={3} placeholder={isEn ? 'Printed on the quotation and delivery note, visible to the customer' : '会打印在报价单和送货单上，客户可见'}
                      className="w-full border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none resize-none" />
                  ) : <div className="text-sm text-gray-700 whitespace-pre-wrap">{externalNote || '—'}</div>
                )}
              </div>
            </div>

            {/* Right col */}
            <div className="space-y-3 text-sm">
              <div className={`flex items-center rounded ${editing && !dateLocked ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Delivery Date</div>
                {editing && !dateLocked ? (
                  <input
                    type="date"
                    value={deliveryDate}
                    onChange={e => setDeliveryDate(e.target.value)}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300"
                  />
                ) : (
                  <div className="flex-1">
                    <span className="text-gray-800">{deliveryDate || '—'}</span>
                    {editing && dateLocked && <span className="ml-2 text-xs text-gray-400">{isEn ? 'Bound to its trip — remove from the dispatch console to change' : '已绑定所在波次，请到调度台移出待分配后再改'}</span>}
                  </div>
                )}
              </div>
              <div className={`flex items-center rounded ${editing && !driverLocked ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Driver</div>
                {editing && !driverLocked ? (
                  <select value={driverSlotId} onChange={e => { setDriverSlotId(e.target.value); const s = driverSlots.find(x => x.id === e.target.value); setDeliveryBatch(s ? `${s.batchNum} ${s.timeOfDay} ${s.driverName}` : '') }}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none">
                    <option value="">— unassigned —</option>
                    {driverSlots.map(s => <option key={s.id} value={s.id}>{s.batchNum} {s.timeOfDay} {s.driverName}</option>)}
                  </select>
                ) : (
                  <div className="flex-1">
                    <span style={{ color: PURPLE }}>{(order ? formatDriverSlotFromOrder(order) : deliveryBatch) || '—'}</span>
                    {editing && driverLocked && <span className="ml-2 text-xs text-gray-400">{isEn ? 'Already departed — reassign from the dispatch console' : '已出发，改派请到调度台'}</span>}
                  </div>
                )}
              </div>
              <div className={`flex items-center rounded ${editing ? 'bg-amber-50 border border-amber-200 px-2 py-1 -mx-2' : ''}`}>
                <div className="w-32 font-bold text-gray-700 flex-shrink-0">Pricelist</div>
                {editing ? (
                  <select value={pricelistId} onChange={e => setPricelistId(e.target.value)}
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none">
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
                    className="flex-1 border border-amber-400 rounded px-2 py-1 text-sm bg-white focus:outline-none">
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

        {/* Order lines */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
          <div className="border-b border-gray-200 flex">
            <div className="px-4 py-3 text-sm font-bold text-gray-900 border-b-2" style={{ borderColor: PURPLE }}>
              Order Lines
            </div>
          </div>

          <>
            {editing && (() => {
              const dups = [...duplicateCounts.entries()].filter(([, c]) => c > 1)
              if (dups.length === 0) return null
              const nameOf = (key: string) => editLines.find(l => dupKey(l) === key)?.productName ?? key
              return (
                <div className="mx-3 mt-3 rounded-md border border-purple-200 bg-purple-50 px-4 py-2.5 flex items-start gap-3">
                  <span className="text-lg leading-none mt-0.5">🔁</span>
                  <div className="text-sm flex-1">
                    <span className="font-semibold text-purple-700">{isEn ? 'Duplicate product alert: ' : '重复商品提醒：'}</span>
                    <span className="text-purple-600">
                      {isEn ? `${dups.length} products added more than once` : `${dups.length} 个商品被重复添加`}
                      <span className="text-xs text-purple-500 ml-1">
                        ({dups.map(([key, c]) => `${nameOf(key)} ×${c}`).join(isEn ? ', ' : '、')})
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
              onDeleteLine={(_lineId, i) => deleteLine(i)}
              onReorder={reorderLine}
              emptyColSpan={16}
              products={allProducts}
              onPickProduct={selectProductIntoLine}
              onPickByEnter={() => addBlankLine({ force: true })}
              onPickerActivate={fetchLatestProducts}
              onAddBlankLine={editing ? addBlankLine : undefined}
              pickerTexts={{
                empty: isEn ? 'No matching products' : '没有匹配商品',
                placeholder: isEn ? 'Click to select product…' : '点击选择商品…',
                search: isEn ? 'Search product…' : '搜索商品…',
              }}
              onReady={handleEditorReady}
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
                const isDuplicate = !!l.productId && (duplicateCounts.get(dupKey(l)) ?? 0) > 1
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
                          const anchorUomId = (p as { uomId?: string | null } | undefined)?.uomId ?? null
                          return (
                            <select
                              value={l.uomId ?? anchorUomId ?? ''}
                              onChange={e => switchLineUnit(i, e.target.value)}
                              onKeyDown={lineFieldKeyHandler({ onNextRow: focusSearch })}
                              className="w-full text-xs border border-amber-400 rounded px-1 py-0.5 bg-amber-50 focus:outline-none focus:ring-1 focus:ring-amber-300"
                            >
                              {anchorUomId && (
                                <option value={anchorUomId}>{(p as { uomName?: string } | undefined)?.uomName ?? UNSET_UOM_LABEL}</option>
                              )}
                              {/* 排除锚点，否则默认单位在下拉里出现两次 */}
                              {(saleUomOptions[l.productId] ?? [])
                                .filter(o => o.uomId !== anchorUomId)
                                .map(o => (
                                  <option key={o.uomId} value={o.uomId}>{o.uomName}</option>
                                ))}
                            </select>
                          )
                        })()
                      ) : (l.uomName ?? UNSET_UOM_LABEL)}
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
                        <select className="w-16 text-right border border-amber-400 rounded px-1 py-0.5 text-xs bg-amber-50 focus:outline-none"
                          value={Number(l.taxRate ?? 0)}
                          onChange={e => updateLine(i, 'taxRate', Number(e.target.value))}
                          onKeyDown={lineFieldKeyHandler({
                            onNextRow: focusSearch,
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

          {/* Totals */}
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

        {/* Chatter */}
        <OrderChatter orderId={order.id} status={order.status} />
      </div>
      {showDeliveryNoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !savingDeliveryNote && setShowDeliveryNoteModal(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-200">
              <h3 className="text-base font-semibold text-gray-900">Delivery Note</h3>
              <p className="text-xs text-gray-500 mt-0.5">{isEn ? 'Record the specific details when a third party delivers on our behalf (printed on the delivery note)' : '记录第三方替我们送货时的具体信息（会打印在送货单上）'}</p>
            </div>
            <div className="px-5 py-4">
              <textarea
                value={deliveryNote}
                onChange={e => setDeliveryNote(e.target.value)}
                rows={5}
                placeholder={isEn ? 'e.g. Delivered by XX Logistics, contact XX, phone XXX, delivery time XX…' : '例如：由 XX 物流代送，联系人 XX，电话 XXX，送货时间 XX…'}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#714b67]/40 resize-y"
              />
            </div>
            <div className="px-5 py-4 border-t border-gray-200 flex justify-between gap-2">
              <button
                onClick={handlePrintDelivery}
                disabled={printingDelivery}
                title={isEn ? 'Print the delivery note without price/amount' : '打印送货单，不含单价和金额'}
                className="px-4 py-1.5 border border-gray-300 rounded text-sm hover:bg-gray-50 disabled:opacity-40"
              >
                {printingDelivery ? (isEn ? 'Printing…' : '打印中…') : (isEn ? '🖨️ Print Delivery Note' : '🖨️ 打印送货单')}
              </button>
              <div className="flex gap-2">
              <button
                onClick={() => setShowDeliveryNoteModal(false)}
                disabled={savingDeliveryNote}
                className="px-4 py-1.5 border border-gray-300 rounded text-sm hover:bg-gray-50 disabled:opacity-40"
              >
                {isEn ? 'Cancel' : '取消'}
              </button>
              <button
                onClick={handleSaveDeliveryNote}
                disabled={savingDeliveryNote}
                className="px-4 py-1.5 bg-[#714b67] text-white rounded text-sm font-medium hover:bg-[#5d3d55] disabled:opacity-40"
              >
                {savingDeliveryNote ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Save' : '保存')}
              </button>
              </div>
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
