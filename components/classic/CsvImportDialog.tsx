'use client'
import { useRef, useState, type ReactNode } from 'react'
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

interface ImportResult {
  created: number
  skipped: string[]
  /** 单行失败(带原因)——端点返回了才显示 */
  failed?: string[]
  warnings?: string[]
  /** 分批提交时某一批请求整体失败的说明 */
  batchError?: string
}

/**
 * 通用 CSV 批量导入对话框:下载模板 → 选文件 → 预览 → 提交 bulk API。
 * 表头按 label 或 key 匹配(不区分大小写),多余列忽略。
 */
export default function CsvImportDialog({
  open, onClose, title, columns, templateName, endpoint, onDone, note, batchSize, skippedLabel,
}: {
  open: boolean
  onClose: () => void
  title: string
  columns: CsvColumn[]
  templateName: string
  endpoint: string
  onDone?: () => void
  /** 表头说明下方的额外提示(格式/规则说明) */
  note?: ReactNode
  /** 传了就按这个行数分批顺序提交(带 rowOffset)，文件行数不受单次请求上限约束 */
  batchSize?: number
  /** "跳过"那一行的文案；默认是"重名跳过" */
  skippedLabel?: { zh: string; en: string }
}) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const fileRef = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
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
    setProgress(0)
    try {
      if (!batchSize) {
        const r = await apiPost<ImportResult>(endpoint, { rows })
        setResult(r)
        toast.success(isEn ? `Import finished: ${r.created} created, ${r.skipped.length} skipped` : `导入完成:成功 ${r.created} 条,跳过 ${r.skipped.length} 条`)
        onDone?.()
        return
      }
      // 分批顺序提交：某一批整体失败就停下并说明哪些行已进去(逐行提交的端点重导是安全的)
      let created = 0
      const skipped: string[] = []
      const failed: string[] = []
      const warnings: string[] = []
      let batchError: string | undefined
      for (let start = 0; start < rows.length; start += batchSize) {
        const end = Math.min(start + batchSize, rows.length)
        try {
          const r = await apiPost<ImportResult>(endpoint, { rows: rows.slice(start, end), rowOffset: start })
          created += r.created
          skipped.push(...r.skipped)
          failed.push(...(r.failed ?? []))
          warnings.push(...(r.warnings ?? []))
        } catch (e) {
          const reason = e instanceof Error ? e.message : (isEn ? 'request failed' : '请求失败')
          batchError = isEn
            ? `Rows ${start + 1}–${end} failed (${reason}); rows 1–${start} were imported, rows after ${end} were not submitted.`
            : `第 ${start + 1}–${end} 行这一批失败(${reason});第 1–${start} 行已导入,第 ${end} 行之后未提交。`
          break
        }
        setProgress(end)
      }
      setResult({ created, skipped, failed, warnings, batchError })
      const summary = isEn
        ? `${created} created, ${skipped.length} skipped, ${failed.length} failed`
        : `成功 ${created} 条,跳过 ${skipped.length} 条,失败 ${failed.length} 条`
      if (batchError) toast.error(isEn ? `Import stopped: ${summary}` : `导入中断:${summary}`)
      else if (failed.length > 0) toast.warning(isEn ? `Import finished with errors: ${summary}` : `导入完成(有失败行):${summary}`)
      else toast.success(isEn ? `Import finished: ${summary}` : `导入完成:${summary}`)
      onDone?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Import failed' : '导入失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o && !busy) { reset(); onClose() } }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {/* min-w-0: DialogContent 是 grid，子项默认按内容撑宽不收缩，列多的预览表格
            会撑破弹窗边界溢出到遮罩层上而不是在弹窗内横向滚动（20260930 商品导入
            实测复现）。这里列少还没复现，防御性地一并修，避免以后加列时同样的坑。 */}
        <div className="space-y-3 text-sm min-w-0">
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

          {note && (
            <div className="text-xs text-gray-500 bg-purple-50/50 border border-purple-100 rounded-lg px-3 py-2">{note}</div>
          )}

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
                    ? <>⚠ {skippedLabel?.en ?? 'Skipped duplicates'} ({result.skipped.length}): {result.skipped.slice(0, 10).join(', ')}{result.skipped.length > 10 ? '…' : ''}</>
                    : <>⚠ {skippedLabel?.zh ?? '重名跳过'} {result.skipped.length} 条:{result.skipped.slice(0, 10).join('、')}{result.skipped.length > 10 ? '…' : ''}</>}
                </span>
              )}
              {result.batchError && (
                <div className="mt-2 border border-red-200 bg-red-50 rounded px-2 py-1.5 text-red-700">⛔ {result.batchError}</div>
              )}
              {result.failed && result.failed.length > 0 && (
                <div className="mt-2">
                  <div className="text-red-700 mb-1">
                    {isEn
                      ? `⛔ ${result.failed.length} rows failed (not imported; all other rows were imported):`
                      : `⛔ ${result.failed.length} 行导入失败(这些行没进去,其它行已正常导入):`}
                  </div>
                  <ul className="max-h-40 overflow-y-auto bg-white border border-red-200 rounded px-2 py-1.5 space-y-0.5 text-red-700">
                    {result.failed.map((f, i) => <li key={i}>· {f}</li>)}
                  </ul>
                </div>
              )}
              {result.warnings && result.warnings.length > 0 && (
                <div className="mt-2">
                  <div className="text-amber-700 mb-1">{isEn ? `⚠ ${result.warnings.length} warnings:` : `⚠ ${result.warnings.length} 条提示:`}</div>
                  <ul className="max-h-32 overflow-y-auto bg-white border border-amber-200 rounded px-2 py-1.5 space-y-0.5 text-amber-800">
                    {result.warnings.map((w, i) => <li key={i}>· {w}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => { reset(); onClose() }}>{result ? (isEn ? 'Close' : '关闭') : (isEn ? 'Cancel' : '取消')}</Button>
          {!result && (
            <Button disabled={busy || rows.length === 0} onClick={submit}>
              {busy
                ? (batchSize
                    ? (isEn ? `Importing… ${progress}/${rows.length}` : `导入中… ${progress}/${rows.length}`)
                    : (isEn ? 'Importing…' : '导入中…'))
                : (isEn ? `Import ${rows.length} rows` : `导入 ${rows.length} 行`)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
