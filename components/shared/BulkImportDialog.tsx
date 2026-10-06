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

/**
 * 全站通用批量导入对话框 —— 从 ProductImportDialog(20260930)抽出来的壳，各模块
 * 只传自己的列定义/示例行/接口地址/说明文案，循环控制(下载模板/解析/预览/分批提交/
 * 结果展示)统一在这里，行为与原商品导入弹窗逐一对应。
 */

export interface BulkImportColumn {
  /** CSV 表头文字，同时是下载模板时写入的表头 */
  label: string
  aliases?: string[]
  /** 提交给 API 的 JSON 字段名；不填 = 这一列只读/忽略，不参与提交 */
  key?: string
  required?: boolean
  /** 原始单元格文本 → API 期望的值；不填 = 原样传字符串(服务端自己再解析数字/布尔) */
  parse?: (raw: string) => string
}

export interface BulkImportResult {
  created: number
  updated: number
  skipped: string[]
  failed: string[]
  warnings: string[]
  batchError?: string
}

export interface BulkImportDialogProps {
  open: boolean
  onClose: () => void
  onDone?: () => void
  /** 下载模板的文件名(不带扩展名) */
  templateFileName: string
  columns: BulkImportColumn[]
  exampleRows: string[][]
  /** 批量导入接口地址，形如 /api/xxx/bulk */
  endpoint: string
  title: { zh: string; en: string }
  /** 顶部说明条文案(放在下载模板按钮旁) */
  hint: { zh: string; en: string }
  /** 可选的补充说明(放在文件选择框下方，如匹配规则/特殊格式说明) */
  extraHint?: { zh: React.ReactNode; en: React.ReactNode }
  /** 每批提交的行数，默认 100(见 ProductImportDialog 对 Neon/nginx 超时的注释) */
  batchSize?: number
}

