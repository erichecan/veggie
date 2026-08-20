'use client'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiUpload } from '@/lib/api'

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
}

const CONFIDENCE_STYLE: Record<ExtractedLine['confidence'], string> = {
  exact: 'bg-green-100 text-green-700',
  strong: 'bg-green-50 text-green-600',
  weak: 'bg-yellow-100 text-yellow-700',
  none: 'bg-red-100 text-red-600',
}

/**
 * 采购单新建页「上传单据识别」入口。
 *
 * ⛔ 识别结果**不自动保存**，必须逐行核对后点「应用到表单」。
 * 这不是谨慎过头 —— 被替换掉的那条旧路径就是识别完直接建单，
 * 实测把 `Harvest Beans` 配成了库里的垃圾商品 `vest` 并落了库。
 */
export default function PdfExtractDialog({ onApply }: { onApply: (result: PdfExtractResult) => void }) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<ParseApiResponse | null>(null)
  const [editableLines, setEditableLines] = useState<ExtractedLine[]>([])

  async function handleFileChosen(file: File) {
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await apiUpload<ParseApiResponse>('/api/purchase-orders/parse', form)
      setResult(res)
      setEditableLines(res.lines ?? [])
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

  /** 人工改选匹配商品：选中后置信度记为 exact —— 人挑的就是准的 */
  function pickProduct(i: number, productId: string) {
    setEditableLines(prev => {
      const next = [...prev]
      const line = next[i]
      const hit = line.candidates.find(c => c.id === productId)
      next[i] = {
        ...line,
        matchedProductId: hit ? hit.id : null,
        matchedProductName: hit ? hit.name : null,
        confidence: hit ? 'exact' : 'none',
        ambiguous: false,
      }
      return next
    })
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
        accept=".pdf,.xlsx,.xls,.csv,application/pdf"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFileChosen(f) }}
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="h-8 px-3 text-sm rounded border font-medium hover:bg-gray-50 disabled:opacity-50"
        style={{ borderColor: PURPLE, color: PURPLE }}
      >
        {uploading
          ? (isEn ? 'Extracting…' : '识别中…')
          : (isEn ? '📄 Upload PDF / Excel' : '📄 上传单据识别')}
      </button>

      {result && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl p-6 space-y-4 max-h-[85vh] overflow-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-800">{isEn ? 'Review extraction result' : '识别结果核对'}</h2>
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
                        {l.candidates.length > 0 ? (
                          <select
                            value={l.matchedProductId ?? ''}
                            onChange={e => pickProduct(i, e.target.value)}
                            className={`w-full border rounded px-1 py-0.5 text-xs ${l.matchedProductId ? 'border-gray-300' : 'border-red-300 bg-red-50'}`}
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
                          <span className={`inline-block px-1.5 py-0.5 rounded ${CONFIDENCE_STYLE.none}`}>
                            {isEn ? 'no candidate — create later' : '无候选，稍后新建'}
                          </span>
                        )}
                        {l.matchedProductId && (
                          <span className={`ml-1 inline-block px-1.5 py-0.5 rounded ${CONFIDENCE_STYLE[l.confidence]}`}>
                            {l.confidence === 'exact' ? (isEn ? 'Exact' : '精确')
                              : l.confidence === 'strong' ? (isEn ? 'Strong' : '较可靠')
                                : (isEn ? 'Weak — verify' : '存疑，请核对')}
                          </span>
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
                  {isEn
                    ? 'No line items were recognised. The raw text below is what we read from the document — please fill the form manually.'
                    : '未识别到明细行。下面是从单据里读到的原始文字，请手动填入表单。'}
                </p>
                <textarea
                  readOnly
                  value={result.rawText}
                  rows={12}
                  className="w-full border border-gray-200 rounded p-2 text-xs font-mono text-gray-600"
                />
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
