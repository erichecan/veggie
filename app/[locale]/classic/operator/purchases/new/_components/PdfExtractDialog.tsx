'use client'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiPost, apiUpload } from '@/lib/api'
import ProductSearchInput from '@/components/classic/ProductSearchInput'

const PURPLE = '#875A7B'

export interface MatchCandidate {
  id: string
  name: string
  score: number
}

export interface ExtractedLine {
  productName: string
  quantity: number | null
  unitCost: number | null
  uom: string | null
  raw?: string
  /** 后端匹配结果；歧义或未命中时为 null，必须由人挑 */
  matchedProductId: string | null
  matchedProductName: string | null
  confidence: 'exact' | 'strong' | 'weak' | 'none'
  candidates: MatchCandidate[]
  ambiguous: boolean
  /** true = 命中「原文→商品」记忆表（此前有人手动挑过这个写法），而不是本次现算的 */
  fromAlias: boolean
}

export interface AliasProduct {
  id: string
  name: string
  internalRef?: string | null
  category?: string | null
}

export interface PdfExtractResult {
  sourceDocumentUrl: string | null
  sourceDocumentName: string
  supplierId: string | null
  supplierName: string | null
  currency: string | null
  lines: ExtractedLine[]
}

interface ParseApiResponse {
  sourceDocumentUrl: string | null
  sourceDocumentName: string
  rawText: string
  currency: string | null
  supplierId: string | null
  supplierName: string | null
  lines: ExtractedLine[]
  stats: { total: number; exact: number; strong: number; weak: number; none: number; ambiguous: number } | null
  error?: string | null
  /** 实际生效的解析路径——engine=ai 但未配置 key / 调用失败时会回退到 deterministic */
  engineUsed?: 'ai' | 'deterministic'
}

const CONFIDENCE_STYLE: Record<ExtractedLine['confidence'], string> = {
  exact: 'bg-green-100 text-green-700',
  strong: 'bg-green-50 text-green-600',
  weak: 'bg-yellow-100 text-yellow-700',
  none: 'bg-red-100 text-red-600',
}
const ALIAS_STYLE = 'bg-purple-100 text-purple-700'

/**
 * 采购单新建页「上传单据识别」入口。
 *
 * ⛔ 识别结果**不自动保存**，必须逐行核对后点「应用到表单」。
 * 这不是谨慎过头 —— 被替换掉的那条旧路径就是识别完直接建单，
 * 实测把 `Harvest Beans` 配成了库里的垃圾商品 `vest` 并落了库。
 */
