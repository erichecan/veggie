'use client'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiUpload } from '@/lib/api'

const PURPLE = '#875A7B'

export interface ExtractedLine {
  productName: string
  quantity: number | null
  unitCost: number | null
  uom: string | null
}

export interface PdfExtractResult {
  sourceDocumentUrl: string
  sourceDocumentName: string
  supplierGuess: string | null
  currencyGuess: string | null
  lines: ExtractedLine[]
}

interface ExtractApiResponse {
  sourceDocumentUrl: string
  sourceDocumentName: string
  rawText: string
  structured: { supplierGuess: string | null; currencyGuess: string | null; lines: ExtractedLine[]; translationNote: string | null } | null
  aiUnavailable: boolean
  error?: string
}

/** 采购单新建页"上传 PDF 识别"入口：上传→抽取→人工核对后再"应用到表单"，识别结果不自动提交 */
export default function PdfExtractDialog({ onApply }: { onApply: (result: PdfExtractResult) => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<ExtractApiResponse | null>(null)
  const [editableLines, setEditableLines] = useState<ExtractedLine[]>([])

  async function handleFileChosen(file: File) {
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await apiUpload<ExtractApiResponse>('/api/purchase-orders/pdf-extract', form)
      setResult(res)
      setEditableLines(res.structured?.lines ?? [])
      if (res.error) toast.warning(res.error)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'PDF 识别失败')
    } finally {
      setUploading(false)
    }
  }

  function updateLine(i: number, field: keyof ExtractedLine, value: string) {
    setEditableLines(prev => {
      const next = [...prev]
      const raw = field === 'quantity' || field === 'unitCost' ? (value === '' ? null : Number(value)) : value
      next[i] = { ...next[i], [field]: raw } as ExtractedLine
      return next
    })
  }

  function apply() {
    if (!result) return
    onApply({
      sourceDocumentUrl: result.sourceDocumentUrl,
      sourceDocumentName: result.sourceDocumentName,
      supplierGuess: result.structured?.supplierGuess ?? null,
      currencyGuess: result.structured?.currencyGuess ?? null,
      lines: editableLines,
    })
    setResult(null)
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFileChosen(f) }}
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="h-8 px-3 text-sm rounded border font-medium hover:bg-gray-50 disabled:opacity-50"
        style={{ borderColor: PURPLE, color: PURPLE }}
      >
        {uploading ? '识别中…' : '📄 上传 PDF 识别'}
      </button>

      {result && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl p-6 space-y-4 max-h-[85vh] overflow-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-800">识别结果核对</h2>
              <button onClick={() => setResult(null)} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
            </div>
            <p className="text-xs text-gray-400">
              请核对下方内容后再应用到表单——识别结果不会自动保存，你可以直接在这里修改。
            </p>

            {result.aiUnavailable && (
              <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-700">
                尚未配置 AI 识别（缺少 ANTHROPIC_API_KEY），下面是 PDF 原始文字，请手动核对填入表单。
              </div>
            )}

            {result.structured ? (
              <div className="space-y-2">
                <div className="flex gap-6 text-sm">
                  <span>供应商推测：<b>{result.structured.supplierGuess ?? '—'}</b></span>
                  <span>币种推测：<b>{result.structured.currencyGuess ?? '—'}</b></span>
                </div>
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-gray-400 border-b border-gray-200">
                      <th className="text-left font-normal py-1">商品名称（已译英文）</th>
                      <th className="text-right font-normal py-1 w-20">数量</th>
                      <th className="text-left font-normal py-1 w-20">单位</th>
                      <th className="text-right font-normal py-1 w-24">单价</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editableLines.map((l, i) => (
                      <tr key={i} className="border-b border-gray-100">
                        <td className="py-1 pr-2">
                          <input className="w-full border-b border-transparent hover:border-gray-300 focus:border-blue-400 outline-none"
                            value={l.productName} onChange={e => updateLine(i, 'productName', e.target.value)} />
                        </td>
                        <td className="py-1 text-right">
                          <input type="number" className="w-full text-right border-b border-transparent hover:border-gray-300 focus:border-blue-400 outline-none"
                            value={l.quantity ?? ''} onChange={e => updateLine(i, 'quantity', e.target.value)} />
                        </td>
                        <td className="py-1">
                          <input className="w-full border-b border-transparent hover:border-gray-300 focus:border-blue-400 outline-none"
                            value={l.uom ?? ''} onChange={e => updateLine(i, 'uom', e.target.value)} />
                        </td>
                        <td className="py-1 text-right">
                          <input type="number" className="w-full text-right border-b border-transparent hover:border-gray-300 focus:border-blue-400 outline-none"
                            value={l.unitCost ?? ''} onChange={e => updateLine(i, 'unitCost', e.target.value)} />
                        </td>
                      </tr>
                    ))}
                    {editableLines.length === 0 && (
                      <tr><td colSpan={4} className="py-4 text-center text-gray-400">未识别到明细行</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <textarea
                readOnly
                value={result.rawText}
                rows={12}
                className="w-full border border-gray-200 rounded p-2 text-xs font-mono text-gray-600"
              />
            )}

            <div className="flex gap-2 pt-2">
              <button onClick={() => setResult(null)} className="flex-1 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">
                取消
              </button>
              <button
                onClick={apply}
                disabled={editableLines.length === 0}
                className="flex-1 py-2 rounded text-sm text-white disabled:opacity-50"
                style={{ background: PURPLE }}
              >
                应用到表单
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
