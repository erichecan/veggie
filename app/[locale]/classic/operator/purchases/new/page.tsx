'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { TrendingUp } from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'
import OrderLineEditor from '@/components/classic/OrderLineEditor'
import { lineFieldKeyHandler } from '@/lib/order-line-keys'
import { newDraftLineId } from '@/lib/order-line-draft'
import SimilarProductAlert from '@/components/shared/similar-product-alert'
import { computeOrderLandedCosts } from '@/lib/purchase-landed-cost'
import PdfExtractDialog, { type PdfExtractResult } from './_components/PdfExtractDialog'
import PdfSidePanel from './_components/PdfSidePanel'
import PriceHistoryModal from './_components/PriceHistoryModal'
import CopyFromHistoryModal, { type HistoryPO } from './_components/CopyFromHistoryModal'

const COMMON_CURRENCIES = ['EUR', 'USD', 'GBP', 'CNY']

const CURRENCY_LABELS: Record<string, { en: string; zh: string }> = {
  EUR: { en: 'EUR — Euro', zh: 'EUR — 欧元' },
  USD: { en: 'USD — US Dollar', zh: 'USD — 美金' },
  GBP: { en: 'GBP — British Pound', zh: 'GBP — 英镑' },
  CNY: { en: 'CNY — Chinese Yuan', zh: 'CNY — 人民币' },
}

const PURPLE = '#875A7B'
const DARK = '#1f2d3d'

interface DraftLine {
  id: string
  productId: string
  productName: string
  spec?: string | null
  uomId?: string | null
  uomName?: string | null
  orderedQty: number
  unitCost: number
  taxRate: number
  bestBefore: string | null
  subtotalExTax: number
  taxAmount: number
  subtotalIncTax: number
}

interface Supplier {
  id: string
  name: string
  supplierPaymentTerm?: string | null
}

interface PurchaseProduct {
  id: string
  name: string
  internalRef?: string | null
  category?: string | null
  uomId?: string | null
  uomName?: string | null
  purchaseUomId?: string | null
  purchaseUomName?: string | null
  standardPrice?: number | null
  price?: number | null
}

/** 采购单选品：优先用商品的采购单位，没配过才退回销售/基础单位 */
function purchaseUomOf(prod: PurchaseProduct): { uomId: string | null; uomName: string | null } {
  if (prod.purchaseUomId) return { uomId: prod.purchaseUomId, uomName: prod.purchaseUomName ?? null }
  return { uomId: prod.uomId ?? null, uomName: prod.uomName ?? null }
}

interface Category {
  id: string
  name: string
  nameZh?: string | null
}

interface Uom {
  id: string
  name: string
  nameZh?: string | null
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

export default function NewPurchaseOrderPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale

  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [orderDate, setOrderDate] = useState(today())
  const [expectedDate, setExpectedDate] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([])
  const [submitting, setSubmitting] = useState(false)

  const [currency, setCurrency] = useState('EUR')
  const [exchangeRate, setExchangeRate] = useState(1)
  const [fxSource, setFxSource] = useState<'identity' | 'cache' | 'frankfurter' | 'fallback-latest' | 'unavailable' | null>(null)
  // 汇率是人手动敲进去的(而不是接口自动回填)，视为已确认，即使自动回填当时是兜底/取不到也不算 pending
  const [rateManuallyEdited, setRateManuallyEdited] = useState(false)
  const [freightAmount, setFreightAmount] = useState(0)
  // 待确认：非欧元 + 没有活体当日汇率兜底 + 用户没有手动确认过这个数字——提交时会带 pending 标记，
  // 提交后「确认」这一步会被后端挡住，直到有人在采购单里补上真汇率(20260713 汇率换算改造)
  const exchangeRatePending = currency !== 'EUR' && !rateManuallyEdited && (fxSource === 'unavailable' || fxSource === 'fallback-latest')

  const [sourceDocumentUrl, setSourceDocumentUrl] = useState('')
  const [sourceDocumentName, setSourceDocumentName] = useState('')
  const [showPdfPanel, setShowPdfPanel] = useState(false)
  const [unmatchedExtractedLines, setUnmatchedExtractedLines] = useState<
    { productName: string; quantity: number | null; unitCost: number | null; uom: string | null }[]
  >([])
  const [priceHistoryTarget, setPriceHistoryTarget] = useState<{ id: string; name: string } | null>(null)
  const [pendingQuickCreateQty, setPendingQuickCreateQty] = useState(1)
  const [showCopyFromHistory, setShowCopyFromHistory] = useState(false)

