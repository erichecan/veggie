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
 * 商品批量导入对话框(20260930) —— 专用于 /api/products/bulk，不复用通用的
 * CsvImportDialog(那个组件被 4+ 个简单的扁平 CSV 导入器共用，这里的字段丰富得多，
 * 单独做一个平行组件更合适)。
 *
 * 列头与 lib/export/columns/product-templates.ts 的导出列**逐一对应**(同一份
 * ProductNo/Internal Reference/.../Sellable Units 顺序)，保证"导出 → Excel 改 →
 * 重新导入"这条路径能直接用同一份文件；文件里额外带出的 Product No./Sequence/
 * Forecast Quantity/Created·Updated 这几列是导出时的只读信息，这里读到了也直接
 * 忽略，不当错误处理。
 *
 * 末尾另加 Description/Spec/Status/Can Be Sold/Can Be Purchased/Tracking 六列 ——
 * 导出里没有它们(那几列这次没加进屏幕/导出范围)，但批量导入本身要支持这些字段，
 * 所以模板里单独补上，不影响前 26 列跟导出文件的逐字对应关系。
 */

interface ImportColumn {
  /** CSV 表头文字，同时是下载模板时写入的表头 */
  label: string
  /** 提交给 API 的 JSON 字段名；不填 = 这一列只读/忽略，不参与提交(如 Product No.) */
  key?: string
  required?: boolean
  /** 原始单元格文本 → API 期望的值；不填 = 原样传字符串(服务端自己再解析数字/布尔) */
  parse?: (raw: string) => string
}

const TYPE_LABEL_TO_CODE: Record<string, string> = {
  'storable product': 'product',
  'consumable': 'consu',
  'service': 'service',
  '可库存商品': 'product',
  '耗材': 'consu',
  '服务': 'service',
}

/** "Customer Taxes (%)"/"Vendor Taxes (%)" 导出时是 13.5 这样的百分数(见
 * lib/export/columns/product-templates.ts 的 taxPercent())，库里存的是小数 0.135——
 * 导入要在这里除回去，不能指望服务端猜单位。 */
function percentToFraction(raw: string): string {
  const n = Number(raw)
  return Number.isFinite(n) ? String(n / 100) : raw
}

/** 允许直接填 product/consu/service，也允许原样贴导出出来的英文长标签(Storable Product 等)。 */
function normalizeType(raw: string): string {
  const s = raw.trim().toLowerCase()
  return TYPE_LABEL_TO_CODE[s] ?? s
}

const COLUMNS: ImportColumn[] = [
  { label: 'Product No.' },
  { label: 'Internal Reference', key: 'internalRef' },
  { label: 'Barcode', key: 'barcode' },
  { label: 'ID', key: 'externalId' },
  { label: 'Sequence' },
  { label: 'Name', key: 'name', required: true },
  { label: 'Sale Description', key: 'saleDescription' },
  { label: 'Sale Price (€)', key: 'listPrice' },
  { label: 'Customer Taxes (%)', key: 'customerTaxRate', parse: percentToFraction },
  { label: 'Cost (€)', key: 'standardPrice' },
  { label: 'Vendor Taxes (%)', key: 'vendorTaxRate', parse: percentToFraction },
  { label: 'Weight (kg)', key: 'weight' },
  { label: 'Net Weight (kg)', key: 'netWeight' },
  { label: 'Volume (L)', key: 'volume' },
  { label: 'Quantity On Hand', key: 'qtyOnHand' },
  { label: 'Forecast Quantity' },
  { label: 'Product Category', key: 'category' },
  { label: 'Unit of Measure', key: 'uomName' },
  { label: 'Purchase UoM', key: 'purchaseUomName' },
  { label: 'Sellable Units (unit:factor:default)', key: 'saleUoms' },
  { label: 'Product Type', key: 'type', parse: normalizeType },
  { label: 'Commission Price (€)', key: 'commissionPrice' },
  { label: 'Created by' },
  { label: 'Created on' },
  { label: 'Last Updated by' },
  { label: 'Last Updated on' },
  { label: 'Description', key: 'description' },
  { label: 'Spec', key: 'spec' },
  { label: 'Status', key: 'status' },
  { label: 'Can Be Sold', key: 'canBeSold' },
  { label: 'Can Be Purchased', key: 'canBePurchased' },
  { label: 'Tracking', key: 'tracking' },
]

