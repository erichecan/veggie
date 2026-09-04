'use client'
import { useRef, useState } from 'react'
import { useLocale } from 'next-intl'
import { toast } from 'sonner'
import { routing } from '@/i18n/routing'
import { apiPost } from '@/lib/api'
import { downloadCsv, parseCsv } from '@/lib/csv-export'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'

export interface CsvColumn {
  key: string      // 提交给 API 的字段名,同时也是表头别名之一
  label: string    // 中文表头(模板里用)
  required?: boolean
}

interface ImportResult { created: number; skipped: string[] }

/**
 * 通用 CSV 批量导入对话框:下载模板 → 选文件 → 预览 → 提交 bulk API。
 * 表头按 label 或 key 匹配(不区分大小写),多余列忽略。
 */
export default function CsvImportDialog({
  open, onClose, title, columns, templateName, endpoint, onDone,
}: {
  open: boolean
  onClose: () => void
  title: string
  columns: CsvColumn[]
  templateName: string
  endpoint: string
  onDone?: () => void
}) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const fileRef = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  function reset() {
    setRows([]); setFileName(''); setResult(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  function downloadTemplate() {
    downloadCsv(templateName, columns.map(c => c.label), [
      columns.map(c => (c.required ? (isEn ? '(required)' : '(必填)') : '')),
    ])
  }

  async function pickFile(file: File) {
    const text = await file.text()
    const parsed = parseCsv(text)
    if (parsed.length < 2) {
      toast.error(isEn ? 'File needs a header row plus at least 1 data row' : '文件至少需要表头 + 1 行数据')
      return
    }
    const header = parsed[0].map(h => h.trim().toLowerCase())
    const colIdx = new Map<string, number>()
    for (const c of columns) {
      const idx = header.findIndex(h => h === c.label.toLowerCase() || h === c.key.toLowerCase())
      if (idx >= 0) colIdx.set(c.key, idx)
    }
    const missing = columns.filter(c => c.required && !colIdx.has(c.key))
    if (missing.length > 0) {
      toast.error(isEn ? `Missing required columns: ${missing.map(c => c.label).join(', ')}` : `缺少必填列:${missing.map(c => c.label).join('、')}`)
      return
    }
    const dataRows = parsed.slice(1)
      .map(r => {
        const obj: Record<string, string> = {}
        for (const [key, idx] of colIdx) {
          const v = (r[idx] ?? '').trim()
          if (v) obj[key] = v
        }
        return obj
      })
      .filter(o => Object.values(o).some(v => v && v !== '(必填)' && v !== '(required)'))
    if (dataRows.length === 0) {
      toast.error(isEn ? 'No valid data rows' : '没有有效数据行')
      return
    }
    setFileName(file.name)
    setRows(dataRows)
    setResult(null)
  }

  async function submit() {
    setBusy(true)
    try {
      const r = await apiPost<ImportResult>(endpoint, { rows })
      setResult(r)
      toast.success(isEn ? `Import finished: ${r.created} created, ${r.skipped.length} skipped` : `导入完成:成功 ${r.created} 条,跳过 ${r.skipped.length} 条`)
      onDone?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Import failed' : '导入失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) { reset(); onClose() } }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
            <span className="text-xs text-gray-600">
              {isEn
                ? `Row 1 is the header, columns: ${columns.map(c => c.label + (c.required ? '*' : '')).join(', ')}`
                : `第一行为表头,列名:${columns.map(c => c.label + (c.required ? '*' : '')).join('、')}`}
            </span>
            <button onClick={downloadTemplate} className="text-xs text-purple-700 hover:underline whitespace-nowrap ml-2">
              {isEn ? '⬇ Download template' : '⬇ 下载模板'}
            </button>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={e => { const f = e.target.files?.[0]; if (f) pickFile(f) }}
            className="block w-full text-sm text-gray-600 file:mr-3 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-purple-50 file:text-purple-700 file:text-sm hover:file:bg-purple-100"
          />

          {rows.length > 0 && !result && (
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-600">
                {isEn
                  ? <>{fileName} · <b>{rows.length}</b> rows total, previewing first 5</>
                  : <>{fileName} · 共 <b>{rows.length}</b> 行,预览前 5 行</>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {columns.filter(c => rows.some(r => r[c.key])).map(c => (
                        <th key={c.key} className="text-left px-2 py-1.5 text-gray-500 whitespace-nowrap">{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {rows.slice(0, 5).map((r, i) => (
                      <tr key={i}>
                        {columns.filter(c => rows.some(rr => rr[c.key])).map(c => (
                          <td key={c.key} className="px-2 py-1.5 text-gray-700 whitespace-nowrap max-w-40 truncate">{r[c.key] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result && (
            <div className="border border-green-200 bg-green-50 rounded-lg px-3 py-2 text-xs text-green-800">
              {isEn ? <>✅ Successfully imported <b>{result.created}</b> rows</> : <>✅ 成功导入 <b>{result.created}</b> 条</>}
              {result.skipped.length > 0 && (
                <span className="block mt-1 text-amber-700">
                  {isEn
                    ? <>⚠ Skipped {result.skipped.length} duplicates: {result.skipped.slice(0, 10).join(', ')}{result.skipped.length > 10 ? '…' : ''}</>
                    : <>⚠ 重名跳过 {result.skipped.length} 条:{result.skipped.slice(0, 10).join('、')}{result.skipped.length > 10 ? '…' : ''}</>}
                </span>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose() }}>{result ? (isEn ? 'Close' : '关闭') : (isEn ? 'Cancel' : '取消')}</Button>
          {!result && (
            <Button disabled={busy || rows.length === 0} onClick={submit}>
              {busy ? (isEn ? 'Importing…' : '导入中…') : (isEn ? `Import ${rows.length} rows` : `导入 ${rows.length} 行`)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
