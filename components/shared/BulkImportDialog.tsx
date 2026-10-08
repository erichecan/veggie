'use client'
import { useEffect, useRef, useState } from 'react'
import { useLocale } from 'next-intl'
import { toast } from 'sonner'
import { routing } from '@/i18n/routing'
import { apiGet, apiPost } from '@/lib/api'
import { downloadCsv, parseCsv } from '@/lib/csv-export'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'

/**
 * 全站通用批量导入对话框 —— 从 ProductImportDialog(20260930)抽出来的壳，各模块
 * 只传自己的列定义/示例行/接口地址/说明文案，循环控制(下载模板/解析/预览/分批提交/
 * 结果展示)统一在这里，行为与原商品导入弹窗逐一对应。
 *
 * 20261008 增加(全站所有导入弹窗同时生效)：
 *   - 试运行：先完整跑一遍(服务端逐行事务执行后回滚)，看新建/更新/失败多少条，再决定正式导入
 *   - 失败行下载：把失败/被跳过的原始行 + 原因下载成 CSV，改好直接再导入
 *   - 直接读 Excel(.xlsx/.xls)，不用先另存 CSV
 *   - 导入历史：谁、什么时候、哪个文件、各多少条(传了 historyResource 才显示)
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
  dryRun?: boolean
}

interface ImportHistoryItem {
  importId: string
  fileName: string
  userName: string
  startedAt: string
  batches: number
  created: number
  updated: number
  skipped: number
  failed: number
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
  /** 导入历史按哪个模块查(与服务端 auditLog.resource 一致，如 'product')；不传不显示历史 */
  historyResource?: string
}

/** 从 "Row 12 (xxx): reason" 这类服务端提示里取出行号(整份文件里的第几条数据行，从 1 开始) */
/** 哪些警告意味着「这一行(或这一行的规则)没写进去」——这些行也进「下载问题行」 */
const PROBLEM_WARNING = /skipped|跳过|not added|not imported/i

function rowNoOf(message: string): number | null {
  const m = /^Row (\d+)\b/.exec(message)
  return m ? Number(m[1]) : null
}

async function readSheet(file: File): Promise<string[][]> {
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    // 按需加载：xlsx 库不小，只有真选了 Excel 文件才下载
    const XLSX = await import('xlsx')
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    if (!sheet) return []
    // raw:false = 取单元格显示出来的文字(日期/数字按 Excel 里看到的格式)，与 CSV 口径一致
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: false })
    return aoa.map(r => r.map(v => (v === null || v === undefined ? '' : String(v))))
  }
  return parseCsv(await file.text())
}