const IMPORTABLE_COLUMNS = COLUMNS.filter((c): c is ImportColumn & { key: string } => !!c.key)

const EXAMPLE_ROWS: string[][] = [
  // 示例 1：多规格(基础单位 PKT，另有整箱 CASE)
  ['', '', '', '', '', 'ASIAN CHOICE Black Tiger Shrimp 700g', '', '12.50', '13.5', '8.00', '13.5',
    '0.7', '0.7', '', '100', '', 'Frozen', 'PKT', 'CASE', 'PKT:1:Y; CASE:10:N', 'consu', '1.00',
    '', '', '', '', '', '', 'active', 'Y', 'Y', 'none'],
  // 示例 2：单一单位，不配可售单位
  ['', 'DEMO-002', '', '', '', 'Demo Potato 5kg Bag', '', '6.90', '0', '4.20', '0',
    '5', '5', '', '50', '', '', 'KG', 'KG', '', 'consu', '',
    '', '', '', '', '', '', 'active', 'Y', 'Y', 'none'],
]

interface ImportResult { created: number; updated: number; skipped: string[]; warnings: string[] }

export default function ProductImportDialog({
  open, onClose, onDone,
}: {
  open: boolean
  onClose: () => void
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
    downloadCsv('products-import-template', COLUMNS.map(c => c.label), EXAMPLE_ROWS)
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
    for (const c of IMPORTABLE_COLUMNS) {
      const idx = header.findIndex(h => h === c.label.toLowerCase())
      if (idx >= 0) colIdx.set(c.key, idx)
    }
    const missing = IMPORTABLE_COLUMNS.filter(c => c.required && !colIdx.has(c.key))
    if (missing.length > 0) {
      toast.error(isEn ? `Missing required columns: ${missing.map(c => c.label).join(', ')}` : `缺少必填列:${missing.map(c => c.label).join('、')}`)
      return
    }

    const dataRows = parsed.slice(1)
      .map(r => {
        const obj: Record<string, string> = {}
        for (const c of IMPORTABLE_COLUMNS) {
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
    try {
      const r = await apiPost<ImportResult>('/api/products/bulk', { rows })
      setResult(r)
      toast.success(
        isEn
          ? `Import finished: ${r.created} created, ${r.updated} updated, ${r.skipped.length} skipped`
          : `导入完成:新建 ${r.created},更新 ${r.updated},跳过 ${r.skipped.length}`,
      )
      onDone?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Import failed' : '导入失败'))
    } finally {
      setBusy(false)
    }
  }

  const previewColumns = IMPORTABLE_COLUMNS.filter(c => rows.some(r => r[c.key]))

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) { reset(); onClose() } }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isEn ? 'Bulk Import Products (CSV)' : '批量导入商品(CSV)'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
            <span className="text-xs text-gray-600">
              {isEn
                ? 'Row 1 is the header. Columns match the product export exactly, so an exported CSV can be edited and re-imported. Name is the only required column.'
                : '第一行为表头。列名与商品导出完全一致，导出的 CSV 改完可直接重新导入。仅「Name」必填。'}
            </span>
            <button onClick={downloadTemplate} className="text-xs text-purple-700 hover:underline whitespace-nowrap ml-2">
              {isEn ? '⬇ Download template' : '⬇ 下载模板'}
            </button>
          </div>

          <div className="text-xs text-gray-500 bg-purple-50/50 border border-purple-100 rounded-lg px-3 py-2">
            {isEn
              ? <>Matched by Internal Reference → Barcode → ID (exact match) updates that product; otherwise a name collision is skipped, no match creates a new one. Format for <b>Sellable Units</b>: <code>UomName:factor:Y|N</code> separated by <code>;</code>, e.g. <code>PKT:1:Y; CASE:10:N</code>.</>
              : <>按「内部编号 → 条码 → ID」精确匹配更新对应商品;都没匹配上则按名称判重(撞了跳过,不覆盖),否则新建。<b>可售单位</b>格式:<code>单位名:系数:Y|N</code>,用 <code>;</code> 分隔,如 <code>PKT:1:Y; CASE:10:N</code>。</>}
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