export default function PdfExtractDialog({ onApply, products }: {
  onApply: (result: PdfExtractResult) => void
  /** 供「搜索其他商品」用的全量可采购商品；人工挑中即记住原文对照，见下 applyMatch */
  products: AliasProduct[]
}) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const fileInputRef = useRef<HTMLInputElement>(null)
  // ⛔ 原生「打开文件」对话框弹出到用户真正选完/取消之间有一段人眼能感知的延迟——
  // 这期间按钮一直是可点的。用户以为没反应而连点两三下，Chrome/系统会真的一次
  // 弹出好几个叠在一起的对话框，选中最上面那个也像「选了没反应」（其余的还悬在那）。
  // 用这个标记把「已经弹出一个、还没等到结果」这段时间内的按钮点击挡掉。
  const [pickerOpen, setPickerOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  // 20260902：AI 识别（Gemini，支持拍照单据）已转正为默认；勾掉才退回旧的规则解析
  const [useAi, setUseAi] = useState(true)
  const [result, setResult] = useState<ParseApiResponse | null>(null)
  const [editableLines, setEditableLines] = useState<ExtractedLine[]>([])
  const [searchingIndex, setSearchingIndex] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  /** 识别出的原文，永远不随人工编辑 productName 而变——记忆表要记的是「单据本来写的什么」 */
  const originalNamesRef = useRef<string[]>([])

  // 用户点「取消」不选文件时，原生 input 只会触发 cancel、不会触发 change——
  // 不接这个事件，pickerOpen 就会卡 true，取消一次以后这颗按钮就再也点不动了。
  // 另外接一道 window focus 兜底（浏览器太老、不认 cancel 事件时用得上）：
  // 原生文件对话框开着的时候页面拿不到焦点，它一关，焦点必然还给页面。
  useEffect(() => {
    const el = fileInputRef.current
    const onCancel = () => setPickerOpen(false)
    const onFocus = () => setTimeout(() => setPickerOpen(false), 150)
    el?.addEventListener('cancel', onCancel)
    window.addEventListener('focus', onFocus)
    return () => {
      el?.removeEventListener('cancel', onCancel)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  async function handleFileChosen(file: File) {
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      // 图片（拍照单据）没有确定性解析可用，不管开关状态都必须走 AI
      const isImageFile = file.type.startsWith('image/') || /\.(jpe?g|png)$/i.test(file.name)
      if (isImageFile && !useAi) toast.info(isEn ? 'Images can only use AI recognition' : '图片仅支持 AI 识别，已自动改用 AI')
      form.append('engine', (isImageFile || useAi) ? 'ai' : 'deterministic')
      const res = await apiUpload<ParseApiResponse>('/api/purchase-orders/parse', form)
      setResult(res)
      setEditableLines(res.lines ?? [])
      originalNamesRef.current = (res.lines ?? []).map(l => l.productName)
      if (res.error) toast.warning(res.error)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Extraction failed' : '识别失败'))
    } finally {
      setUploading(false)
    }
  }

  function updateLine(i: number, field: 'productName' | 'quantity' | 'unitCost' | 'uom', value: string) {
    setEditableLines(prev => {
      const next = [...prev]
      const raw = field === 'quantity' || field === 'unitCost' ? (value === '' ? null : Number(value)) : value
      next[i] = { ...next[i], [field]: raw } as ExtractedLine
      return next
    })
  }

  /** 清空匹配，回到「未匹配，稍后新建」 */
  function clearMatch(i: number) {
    setEditableLines(prev => {
      const next = [...prev]
      next[i] = { ...next[i], matchedProductId: null, matchedProductName: null, confidence: 'none', ambiguous: false, fromAlias: false }
      return next
    })
  }

  /**
   * 人工选中商品（下拉候选或搜索均走这里）：置信度记为 exact —— 人挑的就是准的；
   * 同时把「单据原文 → 这个商品」记住（后台异步，不挡 UI），下次同样写法直接精确命中。
   */
  function applyMatch(i: number, product: { id: string; name: string }) {
    setEditableLines(prev => {
      const next = [...prev]
      next[i] = { ...next[i], matchedProductId: product.id, matchedProductName: product.name, confidence: 'exact', ambiguous: false, fromAlias: false }
      return next
    })
    setSearchingIndex(null)
    setSearchQuery('')
    const rawName = originalNamesRef.current[i]
    if (rawName) {
      apiPost('/api/purchase-orders/product-aliases', { rawName, productId: product.id }).catch(() => {})
    }
  }

  function apply() {
    if (!result) return
    onApply({
      sourceDocumentUrl: result.sourceDocumentUrl,
      sourceDocumentName: result.sourceDocumentName,
      supplierId: result.supplierId,
      supplierName: result.supplierName,
      currency: result.currency,
      lines: editableLines,
    })
    setResult(null)
  }

  const matchedCount = editableLines.filter(l => l.matchedProductId).length
  const needsAttention = editableLines.length - matchedCount

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.xlsx,.xls,.csv,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        className="hidden"
        onChange={e => {
          setPickerOpen(false)
          const f = e.target.files?.[0]
          // 清空 value：不然连续两次选同一个文件，第二次 change 不会触发
          e.target.value = ''
          if (f) handleFileChosen(f)
        }}
      />
      <span className="inline-flex items-center gap-2">
        <button
          onClick={() => {
            if (pickerOpen || uploading) return
            setPickerOpen(true)
            fileInputRef.current?.click()
          }}
          disabled={uploading || pickerOpen}
          className="h-8 px-3 text-sm rounded border font-medium hover:bg-gray-50 disabled:opacity-50"
          style={{ borderColor: PURPLE, color: PURPLE }}
        >
          {uploading
            ? (isEn ? 'Extracting…' : '识别中…')
            : (isEn ? '📄 Upload document (PDF / Photo / Excel)' : '📄 上传单据识别（PDF/拍照/Excel）')}
        </button>
        {/* 20260902：AI（Gemini）已转正为默认路径，见 lib/purchase/ai-pdf-parser.ts 与 parse/route.ts 顶部说明 */}
        <label className="inline-flex items-center gap-1 text-xs text-gray-500 cursor-pointer select-none" title={isEn ? 'Uncheck to use the old rule-based parser instead (text-layer PDF only, not sent anywhere)' : '取消勾选可改回旧的规则解析（仅支持文字版 PDF，不联网）'}>
          <input type="checkbox" checked={useAi} onChange={e => setUseAi(e.target.checked)} className="accent-purple-600" />
          {isEn ? 'AI recognition' : 'AI 识别'}
        </label>
      </span>

      {result && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl p-6 space-y-4 max-h-[85vh] overflow-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
                {isEn ? 'Review extraction result' : '识别结果核对'}
                {result.engineUsed === 'ai' && (
                  <span className="text-xs font-normal px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                    {isEn ? 'via AI' : 'AI 识别'}
                  </span>
                )}
              </h2>
              <button onClick={() => setResult(null)} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
            </div>
            <p className="text-xs text-gray-400">
              {isEn
                ? 'Nothing is saved yet. Review every line — especially those marked in red or yellow — then apply to the form.'
                : '此刻尚未保存任何数据。请逐行核对（尤其是标红/标黄的行）后再应用到表单。'}
            </p>

            {editableLines.length > 0 && (
              <div className="flex gap-4 text-xs">
                <span className="text-gray-500">{isEn ? 'Lines' : '识别行数'}：<b className="text-gray-800">{editableLines.length}</b></span>
                <span className="text-gray-500">{isEn ? 'Matched' : '已匹配'}：<b className="text-green-700">{matchedCount}</b></span>
                {needsAttention > 0 && (
                  <span className="text-gray-500">
                    {isEn ? 'Need attention' : '待处理'}：<b className="text-red-600">{needsAttention}</b>
                  </span>
                )}
              </div>
            )}

            <div className="flex gap-6 text-sm">
              <span>
                {isEn ? 'Supplier: ' : '供应商：'}
                <b>{result.supplierName ?? '—'}</b>
                {result.supplierName && !result.supplierId && (
                  <span className="ml-1 text-xs text-amber-600">
                    {isEn ? '(not in system, select manually)' : '（系统中无此供应商，请手动选择）'}
                  </span>
                )}
              </span>
              <span>{isEn ? 'Currency: ' : '币种：'}<b>{result.currency ?? '—'}</b></span>
            </div>

            {editableLines.length > 0 ? (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-200">
                    <th className="text-left font-normal py-1">{isEn ? 'Name on document' : '单据上的名称'}</th>
                    <th className="text-left font-normal py-1 w-64">{isEn ? 'Matched product' : '匹配到的商品'}</th>
                    <th className="text-right font-normal py-1 w-16">{isEn ? 'Qty' : '数量'}</th>
                    <th className="text-left font-normal py-1 w-16">{isEn ? 'Unit' : '单位'}</th>
                    <th className="text-right font-normal py-1 w-20">{isEn ? 'Unit price' : '单价'}</th>
                  </tr>
                </thead>
                <tbody>
                  {editableLines.map((l, i) => (
                    <tr key={i} className="border-b border-gray-100 align-top">
                      <td className="py-1 pr-2">
                        <input
                          className="w-full border-b border-transparent hover:border-gray-300 focus:border-blue-400 outline-none"
                          value={l.productName}
                          onChange={e => updateLine(i, 'productName', e.target.value)}
                        />
                      </td>
                      <td className="py-1 pr-2">
                        {searchingIndex === i ? (
                          <div className="flex items-center gap-1">
                            <div className="flex-1">
                              <ProductSearchInput
                                products={products}
                                value={searchQuery}
                                onChange={setSearchQuery}
                                onSelect={p => applyMatch(i, p)}
                                placeholder={isEn ? 'Search product…' : '搜索商品…'}
                                inputClassName="w-full border border-blue-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-blue-400"
                                portalDropdown
                                maxResults={8}
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => { setSearchingIndex(null); setSearchQuery('') }}
                              className="text-gray-400 hover:text-gray-600 flex-shrink-0"
                              title={isEn ? 'Cancel search' : '取消搜索'}
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-1">
                              {l.candidates.length > 0 ? (
                                <select
                                  value={l.matchedProductId ?? ''}
                                  onChange={e => {
                                    const id = e.target.value
                                    if (!id) { clearMatch(i); return }
                                    const hit = l.candidates.find(c => c.id === id)
                                    if (hit) applyMatch(i, hit)
                                  }}
                                  className={`flex-1 min-w-0 border rounded px-1 py-0.5 text-xs ${l.matchedProductId ? 'border-gray-300' : 'border-red-300 bg-red-50'}`}
                                >
                                  <option value="">
                                    {l.ambiguous
                                      ? (isEn ? '— multiple matches, please pick —' : '— 命中多个，请选择 —')
                                      : (isEn ? '— not matched, create later —' : '— 未匹配，稍后新建 —')}
                                  </option>
                                  {l.candidates.map(c => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                  ))}
                                </select>
                              ) : (
                                <span className={`flex-1 min-w-0 inline-block px-1.5 py-0.5 rounded ${CONFIDENCE_STYLE.none}`}>
                                  {isEn ? 'no candidate — create later' : '无候选，稍后新建'}
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() => { setSearchingIndex(i); setSearchQuery(l.productName) }}
                                className="text-gray-400 hover:text-blue-600 flex-shrink-0"
                                title={isEn ? 'Search another product' : '搜索其他商品'}
                              >
                                🔍
                              </button>
                            </div>
                            {l.matchedProductId && (
                              <span className={`mt-0.5 inline-block px-1.5 py-0.5 rounded ${l.fromAlias ? ALIAS_STYLE : CONFIDENCE_STYLE[l.confidence]}`}>
                                {l.fromAlias
                                  ? (isEn ? 'Remembered match' : '记忆匹配')
                                  : l.confidence === 'exact' ? (isEn ? 'Exact' : '精确')
                                    : l.confidence === 'strong' ? (isEn ? 'Strong' : '较可靠')
                                      : (isEn ? 'Weak — verify' : '存疑，请核对')}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="py-1 text-right">
                        <input
                          type="number"
                          className="w-full text-right border-b border-transparent hover:border-gray-300 focus:border-blue-400 outline-none"
                          value={l.quantity ?? ''}
                          onChange={e => updateLine(i, 'quantity', e.target.value)}
                        />
                      </td>
                      <td className="py-1">
                        <input
                          className="w-full border-b border-transparent hover:border-gray-300 focus:border-blue-400 outline-none"
                          value={l.uom ?? ''}
                          onChange={e => updateLine(i, 'uom', e.target.value)}
                        />
                      </td>
                      <td className="py-1 text-right">
                        <input
                          type="number"
                          className="w-full text-right border-b border-transparent hover:border-gray-300 focus:border-blue-400 outline-none"
                          value={l.unitCost ?? ''}
                          onChange={e => updateLine(i, 'unitCost', e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <>
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-3">
                  {result.rawText
                    ? (isEn
                      ? 'No line items were recognised. The raw text below is what we read from the document — please fill the form manually.'
                      : '未识别到明细行。下面是从单据里读到的原始文字，请手动填入表单。')
                    : (isEn
                      ? 'No line items were recognised, and there is no text to show (photos have no text layer) — please fill the form manually.'
                      : '未识别到明细行，且没有可展示的原文（图片没有文字层）——请手动填入表单。')}
                </p>
                {result.rawText && (
                  <textarea
                    readOnly
                    value={result.rawText}
                    rows={12}
                    className="w-full border border-gray-200 rounded p-2 text-xs font-mono text-gray-600"
                  />
                )}
              </>
            )}

            <div className="flex gap-2 pt-2">
              <button onClick={() => setResult(null)} className="flex-1 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">
                {isEn ? 'Cancel' : '取消'}
              </button>
              <button
                onClick={apply}
                disabled={editableLines.length === 0}
                className="flex-1 py-2 rounded text-sm text-white disabled:opacity-50"
                style={{ background: PURPLE }}
              >
                {isEn ? 'Apply to form' : '应用到表单'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