export default function BulkImportDialog({
  open, onClose, onDone, templateFileName, columns, exampleRows, endpoint, title, hint, extraHint, batchSize = 100,
  historyResource,
}: BulkImportDialogProps) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const fileRef = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<BulkImportResult | null>(null)
  /** 原始表头 + 与 rows 一一对应的原始行(下载失败行时原样写回去) */
  const [sourceHeader, setSourceHeader] = useState<string[]>([])
  const [sourceRows, setSourceRows] = useState<string[][]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState<ImportHistoryItem[] | null>(null)

  useEffect(() => {
    if (!showHistory || !historyResource) return
    apiGet<{ items: ImportHistoryItem[] }>(`/api/import-history?resource=${encodeURIComponent(historyResource)}`)
      .then(r => setHistory(r.items))
      .catch(() => setHistory([]))
  }, [showHistory, historyResource, result])

  const importableColumns = columns.filter((c): c is BulkImportColumn & { key: string } => !!c.key)

  function reset() {
    setRows([]); setFileName(''); setResult(null); setSourceHeader([]); setSourceRows([])
    if (fileRef.current) fileRef.current.value = ''
  }

  function downloadTemplate() {
    downloadCsv(templateFileName, columns.map(c => c.label), exampleRows)
  }

  async function pickFile(file: File) {
    let parsed: string[][]
    try {
      parsed = await readSheet(file)
    } catch {
      toast.error(isEn ? 'Could not read this file — please use .csv or .xlsx' : '读不了这个文件——请用 .csv 或 .xlsx')
      return
    }
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

    const dataRows: Record<string, string>[] = []
    const keptSource: string[][] = []
    for (const r of parsed.slice(1)) {
      const obj: Record<string, string> = {}
      for (const c of importableColumns) {
        const idx = colIdx.get(c.key)
        if (idx === undefined) continue
        const raw = (r[idx] ?? '').trim()
        if (!raw) continue
        obj[c.key] = c.parse ? c.parse(raw) : raw
      }
      if (!Object.values(obj).some(v => v)) continue
      dataRows.push(obj)
      keptSource.push(r)
    }
    if (dataRows.length === 0) {
      toast.error(isEn ? 'No valid data rows' : '没有有效数据行')
      return
    }
    setFileName(file.name)
    setRows(dataRows)
    setSourceHeader(parsed[0])
    setSourceRows(keptSource)
    setResult(null)
  }

  /** 失败行 + 被跳过(缺必填等)的行，按原始列原样导出，末尾加一列原因 */
  function downloadProblemRows() {
    if (!result) return
    const reasons = new Map<number, string[]>()
    const add = (msg: string) => {
      const n = rowNoOf(msg)
      if (n === null) return
      reasons.set(n, [...(reasons.get(n) ?? []), msg.replace(/^Row \d+( \([^)]*\))?:\s*/, '')])
    }
    result.failed.forEach(add)
    result.warnings.filter(w => PROBLEM_WARNING.test(w)).forEach(add)
    const nums = [...reasons.keys()].sort((a, b) => a - b).filter(n => sourceRows[n - 1])
    if (nums.length === 0) {
      toast.info(isEn ? 'No rows with a row number to export' : '没有可导出的问题行')
      return
    }
    const base = fileName.replace(/\.(csv|xlsx|xls)$/i, '')
    downloadCsv(
      `${base}-${isEn ? 'failed-rows' : '失败行'}`,
      [...sourceHeader, isEn ? 'Import Error' : '导入失败原因'],
      nums.map(n => [...sourceRows[n - 1], (reasons.get(n) ?? []).join('; ')]),
    )
  }

  async function submit(dryRun = false) {
    setBusy(true)
    setProgress(0)
    const total: BulkImportResult = { created: 0, updated: 0, skipped: [], failed: [], warnings: [], dryRun }
    // 同一次导入的各批共用一个 importId，导入历史按它合并成一行
    const importId = dryRun ? undefined : (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      for (let start = 0, batch = 1; start < rows.length; start += batchSize, batch++) {
        const end = Math.min(start + batchSize, rows.length)
        try {
          const r = await apiPost<BulkImportResult>(endpoint, {
            rows: rows.slice(start, end), rowOffset: start, dryRun, importId, fileName, batch,
          })
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
      if (dryRun) {
        toast.info(isEn
          ? `Dry run: ${total.created} would be created, ${total.updated} updated, ${total.skipped.length} skipped, ${total.failed.length} failed — nothing was saved`
          : `试运行:将新建 ${total.created},更新 ${total.updated},跳过 ${total.skipped.length},失败 ${total.failed.length}——没有写入任何数据`)
        return
      }
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
            accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
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
            <div className={`border rounded-lg px-3 py-2 text-xs ${result.dryRun ? 'border-blue-200 bg-blue-50 text-blue-900' : 'border-green-200 bg-green-50 text-green-800'}`}>
              {result.dryRun && (
                <div className="mb-1 font-semibold">
                  {isEn ? '🧪 Dry run — nothing was saved. Check the result, then click “Import” to do it for real.' : '🧪 试运行结果——没有写入任何数据。确认无误后点「导入」正式执行。'}
                </div>
              )}
              {result.dryRun
                ? (isEn
                  ? <>Would create <b>{result.created}</b>, update <b>{result.updated}</b></>
                  : <>将新建 <b>{result.created}</b> 条,更新 <b>{result.updated}</b> 条</>)
                : (isEn
                  ? <>✅ <b>{result.created}</b> created, <b>{result.updated}</b> updated</>
                  : <>✅ 新建 <b>{result.created}</b> 条,更新 <b>{result.updated}</b> 条</>)}
              {(result.failed.length > 0 || result.warnings.some(w => PROBLEM_WARNING.test(w))) && (
                <button onClick={downloadProblemRows} className="ml-3 text-purple-700 hover:underline">
                  {isEn ? '⬇ Download failed/skipped rows (CSV)' : '⬇ 下载失败/跳过的行(CSV)'}
                </button>
              )}
              {result.batchError && (
                <div className="mt-2 border border-red-200 bg-red-50 rounded px-2 py-1.5 text-red-700">⛔ {result.batchError}</div>
              )}
              {result.failed.length > 0 && (
                <div className="mt-2">
                  <div className="text-red-700 mb-1">
                    {isEn
                      ? (result.dryRun ? `⛔ ${result.failed.length} rows would fail:` : `⛔ ${result.failed.length} rows failed (not imported; all other rows were imported):`)
                      : (result.dryRun ? `⛔ ${result.failed.length} 行会失败:` : `⛔ ${result.failed.length} 行导入失败(这些行没进去,其它行已正常导入):`)}
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

          {historyResource && (
            <div className="text-xs">
              <button onClick={() => setShowHistory(v => !v)} className="text-purple-700 hover:underline">
                {showHistory ? '▾' : '▸'} {isEn ? 'Import history' : '导入历史'}
              </button>
              {showHistory && (
                <div className="mt-1 border border-gray-200 rounded-lg overflow-x-auto max-h-48">
                  {history === null ? (
                    <div className="px-3 py-2 text-gray-400">{isEn ? 'Loading…' : '加载中…'}</div>
                  ) : history.length === 0 ? (
                    <div className="px-3 py-2 text-gray-400">{isEn ? 'No imports recorded yet' : '还没有导入记录'}</div>
                  ) : (
                    <table className="w-full">
                      <thead className="bg-gray-50 text-gray-500 sticky top-0">
                        <tr>
                          <th className="text-left px-2 py-1">{isEn ? 'Time' : '时间'}</th>
                          <th className="text-left px-2 py-1">{isEn ? 'By' : '操作人'}</th>
                          <th className="text-left px-2 py-1">{isEn ? 'File' : '文件'}</th>
                          <th className="text-right px-2 py-1">{isEn ? 'Created' : '新建'}</th>
                          <th className="text-right px-2 py-1">{isEn ? 'Updated' : '更新'}</th>
                          <th className="text-right px-2 py-1">{isEn ? 'Skipped' : '跳过'}</th>
                          <th className="text-right px-2 py-1">{isEn ? 'Failed' : '失败'}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {history.map(h => (
                          <tr key={h.importId}>
                            <td className="px-2 py-1 whitespace-nowrap">{new Date(h.startedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</td>
                            <td className="px-2 py-1 whitespace-nowrap">{h.userName}</td>
                            <td className="px-2 py-1 max-w-48 truncate" title={h.fileName}>{h.fileName || '—'}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{h.created}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{h.updated}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{h.skipped}</td>
                            <td className={`px-2 py-1 text-right tabular-nums ${h.failed > 0 ? 'text-red-600' : ''}`}>{h.failed}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => { reset(); onClose() }}>{result ? (isEn ? 'Close' : '关闭') : (isEn ? 'Cancel' : '取消')}</Button>
          {(!result || result.dryRun) && (
            <>
              <Button variant="outline" disabled={busy || rows.length === 0} onClick={() => submit(true)}>
                {isEn ? '🧪 Dry run' : '🧪 试运行'}
              </Button>
              <Button disabled={busy || rows.length === 0} onClick={() => submit(false)}>
                {busy
                  ? (isEn ? `Working… ${progress}/${rows.length}` : `处理中… ${progress}/${rows.length}`)
                  : (isEn ? `Import ${rows.length} rows` : `导入 ${rows.length} 行`)}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