  const [purchaseProducts, setPurchaseProducts] = useState<PurchaseProduct[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [uoms, setUoms] = useState<Uom[]>([])
  const [showQuickCreate, setShowQuickCreate] = useState(false)
  const [qcName, setQcName] = useState('')
  const [qcCategoryId, setQcCategoryId] = useState('')
  const [qcUomId, setQcUomId] = useState('')
  const [qcUnitCost, setQcUnitCost] = useState('')
  const [qcSubmitting, setQcSubmitting] = useState(false)
  // 插完空行要让那一行立刻进搜索态 —— 与 quotation/sale order 同一套交互（useInlineProductPicker）
  const activatePickerRef = useRef<(lineId: string) => void>(() => {})
  const handleEditorReady = useCallback(
    (api: { focusSearch: () => void; activateProductPicker: (lineId: string) => void }) => {
      activatePickerRef.current = api.activateProductPicker
    },
    [],
  )

  useEffect(() => {
    apiGet<{ items: Supplier[] } | Supplier[]>('/api/customers?isVendor=true&limit=200')
      .then(d => setSuppliers(Array.isArray(d) ? d : (d.items ?? [])))
      .catch(() => {})
    apiGet<PurchaseProduct[]>('/api/products?purchasable=1&slim=1').then(setPurchaseProducts).catch(() => {})
    apiGet<Category[]>('/api/product-categories').then(setCategories).catch(() => {})
    apiGet<Uom[]>('/api/uoms').then(setUoms).catch(() => {})
  }, [])

  // 币种变化时自动回填当日汇率；接口不可用时不阻塞下单，允许手动填
  useEffect(() => {
    setRateManuallyEdited(false)
    if (currency === 'EUR') { setExchangeRate(1); setFxSource('identity'); return }
    apiGet<{ rate: number | null; source: typeof fxSource }>(
      `/api/fx-rate?currency=${encodeURIComponent(currency)}&date=${orderDate}`,
    )
      .then(d => {
        setFxSource(d.source)
        if (d.rate != null) setExchangeRate(d.rate)
      })
      .catch(() => setFxSource('unavailable'))
  }, [currency, orderDate])

  function addProductLine(prod: PurchaseProduct, overrides?: { qty?: number; unitCost?: number }) {
    const unitCost = overrides?.unitCost ?? Number(prod.standardPrice ?? prod.price ?? 0)
    const qty = overrides?.qty ?? 1
    const uom = purchaseUomOf(prod)
    setLines(prev => [
      ...prev,
      {
        id: newDraftLineId(),
        productId: prod.id,
        productName: prod.name,
        spec: prod.category ?? null,
        uomId: uom.uomId,
        uomName: uom.uomName,
        orderedQty: qty,
        unitCost,
        taxRate: 0,
        bestBefore: null,
        subtotalExTax: qty * unitCost,
        taxAmount: 0,
        subtotalIncTax: qty * unitCost,
      },
    ])
  }

  /**
   * 点「+ Add a product」/ 就地选品搜索框回车连续录入：插一个空草稿行并让它进入搜索态。
   * 与 quotation/sale order 编辑页同一套模型（见 lib/order-line-draft.ts）。
   */
  function addBlankLine(opts?: { force?: boolean }) {
    // force 只给「Enter 连续录入」用：那一刻 setLines 还没落地，闭包里的末行仍是刚
    // 填好的那个草稿行，走守卫会把它再激活一次而不是开新行。
    const last = lines[lines.length - 1]
    if (!opts?.force && last && !last.productId) {
      activatePickerRef.current(last.id)
      return
    }
    const draftId = newDraftLineId()
    setLines(prev => [
      ...prev,
      {
        id: draftId,
        productId: '',
        productName: '',
        spec: null,
        uomId: null,
        uomName: null,
        orderedQty: 1,
        unitCost: 0,
        taxRate: 0,
        bestBefore: null,
        subtotalExTax: 0,
        taxAmount: 0,
        subtotalIncTax: 0,
      },
    ])
    activatePickerRef.current(draftId)
  }

  /** 就地选品：把选中的商品填进已经插好的那一行（草稿行由 addBlankLine 建好） */
  function fillLineWithProduct(lineId: string, prod: PurchaseProduct) {
    const unitCost = Number(prod.standardPrice ?? prod.price ?? 0)
    const uom = purchaseUomOf(prod)
    setLines(prev => prev.map(l => {
      if (l.id !== lineId) return l
      const qty = Number(l.orderedQty) || 1
      const subtotalExTax = qty * unitCost
      const taxAmount = subtotalExTax * Number(l.taxRate) / 100
      return {
        ...l,
        productId: prod.id,
        productName: prod.name,
        spec: prod.category ?? null,
        uomId: uom.uomId,
        uomName: uom.uomName,
        orderedQty: qty,
        unitCost,
        subtotalExTax,
        taxAmount,
        subtotalIncTax: subtotalExTax + taxAmount,
      }
    }))
  }

  /** 从历史采购单复制行项目：数量/单价原样带入，供应商已由弹窗的调用方（当前 supplierId）限定 */
  function handleCopyFromHistory(historyPo: HistoryPO) {
    if (historyPo.lines.length === 0) {
      toast.info(isEn ? `${historyPo.name} has no line items to copy` : `${historyPo.name} 没有可复制的行项目`)
      return
    }
    const newLines: DraftLine[] = historyPo.lines.map(hl => {
      const product = purchaseProducts.find(p => p.id === hl.productId)
      const qty = Number(hl.orderedQty)
      const unitCost = Number(hl.unitCost)
      const taxRate = Number(hl.taxRate)
      const subtotalExTax = qty * unitCost
      const taxAmount = subtotalExTax * taxRate / 100
      return {
        id: newDraftLineId(),
        productId: hl.productId,
        productName: hl.productName,
        spec: product?.category ?? null,
        uomId: hl.uomId,
        uomName: product?.uomName ?? null,
        orderedQty: qty,
        unitCost,
        taxRate,
        bestBefore: null,
        subtotalExTax,
        taxAmount,
        subtotalIncTax: subtotalExTax + taxAmount,
      }
    })
    setLines(prev => [...prev, ...newLines])
    toast.success(isEn
      ? `Copied ${newLines.length} line(s) from ${historyPo.name}`
      : `已从 ${historyPo.name} 复制 ${newLines.length} 行`)
  }

  /**
   * 单据识别结果核对后「应用到表单」。
   *
   * ⛔ 匹配由**后端**做（`lib/purchase/product-match.ts`），这里只负责把结果落到行上。
   * 之前这里自己跑过一套 `p.name.includes(q) || q.includes(p.name)` 的前端匹配 ——
   * 后半截会让库里的短名商品（`vest`/`0`/`reuse`）变成万能匹配器，
   * 实测把 `Harvest Beans` 配成了 `vest`。同样的错不要在两个地方各犯一次。
   */
  function handlePdfApply(result: PdfExtractResult) {
    setSourceDocumentUrl(result.sourceDocumentUrl ?? '')
    setSourceDocumentName(result.sourceDocumentName)
    setShowPdfPanel(Boolean(result.sourceDocumentUrl))

    if (result.currency) setCurrency(result.currency.toUpperCase())

    if (result.supplierId) {
      setSupplierId(result.supplierId)
    } else if (result.supplierName) {
      toast.info(isEn
        ? `Detected supplier "${result.supplierName}", not matched in system, please select manually`
        : `识别到供应商「${result.supplierName}」，未在系统中匹配到，请手动选择`)
    }

    const unmatched: typeof unmatchedExtractedLines = []
    for (const line of result.lines) {
      const matched = line.matchedProductId
        ? purchaseProducts.find(p => p.id === line.matchedProductId)
        : undefined
      if (matched) {
        addProductLine(matched, { qty: line.quantity ?? 1, unitCost: line.unitCost ?? undefined })
      } else {
        unmatched.push({
          productName: line.productName,
          quantity: line.quantity,
          unitCost: line.unitCost,
          uom: line.uom,
        })
      }
    }
    setUnmatchedExtractedLines(unmatched)
    if (unmatched.length > 0) {
      toast.warning(isEn
        ? `${unmatched.length} line(s) not matched — create them one by one below`
        : `${unmatched.length} 行未匹配到系统商品，请在下方列表逐行新建`)
    }
  }

  function deleteLine(lineId: string) {
    setLines(prev => prev.filter(l => l.id !== lineId))
  }

  function updateLine(idx: number, field: 'orderedQty' | 'unitCost' | 'taxRate', value: number) {
    setLines(prev => {
      const next = [...prev]
      const l = { ...next[idx], [field]: value }
      const qty = field === 'orderedQty' ? value : Number(next[idx].orderedQty)
      const cost = field === 'unitCost' ? value : Number(next[idx].unitCost)
      const tax = field === 'taxRate' ? value : Number(next[idx].taxRate)
      l.subtotalExTax = qty * cost
      l.taxAmount = l.subtotalExTax * tax / 100
      l.subtotalIncTax = l.subtotalExTax + l.taxAmount
      next[idx] = l
      return next
    })
  }

  function updateBestBefore(idx: number, value: string) {
    setLines(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], bestBefore: value || null }
      return next
    })
  }

  function openQuickCreate(prefill?: { name: string; unitCost: number | null; qty: number | null }) {
    setQcName(prefill?.name ?? '')
    setQcCategoryId('')
    setQcUomId('')
    setQcUnitCost(prefill?.unitCost != null ? String(prefill.unitCost) : '')
    setPendingQuickCreateQty(prefill?.qty ?? 1)
    setShowQuickCreate(true)
  }

  function resolveUnmatchedLine(name: string) {
    setUnmatchedExtractedLines(prev => prev.filter(l => l.productName !== name))
  }

  async function submitQuickCreate() {
    if (!qcName.trim()) { toast.error(isEn ? 'Product name cannot be empty' : '商品名称不能为空'); return }
    setQcSubmitting(true)
    try {
      const created = await apiPost<PurchaseProduct>('/api/products/quick-create', {
        name: qcName.trim(),
        categoryId: qcCategoryId || undefined,
        purchaseUomId: qcUomId || undefined,
        unitCost: qcUnitCost ? Number(qcUnitCost) : undefined,
      })
      const matchedUom = uoms.find(u => u.id === qcUomId)
      const uomName = isEn ? (matchedUom?.name || matchedUom?.nameZh) : (matchedUom?.nameZh || matchedUom?.name)
      const withUom = { ...created, uomId: qcUomId || null, uomName: uomName ?? null, standardPrice: qcUnitCost ? Number(qcUnitCost) : 0 }
      setPurchaseProducts(prev => [withUom, ...prev])
      addProductLine(withUom, { qty: pendingQuickCreateQty, unitCost: qcUnitCost ? Number(qcUnitCost) : undefined })
      resolveUnmatchedLine(qcName.trim())
      setShowQuickCreate(false)
      toast.success(isEn ? `Created "${created.name}" and added to purchase line` : `已创建「${created.name}」并加入采购行`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to create product' : '创建商品失败'))
    } finally {
      setQcSubmitting(false)
    }
  }

  const subtotalExTax = lines.reduce((s, l) => s + l.subtotalExTax, 0)
  const totalTax = lines.reduce((s, l) => s + l.taxAmount, 0)
  const totalIncTax = lines.reduce((s, l) => s + l.subtotalIncTax, 0)
  const supplier = suppliers.find(s => s.id === supplierId)
  // 误按 Enter / 点「+ Add a product」多出的空行（还没选商品）不占「至少一行」的名额——
  // 同 quotation/sale order 编辑页的处理(20260814+)
  const validLines = lines.filter(l => l.productId)
  const canSubmit = !!supplierId && validLines.length > 0 && !submitting
  const landedCosts = computeOrderLandedCosts({ freightAmount, subtotalExTax }, lines)
  const totalAllocatedFreight = landedCosts.reduce((s, c) => s + c.allocatedFreight, 0)

  async function handleSubmit() {
    if (!supplierId) { toast.error(isEn ? 'Please select a supplier' : '请选择供应商'); return }
    if (validLines.length === 0) { toast.error(isEn ? 'Please add at least one purchase line' : '请至少添加一行采购商品'); return }
    setSubmitting(true)
    try {
      const result = await apiPost<{ id: string }>('/api/purchase-orders', {
        supplierId,
        orderDate,
        expectedDate: expectedDate || undefined,
        notes: notes || undefined,
        currency,
        // 待确认的汇率(未取到活体当日汇率、用户也没手动确认)不当真数字传给后端——
        // 传 null 让后端按"汇率缺失"处理(exchangeRate=null、exchangeRatePending=true)，
        // 而不是把一个没人认过的兜底猜测值悄悄存成"下单时锁定的汇率"(20260713)。
        exchangeRate: exchangeRatePending ? null : exchangeRate,
        freightAmount,
        sourceDocumentUrl: sourceDocumentUrl || undefined,
        sourceDocumentName: sourceDocumentName || undefined,
        lines: validLines.map(l => ({
          productId: l.productId,
          productName: l.productName,
          uomId: l.uomId,
          orderedQty: Number(l.orderedQty),
          unitCost: Number(l.unitCost),
          taxRate: Number(l.taxRate),
          bestBefore: l.bestBefore,
        })),
      })
      toast.success(isEn ? 'Purchase order created' : '采购单已创建')
      router.push(`${prefix}/classic/operator/purchases/${result.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Creation failed' : '创建失败'))
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls = 'border border-gray-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100'
  const numInputCls = 'border border-gray-300 rounded px-1.5 py-0.5 text-sm bg-white text-right focus:outline-none focus:border-blue-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

  return (
    <div className="flex h-[calc(100vh-44px)]" style={{ background: '#f3f4f5' }}>
    <div className="flex flex-col flex-1 overflow-auto min-w-0">
      {/* ── Top control bar ─────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 flex-shrink-0">
        <div className="px-6 pt-3 pb-1 text-xs text-gray-500">
          <button
            onClick={() => router.push(`${prefix}/classic/operator/purchases`)}
            className="hover:underline"
            style={{ color: PURPLE }}
          >
            {isEn ? 'Purchase Orders' : '询价单'}
          </button>
          <span className="mx-1 text-gray-400">/</span>
          <span className="text-gray-700 font-medium">{isEn ? 'New' : '新建'}</span>
        </div>
        <div className="px-6 py-2.5 flex items-center gap-2">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
            style={{ background: PURPLE }}
          >
            {submitting ? (isEn ? 'Creating…' : '创建中…') : (isEn ? 'Create' : '创建')}
          </button>
          <button
            onClick={() => router.push(`${prefix}/classic/operator/purchases`)}
            className="h-8 px-4 text-sm rounded border font-medium hover:bg-gray-50"
            style={{ borderColor: '#d0d5dd', color: DARK }}
          >
            {isEn ? 'Cancel' : '取消'}
          </button>
          <div className="w-px h-5 bg-gray-200 mx-1" />
          <PdfExtractDialog onApply={handlePdfApply} products={purchaseProducts} />
          {sourceDocumentUrl && (
            <button
              onClick={() => setShowPdfPanel(v => !v)}
              className="h-8 px-3 text-sm rounded border font-medium hover:bg-gray-50"
              style={{ borderColor: '#d0d5dd', color: DARK }}
            >
              {showPdfPanel ? (isEn ? 'Hide PDF' : '收起 PDF') : (isEn ? '📄 View PDF' : '📄 查看 PDF')}
            </button>
          )}
        </div>
      </div>

      {/* ── Main form card ───────────────────────────────── */}
      <div className="flex-1 p-6 overflow-auto">
        <div className="bg-white rounded border border-gray-200 shadow-sm">
          {/* Form header */}
          <div className="px-6 pt-5 pb-4">
            <div className="grid grid-cols-2 gap-10">
              <div className="space-y-3">
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Supplier *' : '供应商 *'}</label>
                  <select
                    value={supplierId}
                    onChange={e => setSupplierId(e.target.value)}
                    className={`flex-1 ${inputCls}`}
                  >
                    <option value="">{isEn ? 'Please select a supplier...' : '请选择供应商...'}</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {supplierId && (
                    <button
                      onClick={() => setShowCopyFromHistory(true)}
                      className="ml-3 text-xs whitespace-nowrap hover:underline flex-shrink-0"
                      style={{ color: PURPLE }}
                    >
                      {isEn ? 'Copy from history' : '从历史单复制'}
                    </button>
                  )}
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Payment Terms' : '付款条款'}</label>
                  <span className="text-sm text-gray-700">{supplier?.supplierPaymentTerm || '—'}</span>
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Order Date' : '订购日期'}</label>
                  <input
                    type="date"
                    value={orderDate}
                    onChange={e => setOrderDate(e.target.value)}
                    className={inputCls}
                    style={{ width: '180px' }}
                  />
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Expected Date' : '预计到货日期'}</label>
                  <input
                    type="date"
                    value={expectedDate}
                    onChange={e => setExpectedDate(e.target.value)}
                    className={inputCls}
                    style={{ width: '180px' }}
                  />
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Currency' : '币种'}</label>
                  <select
                    value={currency}
                    onChange={e => setCurrency(e.target.value)}
                    className={inputCls}
                    style={{ width: '170px' }}
                  >
                    {/* PDF 识别可能猜出不在常用列表里的币种(currencyGuess)，兜底把它也加进选项，
                        否则 select 的 value 对不上任何 option 会显示空白，看起来像"选丢了" */}
                    {(COMMON_CURRENCIES.includes(currency) ? COMMON_CURRENCIES : [currency, ...COMMON_CURRENCIES]).map(c => (
                      <option key={c} value={c}>{isEn ? (CURRENCY_LABELS[c]?.en ?? c) : (CURRENCY_LABELS[c]?.zh ?? c)}</option>
                    ))}
                  </select>
                  {currency !== 'EUR' && (
                    <div className="flex items-center gap-1 ml-3 text-xs text-gray-500">
                      <span>{isEn ? 'Rate→EUR' : '汇率→EUR'}</span>
                      <input
                        type="number" step="0.000001" min="0"
                        value={exchangeRate}
                        onChange={e => { setExchangeRate(Number(e.target.value)); setRateManuallyEdited(true) }}
                        className={`${numInputCls} w-20`}
                      />
                      {fxSource === 'unavailable' && (
                        <span className="text-amber-600">{isEn ? 'Live rate unavailable, please enter manually' : '未取到实时汇率，请手动填'}</span>
                      )}
                      {fxSource === 'fallback-latest' && (
                        <span className="text-amber-600">{isEn ? "Today's rate unavailable, using latest known rate" : '未取到当日汇率，已用最近一次可用汇率兜底'}</span>
                      )}
                      {fxSource === 'frankfurter' && <span className="text-gray-400">{isEn ? "Today's rate" : '当日汇率'}</span>}
                      {fxSource === 'cache' && <span className="text-gray-400">{isEn ? "Today's rate (cached)" : '当日汇率（缓存）'}</span>}
                    </div>
                  )}
                  {exchangeRatePending && (
                    <span className="ml-3 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-700">
                      {isEn ? '🔴 Rate pending — confirmation will be blocked until fixed' : '🔴 汇率待确认——不改这个数字，采购单将无法「确认」'}
                    </span>
                  )}
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Freight (Ex Tax)' : '运费（税前）'}</label>
                  <input
                    type="number" step="0.01" min="0"
                    value={freightAmount}
                    onChange={e => setFreightAmount(Number(e.target.value))}
                    className={numInputCls}
                    style={{ width: '100px' }}
                  />
                </div>
              </div>
            </div>
          </div>

          {unmatchedExtractedLines.length > 0 && (
            <div className="mx-6 mb-4 bg-amber-50 border border-amber-200 rounded p-3 space-y-1.5">
              <p className="text-xs font-medium text-amber-700">
                {isEn ? 'Products detected in the PDF but not in the system, need to be created one by one:' : 'PDF 识别到但系统里没有的商品，需要逐行新建：'}
              </p>
              {unmatchedExtractedLines.map((l, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-gray-700">
                    {isEn
                      ? <>{l.productName} · Qty {l.quantity ?? '—'} {l.uom ?? ''} · Unit Price {l.unitCost ?? '—'}</>
                      : <>{l.productName} · 数量 {l.quantity ?? '—'} {l.uom ?? ''} · 单价 {l.unitCost ?? '—'}</>}
                  </span>
                  <button
                    onClick={() => openQuickCreate({ name: l.productName, unitCost: l.unitCost, qty: l.quantity })}
                    className="hover:underline flex-shrink-0 ml-2"
                    style={{ color: PURPLE }}
                  >
                    {isEn ? 'Create product and add' : '新建商品并加入'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Product line table —— 就地选品 + Tab/Enter 走位与 quotation/sale order 共用同一套（useInlineProductPicker） */}
          <div className="border-t border-gray-200">
            <OrderLineEditor
              lines={lines}
              editing
              products={purchaseProducts}
              onDeleteLine={lineId => deleteLine(lineId)}
              onPickProduct={fillLineWithProduct}
              onPickByEnter={() => addBlankLine({ force: true })}
              onPickByTab={lineId => {
                // 没有可编辑的描述框，Tab 选完商品后把焦点交给数量——本行第一个该填的字段
                setTimeout(() => {
                  document.querySelector<HTMLInputElement>(`[data-qty-line="${lineId}"]`)?.focus()
                }, 50)
              }}
              onAddBlankLine={addBlankLine}
              addBlankLineText={isEn ? '+ Add a product' : '+ 添加商品'}
              pickerTexts={{
                empty: isEn ? 'No matching products' : '没有匹配商品',
                placeholder: isEn ? 'Click to select product…' : '点击选择商品…',
                search: isEn ? 'Search product…' : '搜索商品…',
              }}
              onReady={handleEditorReady}
              emptyColSpan={11}
              emptyMessage={isEn ? 'No lines yet — click "+ Add a product" below' : '暂无明细行，点下方「+ 添加商品」'}
              tableClassName="w-full text-sm border-collapse"
              renderHeaders={() => (
                <tr style={{ background: '#f8f8f8', borderBottom: '1px solid #e8e8e8' }}>
                  <th className="w-8 px-2 py-2.5" />
                  <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">{isEn ? 'Product' : '商品'}</th>
                  <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">{isEn ? 'Description' : '描述'}</th>
                  <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">{isEn ? 'Quantity' : '数量'}</th>
                  <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">{isEn ? 'Unit' : '单位'}</th>
                  <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs" title={isEn ? 'Reference cost — last known cost price, not saved on this order' : '参考成本价——上次收货成本，仅供对比，不写入本单'}>
                    {isEn ? 'Cost' : '参考成本'}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">{isEn ? 'Unit Price' : '单价'}</th>
                  <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">{isEn ? 'Tax %' : '税率%'}</th>
                  <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">{isEn ? 'Untaxed Total' : '税前小计'}</th>
                  <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">Best Before</th>
                  <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">{isEn ? 'Subtotal' : '小计'}</th>
                </tr>
              )}
              defaultRowCls="border-b border-gray-100 hover:bg-blue-50/30 transition-colors"
              renderRow={(l, i, { deleteButton, focusSearch, productCell }) => {
                const isLast = i === lines.length - 1
                return (
                  <>
                    <td className="px-2 py-2.5 text-center">{deleteButton}</td>
                    <td className="px-4 py-2.5 font-medium" style={{ color: PURPLE }}>
                      {productCell({ lineId: l.id, productName: l.productName })}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs max-w-[180px] truncate">{l.spec || ''}</td>
                    <td className="px-4 py-2.5 text-right">
                      <input type="number" step="0.001" min="0"
                        data-qty-line={l.id}
                        className={numInputCls} style={{ width: '80px' }}
                        value={Number(l.orderedQty)}
                        onChange={e => updateLine(i, 'orderedQty', Number(e.target.value))}
                        onFocus={e => e.target.select()}
                        onKeyDown={lineFieldKeyHandler({ onNextRow: focusSearch })} />
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{l.uomName || '—'}</td>
                    <td className="px-4 py-2.5 text-right text-gray-400 text-xs">
                      {(() => {
                        const refCost = purchaseProducts.find(p => p.id === l.productId)?.standardPrice
                        return refCost != null ? Number(refCost).toFixed(2) : '—'
                      })()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <input type="number" step="0.01" min="0"
                          className={numInputCls} style={{ width: '90px' }}
                          value={Number(l.unitCost)}
                          onChange={e => updateLine(i, 'unitCost', Number(e.target.value))}
                          onFocus={e => e.target.select()}
                          onKeyDown={lineFieldKeyHandler({ onNextRow: focusSearch })} />
                        {l.productId && (
                          <button
                            onClick={() => setPriceHistoryTarget({ id: l.productId, name: l.productName })}
                            title={isEn ? 'View price history' : '查看价格历史'}
                            className="text-gray-400 hover:text-gray-600 flex-shrink-0"
                          >
                            <TrendingUp className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <select
                        className={numInputCls} style={{ width: '68px' }}
                        value={Number(l.taxRate)}
                        onChange={e => updateLine(i, 'taxRate', Number(e.target.value))}
                        onKeyDown={lineFieldKeyHandler({ onNextRow: focusSearch })}>
                        <option value={0}>0%</option>
                        <option value={13.5}>13.5%</option>
                        <option value={23}>23%</option>
                      </select>
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-600">
                      {l.subtotalExTax.toFixed(2)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <input type="date"
                        className={`${numInputCls} text-xs`} style={{ width: '120px' }}
                        value={l.bestBefore ?? ''}
                        onChange={e => updateBestBefore(i, e.target.value)}
                        onKeyDown={lineFieldKeyHandler({ onNextRow: focusSearch, isLastFieldOfLastRow: isLast })} />
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-gray-800">
                      {l.subtotalIncTax.toFixed(2)}
                      {freightAmount > 0 && l.productId && (
                        <div className="text-[10px] font-normal text-gray-400">
                          {isEn ? 'Landed unit price' : '落地单价'} {landedCosts[i]?.landedUnitCost.toFixed(2)}
                        </div>
                      )}
                    </td>
                  </>
                )
              }}
              footer={
                <div className="px-4 py-2 border-t border-gray-100">
                  <button
                    onClick={() => openQuickCreate()}
                    className="text-xs whitespace-nowrap hover:underline"
                    style={{ color: PURPLE }}
                  >
                    {isEn ? "Can't find it? Create product" : '找不到？新建商品'}
                  </button>
                </div>
              }
            />
          </div>

          {/* Totals */}
          <div className="border-t border-gray-200 px-6 py-5 flex justify-end">
            <div style={{ minWidth: '280px' }}>
              <div className="flex justify-between py-1 text-sm">
                <span className="text-gray-500">{isEn ? 'Subtotal (Ex Tax)' : '税前金额'}</span>
                <span className="text-gray-800 font-medium">{subtotalExTax.toFixed(2)}</span>
              </div>
              <div className="flex justify-between py-1 text-sm">
                <span className="text-gray-500">{isEn ? 'Tax' : '税额'}</span>
                <span className="text-gray-800">{totalTax.toFixed(2)}</span>
              </div>
              <div className="border-t border-gray-300 mt-1 pt-2 flex justify-between">
                <span className="text-sm font-semibold" style={{ color: DARK }}>{isEn ? 'Total' : '合计'}</span>
                <span className="text-base font-bold" style={{ color: DARK }}>{currency} {totalIncTax.toFixed(2)}</span>
              </div>
              {currency !== 'EUR' && (
                <div className="flex justify-between py-1 text-sm">
                  <span className="text-gray-400">{isEn ? '≈ EUR (at rate above)' : '≈ 折合欧元（按上方汇率）'}</span>
                  <span className={exchangeRatePending ? 'text-red-500 font-medium' : 'text-gray-500'}>
                    {exchangeRatePending ? (isEn ? 'pending' : '待确认') : `€${(totalIncTax * exchangeRate).toFixed(2)}`}
                  </span>
                </div>
              )}
              {freightAmount > 0 && (
                <div className="flex justify-between py-1 text-sm border-t border-gray-100 mt-1 pt-2">
                  <span className="text-gray-500">
                    {isEn ? `Landed Cost (incl. freight ${totalAllocatedFreight.toFixed(2)})` : `落地成本（含运费 ${totalAllocatedFreight.toFixed(2)}）`}
                  </span>
                  <span className="text-gray-800 font-medium">{(subtotalExTax + totalAllocatedFreight).toFixed(2)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Notes */}
          <div className="border-t border-gray-200 px-6 py-5">
            <label className="block text-sm text-gray-500 mb-1.5">{isEn ? 'Notes' : '备注'}</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder={isEn ? 'Internal notes...' : '内部备注...'}
              className={`w-full ${inputCls} resize-none`}
              style={{ maxWidth: '520px' }}
            />
          </div>
        </div>
      </div>

      {showQuickCreate && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-800">{isEn ? 'Create Product' : '新建商品'}</h2>
            <p className="text-xs text-gray-400">
              {isEn
                ? 'Create minimal info for this purchase; not sellable by default, complete the sale price/tax rate/image in the product library later.'
                : '先建最小信息用于本次采购；默认不可销售，之后可在商品库补全销售价/税率/图片再上架。'}
            </p>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Product Name' : '商品名称'}</label>
              <input
                value={qcName}
                onChange={e => setQcName(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                autoFocus
              />
              <SimilarProductAlert name={qcName} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Category' : '分类'}</label>
                <select
                  value={qcCategoryId}
                  onChange={e => setQcCategoryId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                >
                  <option value="">{isEn ? 'Uncategorized' : '未分类'}</option>
                  {categories.map(c => (
                    <option key={c.id} value={c.id}>{isEn ? (c.name || c.nameZh) : (c.nameZh || c.name)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Purchase Unit' : '采购单位'}</label>
                <select
                  value={qcUomId}
                  onChange={e => setQcUomId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                >
                  <option value="">{isEn ? 'Unspecified' : '未指定'}</option>
                  {uoms.map(u => (
                    <option key={u.id} value={u.id}>{isEn ? (u.name || u.nameZh) : (u.nameZh || u.name)}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Reference Purchase Price (optional)' : '参考采购单价（可选）'}</label>
              <input
                type="number" step="0.01" min="0"
                value={qcUnitCost}
                onChange={e => setQcUnitCost(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setShowQuickCreate(false)}
                className="flex-1 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
              >
                {isEn ? 'Cancel' : '取消'}
              </button>
              <button
                onClick={submitQuickCreate}
                disabled={qcSubmitting}
                className="flex-1 py-2 rounded text-sm text-white disabled:opacity-50"
                style={{ background: PURPLE }}
              >
                {qcSubmitting ? (isEn ? 'Creating…' : '创建中…') : (isEn ? 'Create and add to line' : '创建并加入采购行')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCopyFromHistory && (
        <CopyFromHistoryModal
          supplierId={supplierId}
          isEn={isEn}
          onClose={() => setShowCopyFromHistory(false)}
          onPick={handleCopyFromHistory}
        />
      )}

      {priceHistoryTarget && (
        <PriceHistoryModal
          productId={priceHistoryTarget.id}
          productName={priceHistoryTarget.name}
          supplierId={supplierId || null}
          onClose={() => setPriceHistoryTarget(null)}
          onApplyLastPrice={price => {
            const idx = lines.findIndex(l => l.productId === priceHistoryTarget.id)
            if (idx >= 0) updateLine(idx, 'unitCost', price)
            setPriceHistoryTarget(null)
          }}
        />
      )}
    </div>

    {showPdfPanel && sourceDocumentUrl && (
      <PdfSidePanel
        url={sourceDocumentUrl}
        name={sourceDocumentName}
        onClose={() => setShowPdfPanel(false)}
      />
    )}
    </div>
  )
}