export default function BulkImportDialog({
  open, onClose, onDone, templateFileName, columns, exampleRows, endpoint, title, hint, extraHint, batchSize = 100,
}: BulkImportDialogProps) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const fileRef = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<BulkImportResult | null>(null)

  const importableColumns = columns.filter((c): c is BulkImportColumn & { key: string } => !!c.key)

  function reset() {
    setRows([]); setFileName(''); setResult(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  function downloadTemplate() {
    downloadCsv(templateFileName, columns.map(c => c.label), exampleRows)
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
    for (const c of importableColumns) {
      // 表头既认 label(展示文案)也认 key(JSON 字段名)——旧的 CsvImportDialog(已删)本来
      // 两个都认，20261003 抽成这个通用组件时参照了商品弹窗的实现、漏掉了 key 这个回退，
      // 导致客户/供应商那种"表头直接写字段名"的历史文件(如 vatNumber/salesman)导入时
      // 整列静默对不上、没有任何报错提示(code review 发现)。
      const acceptedHeaders = [c.label, c.key, ...(c.aliases ?? [])].map(value => value.toLowerCase())
      const idx = header.findIndex(h => acceptedHeaders.includes(h))
      if (idx >= 0) colIdx.set(c.key, idx)
    }
    const missing = importableColumns.filter(c => c.required && !colIdx.has(c.key))
    if (missing.length > 0) {
      toast.error(isEn ? `Missing required columns: ${missing.map(c => c.label).join(', ')}` : `缺少必填列:${missing.map(c => c.label).join('、')}`)
      return
    }

    const dataRows = parsed.slice(1)
      .map(r => {
        const obj: Record<string, string> = {}
        for (const c of importableColumns) {
          const idx = colIdx.get(c.key)
          if (idx === undefined) continue
          const raw = (r[idx] ?? '').trim()
          if (!raw) continue
          obj[c.key] = c.parse ? c.parse(raw) : raw
        }
        return obj
      })
      .filter(o => Object.values(o).some(v => v))
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
    const total: BulkImportResult = { created: 0, updated: 0, skipped: [], failed: [], warnings: [] }
    try {
      for (let start = 0; start < rows.length; start += batchSize) {
        const end = Math.min(start + batchSize, rows.length)
        try {
          const r = await apiPost<BulkImportResult>(endpoint, { rows: rows.slice(start, end), rowOffset: start })
          total.created += r.created
          total.updated += r.updated
          total.skipped.push(...r.skipped)
          total.failed.push(...(r.failed ?? []))
          total.warnings.push(...r.warnings)
        } catch (e) {
          // 整批请求失败(断网/服务器挂了)就停下；服务端是逐行提交的，重新导入整个文件是安全的
          const reason = e instanceof Error ? e.message : (isEn ? 'request failed' : '请求失败')
          total.batchError = isEn
            ? `Rows ${start + 1}–${end} failed (${reason}); rows 1–${start} were imported, rows after ${end} were not submitted. This batch may be partially imported — it is safe to re-import the whole file.`
            : `第 ${start + 1}–${end} 行这一批失败(${reason});第 1–${start} 行已导入,第 ${end} 行之后未提交。这一批可能已部分写入——重新导入整个文件是安全的。`
          break
        }
        setProgress(end)
      }
      setResult(total)
      const summary = isEn
        ? `${total.created} created, ${total.updated} updated, ${total.skipped.length} skipped, ${total.failed.length} failed`
        : `新建 ${total.created},更新 ${total.updated},跳过 ${total.skipped.length},失败 ${total.failed.length}`
      if (total.batchError) toast.error(isEn ? `Import stopped: ${summary}` : `导入中断:${summary}`)
      else if (total.failed.length > 0) toast.warning(isEn ? `Import finished with errors: ${summary}` : `导入完成(有失败行):${summary}`)
      else toast.success(isEn ? `Import finished: ${summary}` : `导入完成:${summary}`)
      onDone?.()
    } finally {
      setBusy(false)
    }
  }

  const previewColumns = importableColumns.filter(c => rows.some(r => r[c.key]))

  return (
    // 导入进行中不让关：分批提交的循环还在跑，关掉弹窗会让人以为停了，其实后面几批照样在写库
    <Dialog open={open} onOpenChange={o => { if (!o && !busy) { reset(); onClose() } }}>
      <DialogContent className="max-w-[95vw] sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{isEn ? title.en : title.zh}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm min-w-0">
          <div className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
            <span className="text-xs text-gray-600">{isEn ? hint.en : hint.zh}</span>
            <button onClick={downloadTemplate} className="text-xs text-purple-700 hover:underline whitespace-nowrap ml-2">
              {isEn ? '⬇ Download template' : '⬇ 下载模板'}
            </button>
          </div>

          {extraHint && (
            <div className="text-xs text-gray-500 bg-purple-50/50 border border-purple-100 rounded-lg px-3 py-2">
              {isEn ? extraHint.en : extraHint.zh}
            </div>
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
              <div className="overflow-x-auto max-h-64">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                    <tr>
                      {previewColumns.map(c => (
                        <th key={c.key} className="text-left px-2 py-1.5 text-gray-500 whitespace-nowrap">{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {rows.slice(0, 5).map((r, i) => (
                      <tr key={i}>
                        {previewColumns.map(c => (
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
              {isEn
                ? <>✅ <b>{result.created}</b> created, <b>{result.updated}</b> updated</>
                : <>✅ 新建 <b>{result.created}</b> 条,更新 <b>{result.updated}</b> 条</>}
              {result.batchError && (
                <div className="mt-2 border border-red-200 bg-red-50 rounded px-2 py-1.5 text-red-700">⛔ {result.batchError}</div>
              )}
              {result.failed.length > 0 && (
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
              {result.skipped.length > 0 && (
                <span className="block mt-1 text-amber-700">
                  {isEn
                    ? <>⚠ Skipped {result.skipped.length} name collisions: {result.skipped.slice(0, 10).join(', ')}{result.skipped.length > 10 ? '…' : ''}</>
                    : <>⚠ 重名跳过 {result.skipped.length} 条:{result.skipped.slice(0, 10).join('、')}{result.skipped.length > 10 ? '…' : ''}</>}
                </span>
              )}
              {result.warnings.length > 0 && (
                <div className="mt-2">
                  <div className="text-amber-700 mb-1">
                    {isEn ? `⚠ ${result.warnings.length} warnings (fields left unset, nothing silently dropped):` : `⚠ ${result.warnings.length} 条提示(相关字段留空,不会静默丢数据):`}
                  </div>
                  <ul className="max-h-40 overflow-y-auto bg-white border border-amber-200 rounded px-2 py-1.5 space-y-0.5 text-amber-800">
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
                ? (isEn ? `Importing… ${progress}/${rows.length}` : `导入中… ${progress}/${rows.length}`)
                : (isEn ? `Import ${rows.length} rows` : `导入 ${rows.length} 行`)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
