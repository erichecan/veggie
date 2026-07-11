'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { Trash2, TrendingUp } from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'
import ProductSearchInput from '@/components/classic/ProductSearchInput'
import SimilarProductAlert from '@/components/shared/similar-product-alert'
import { computeOrderLandedCosts } from '@/lib/purchase-landed-cost'
import PdfExtractDialog, { type PdfExtractResult } from './_components/PdfExtractDialog'
import PdfSidePanel from './_components/PdfSidePanel'
import PriceHistoryModal from './_components/PriceHistoryModal'

const COMMON_CURRENCIES = ['EUR', 'USD', 'GBP', 'MAD', 'CNY']

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
  standardPrice?: number | null
  price?: number | null
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

  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [orderDate, setOrderDate] = useState(today())
  const [expectedDate, setExpectedDate] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([])
  const [submitting, setSubmitting] = useState(false)

  const [currency, setCurrency] = useState('EUR')
  const [exchangeRate, setExchangeRate] = useState(1)
  const [fxSource, setFxSource] = useState<'identity' | 'cache' | 'frankfurter' | 'unavailable' | null>(null)
  const [freightAmount, setFreightAmount] = useState(0)

  const [sourceDocumentUrl, setSourceDocumentUrl] = useState('')
  const [sourceDocumentName, setSourceDocumentName] = useState('')
  const [showPdfPanel, setShowPdfPanel] = useState(false)
  const [unmatchedExtractedLines, setUnmatchedExtractedLines] = useState<
    { productName: string; quantity: number | null; unitCost: number | null; uom: string | null }[]
  >([])
  const [priceHistoryTarget, setPriceHistoryTarget] = useState<{ id: string; name: string } | null>(null)
  const [pendingQuickCreateQty, setPendingQuickCreateQty] = useState(1)

  const [purchaseProducts, setPurchaseProducts] = useState<PurchaseProduct[]>([])
  const [productQuery, setProductQuery] = useState('')
  const [categories, setCategories] = useState<Category[]>([])
  const [uoms, setUoms] = useState<Uom[]>([])
  const [showQuickCreate, setShowQuickCreate] = useState(false)
  const [qcName, setQcName] = useState('')
  const [qcCategoryId, setQcCategoryId] = useState('')
  const [qcUomId, setQcUomId] = useState('')
  const [qcUnitCost, setQcUnitCost] = useState('')
  const [qcSubmitting, setQcSubmitting] = useState(false)
  const lineSeq = useRef(0)

  useEffect(() => {
    apiGet<{ items: Supplier[] } | Supplier[]>('/api/customers?isVendor=true&limit=200')
      .then(d => setSuppliers(Array.isArray(d) ? d : (d.items ?? [])))
      .catch(() => {})
    apiGet<PurchaseProduct[]>('/api/products?purchasable=1').then(setPurchaseProducts).catch(() => {})
    apiGet<Category[]>('/api/product-categories').then(setCategories).catch(() => {})
    apiGet<Uom[]>('/api/uoms').then(setUoms).catch(() => {})
  }, [])

  // 币种变化时自动回填当日汇率；接口不可用时不阻塞下单，允许手动填
  useEffect(() => {
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
    lineSeq.current += 1
    const unitCost = overrides?.unitCost ?? Number(prod.standardPrice ?? prod.price ?? 0)
    const qty = overrides?.qty ?? 1
    setLines(prev => [
      ...prev,
      {
        id: `new-${lineSeq.current}`,
        productId: prod.id,
        productName: prod.name,
        spec: prod.category ?? null,
        uomId: prod.uomId ?? null,
        uomName: prod.uomName ?? null,
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

  /** PDF 识别结果核对后"应用到表单"：按商品名匹配已有采购商品，未匹配的进"待处理"列表 */
  function handlePdfApply(result: PdfExtractResult) {
    setSourceDocumentUrl(result.sourceDocumentUrl)
    setSourceDocumentName(result.sourceDocumentName)
    setShowPdfPanel(true)

    if (result.currencyGuess) setCurrency(result.currencyGuess.toUpperCase())

    if (result.supplierGuess) {
      const guess = result.supplierGuess.toLowerCase()
      const matched = suppliers.find(s =>
        s.name.toLowerCase().includes(guess) || guess.includes(s.name.toLowerCase()))
      if (matched) setSupplierId(matched.id)
      else toast.info(`识别到供应商「${result.supplierGuess}」，未在系统中匹配到，请手动选择`)
    }

    const unmatched: typeof unmatchedExtractedLines = []
    for (const line of result.lines) {
      const name = line.productName.toLowerCase()
      const matched = purchaseProducts.find(p =>
        p.name.toLowerCase().includes(name) || name.includes(p.name.toLowerCase()))
      if (matched) {
        addProductLine(matched, { qty: line.quantity ?? 1, unitCost: line.unitCost ?? undefined })
      } else {
        unmatched.push(line)
      }
    }
    setUnmatchedExtractedLines(unmatched)
    if (unmatched.length > 0) {
      toast.warning(`${unmatched.length} 行商品未匹配到系统商品，请在下方列表逐行新建`)
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
    setQcName(prefill?.name ?? productQuery)
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
    if (!qcName.trim()) { toast.error('商品名称不能为空'); return }
    setQcSubmitting(true)
    try {
      const created = await apiPost<PurchaseProduct>('/api/products/quick-create', {
        name: qcName.trim(),
        categoryId: qcCategoryId || undefined,
        purchaseUomId: qcUomId || undefined,
        unitCost: qcUnitCost ? Number(qcUnitCost) : undefined,
      })
      const uomName = uoms.find(u => u.id === qcUomId)?.nameZh || uoms.find(u => u.id === qcUomId)?.name
      const withUom = { ...created, uomId: qcUomId || null, uomName: uomName ?? null, standardPrice: qcUnitCost ? Number(qcUnitCost) : 0 }
      setPurchaseProducts(prev => [withUom, ...prev])
      addProductLine(withUom, { qty: pendingQuickCreateQty, unitCost: qcUnitCost ? Number(qcUnitCost) : undefined })
      resolveUnmatchedLine(qcName.trim())
      setProductQuery('')
      setShowQuickCreate(false)
      toast.success(`已创建「${created.name}」并加入采购行`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建商品失败')
    } finally {
      setQcSubmitting(false)
    }
  }

  const subtotalExTax = lines.reduce((s, l) => s + l.subtotalExTax, 0)
  const totalTax = lines.reduce((s, l) => s + l.taxAmount, 0)
  const totalIncTax = lines.reduce((s, l) => s + l.subtotalIncTax, 0)
  const supplier = suppliers.find(s => s.id === supplierId)
  const canSubmit = !!supplierId && lines.length > 0 && !submitting
  const landedCosts = computeOrderLandedCosts({ freightAmount, subtotalExTax }, lines)
  const totalAllocatedFreight = landedCosts.reduce((s, c) => s + c.allocatedFreight, 0)

  async function handleSubmit() {
    if (!supplierId) { toast.error('请选择供应商'); return }
    if (lines.length === 0) { toast.error('请至少添加一行采购商品'); return }
    setSubmitting(true)
    try {
      const result = await apiPost<{ id: string }>('/api/purchase-orders', {
        supplierId,
        orderDate,
        expectedDate: expectedDate || undefined,
        notes: notes || undefined,
        currency,
        exchangeRate,
        freightAmount,
        sourceDocumentUrl: sourceDocumentUrl || undefined,
        sourceDocumentName: sourceDocumentName || undefined,
        lines: lines.map(l => ({
          productId: l.productId,
          productName: l.productName,
          uomId: l.uomId,
          orderedQty: Number(l.orderedQty),
          unitCost: Number(l.unitCost),
          taxRate: Number(l.taxRate),
          bestBefore: l.bestBefore,
        })),
      })
      toast.success('采购单已创建')
      router.push(`${prefix}/classic/operator/purchases/${result.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls = 'border border-gray-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100'
  const numInputCls = 'border border-gray-300 rounded px-1.5 py-0.5 text-sm bg-white text-right focus:outline-none focus:border-blue-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

  return (
    <div className="flex h-full" style={{ background: '#f3f4f5' }}>
    <div className="flex flex-col flex-1 overflow-auto min-w-0">
      {/* ── Top control bar ─────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 flex-shrink-0">
        <div className="px-6 pt-3 pb-1 text-xs text-gray-500">
          <button
            onClick={() => router.push(`${prefix}/classic/operator/purchases`)}
            className="hover:underline"
            style={{ color: PURPLE }}
          >
            询价单
          </button>
          <span className="mx-1 text-gray-400">/</span>
          <span className="text-gray-700 font-medium">新建</span>
        </div>
        <div className="px-6 py-2.5 flex items-center gap-2">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
            style={{ background: PURPLE }}
          >
            {submitting ? '创建中…' : '创建'}
          </button>
          <button
            onClick={() => router.push(`${prefix}/classic/operator/purchases`)}
            className="h-8 px-4 text-sm rounded border font-medium hover:bg-gray-50"
            style={{ borderColor: '#d0d5dd', color: DARK }}
          >
            取消
          </button>
          <div className="w-px h-5 bg-gray-200 mx-1" />
          <PdfExtractDialog onApply={handlePdfApply} />
          {sourceDocumentUrl && (
            <button
              onClick={() => setShowPdfPanel(v => !v)}
              className="h-8 px-3 text-sm rounded border font-medium hover:bg-gray-50"
              style={{ borderColor: '#d0d5dd', color: DARK }}
            >
              {showPdfPanel ? '收起 PDF' : '📄 查看 PDF'}
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
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">供应商 *</label>
                  <select
                    value={supplierId}
                    onChange={e => setSupplierId(e.target.value)}
                    className={`flex-1 ${inputCls}`}
                  >
                    <option value="">请选择供应商...</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">付款条款</label>
                  <span className="text-sm text-gray-700">{supplier?.supplierPaymentTerm || '—'}</span>
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">订购日期</label>
                  <input
                    type="date"
                    value={orderDate}
                    onChange={e => setOrderDate(e.target.value)}
                    className={inputCls}
                    style={{ width: '180px' }}
                  />
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">预计到货日期</label>
                  <input
                    type="date"
                    value={expectedDate}
                    onChange={e => setExpectedDate(e.target.value)}
                    className={inputCls}
                    style={{ width: '180px' }}
                  />
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">币种</label>
                  <input
                    list="currency-options"
                    value={currency}
                    onChange={e => setCurrency(e.target.value.toUpperCase())}
                    className={inputCls}
                    style={{ width: '80px' }}
                  />
                  <datalist id="currency-options">
                    {COMMON_CURRENCIES.map(c => <option key={c} value={c} />)}
                  </datalist>
                  {currency !== 'EUR' && (
                    <div className="flex items-center gap-1 ml-3 text-xs text-gray-500">
                      <span>汇率→EUR</span>
                      <input
                        type="number" step="0.000001" min="0"
                        value={exchangeRate}
                        onChange={e => setExchangeRate(Number(e.target.value))}
                        className={`${numInputCls} w-20`}
                      />
                      {fxSource === 'unavailable' && (
                        <span className="text-amber-600">未取到实时汇率，请手动填</span>
                      )}
                      {fxSource === 'frankfurter' && <span className="text-gray-400">当日汇率</span>}
                    </div>
                  )}
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">运费（税前）</label>
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
              <p className="text-xs font-medium text-amber-700">PDF 识别到但系统里没有的商品，需要逐行新建：</p>
              {unmatchedExtractedLines.map((l, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-gray-700">
                    {l.productName} · 数量 {l.quantity ?? '—'} {l.uom ?? ''} · 单价 {l.unitCost ?? '—'}
                  </span>
                  <button
                    onClick={() => openQuickCreate({ name: l.productName, unitCost: l.unitCost, qty: l.quantity })}
                    className="hover:underline flex-shrink-0 ml-2"
                    style={{ color: PURPLE }}
                  >
                    新建商品并加入
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Product line table */}
          <div className="overflow-x-auto border-t border-gray-200">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr style={{ background: '#f8f8f8', borderBottom: '1px solid #e8e8e8' }}>
                  <th className="w-8 px-2 py-2.5" />
                  <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">商品</th>
                  <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">描述</th>
                  <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">数量</th>
                  <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">单位</th>
                  <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">单价</th>
                  <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">税率%</th>
                  <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">Best Before</th>
                  <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">小计</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.id} className="border-b border-gray-100 hover:bg-blue-50/30 transition-colors">
                    <td className="px-2 py-2.5 text-center">
                      <button onClick={() => deleteLine(l.id)} className="text-red-400 hover:text-red-600" title="删除此行">
                        <Trash2 className="h-3.5 w-3.5 inline" />
                      </button>
                    </td>
                    <td className="px-4 py-2.5 font-medium" style={{ color: PURPLE }}>{l.productName}</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs max-w-[180px] truncate">{l.spec || ''}</td>
                    <td className="px-4 py-2.5 text-right">
                      <input type="number" step="0.001" min="0"
                        className={numInputCls} style={{ width: '80px' }}
                        value={Number(l.orderedQty)}
                        onChange={e => updateLine(i, 'orderedQty', Number(e.target.value))} />
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{l.uomName || '—'}</td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <input type="number" step="0.01" min="0"
                          className={numInputCls} style={{ width: '90px' }}
                          value={Number(l.unitCost)}
                          onChange={e => updateLine(i, 'unitCost', Number(e.target.value))} />
                        <button
                          onClick={() => setPriceHistoryTarget({ id: l.productId, name: l.productName })}
                          title="查看价格历史"
                          className="text-gray-400 hover:text-gray-600 flex-shrink-0"
                        >
                          <TrendingUp className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <input type="number" step="0.1" min="0"
                        className={numInputCls} style={{ width: '60px' }}
                        value={Number(l.taxRate)}
                        onChange={e => updateLine(i, 'taxRate', Number(e.target.value))} />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <input type="date"
                        className={`${numInputCls} text-xs`} style={{ width: '120px' }}
                        value={l.bestBefore ?? ''}
                        onChange={e => updateBestBefore(i, e.target.value)} />
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-gray-800">
                      {l.subtotalExTax.toFixed(2)}
                      {freightAmount > 0 && (
                        <div className="text-[10px] font-normal text-gray-400">
                          落地单价 {landedCosts[i]?.landedUnitCost.toFixed(2)}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {lines.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-gray-400 text-sm">暂无明细行，从下面搜索添加商品</td>
                  </tr>
                )}
                <tr>
                  <td className="px-2 py-2" />
                  <td className="px-2 py-2" colSpan={7}>
                    <div className="flex items-center gap-2">
                      <ProductSearchInput
                        value={productQuery}
                        onChange={setProductQuery}
                        onSelect={p => { addProductLine(p); setProductQuery('') }}
                        products={purchaseProducts}
                        placeholder="搜索并添加商品…"
                        inputClassName="border border-dashed border-gray-300 rounded px-3 py-1.5 text-sm text-gray-500 focus:outline-none focus:border-purple-400 bg-transparent w-64"
                        portalDropdown
                      />
                      <button
                        onClick={() => openQuickCreate()}
                        className="text-xs whitespace-nowrap hover:underline"
                        style={{ color: PURPLE }}
                      >
                        找不到？新建商品
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="border-t border-gray-200 px-6 py-5 flex justify-end">
            <div style={{ minWidth: '280px' }}>
              <div className="flex justify-between py-1 text-sm">
                <span className="text-gray-500">税前金额</span>
                <span className="text-gray-800 font-medium">{subtotalExTax.toFixed(2)}</span>
              </div>
              <div className="flex justify-between py-1 text-sm">
                <span className="text-gray-500">税额</span>
                <span className="text-gray-800">{totalTax.toFixed(2)}</span>
              </div>
              <div className="border-t border-gray-300 mt-1 pt-2 flex justify-between">
                <span className="text-sm font-semibold" style={{ color: DARK }}>合计</span>
                <span className="text-base font-bold" style={{ color: DARK }}>{totalIncTax.toFixed(2)}</span>
              </div>
              {freightAmount > 0 && (
                <div className="flex justify-between py-1 text-sm border-t border-gray-100 mt-1 pt-2">
                  <span className="text-gray-500">落地成本（含运费 {totalAllocatedFreight.toFixed(2)}）</span>
                  <span className="text-gray-800 font-medium">{(subtotalExTax + totalAllocatedFreight).toFixed(2)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Notes */}
          <div className="border-t border-gray-200 px-6 py-5">
            <label className="block text-sm text-gray-500 mb-1.5">备注</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="内部备注..."
              className={`w-full ${inputCls} resize-none`}
              style={{ maxWidth: '520px' }}
            />
          </div>
        </div>
      </div>

      {showQuickCreate && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-800">新建商品</h2>
            <p className="text-xs text-gray-400">先建最小信息用于本次采购；默认不可销售，之后可在商品库补全销售价/税率/图片再上架。</p>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">商品名称</label>
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
                <label className="block text-xs font-medium text-gray-500 mb-1">分类</label>
                <select
                  value={qcCategoryId}
                  onChange={e => setQcCategoryId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                >
                  <option value="">未分类</option>
                  {categories.map(c => (
                    <option key={c.id} value={c.id}>{c.nameZh || c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">采购单位</label>
                <select
                  value={qcUomId}
                  onChange={e => setQcUomId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                >
                  <option value="">未指定</option>
                  {uoms.map(u => (
                    <option key={u.id} value={u.id}>{u.nameZh || u.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">参考采购单价（可选）</label>
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
                取消
              </button>
              <button
                onClick={submitQuickCreate}
                disabled={qcSubmitting}
                className="flex-1 py-2 rounded text-sm text-white disabled:opacity-50"
                style={{ background: PURPLE }}
              >
                {qcSubmitting ? '创建中…' : '创建并加入采购行'}
              </button>
            </div>
          </div>
        </div>
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
