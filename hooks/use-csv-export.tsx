'use client'
/**
 * 列表页导出按钮的统一实现 —— 返回一个可以直接塞进 OdooControlPanel
 * permanentActions / actions 的 ActionItem。
 * ============================================================================
 * 两种模式对应两类列表页（见 docs/20260818-global-csv-export-design-and-tasks.md §4.3）：
 *
 *   S 服务端：页面是服务端分页+服务端筛选 → 把列表当前的 querystring 原样交给
 *             /api/export/<entity>，导出的是**当前筛选下的全部结果**，不是当前页。
 *   C 客户端：页面是全量拉取+客户端筛选 → 用同一份列定义把屏幕上的 rows 转 CSV。
 *
 * 按钮文案、loading 态、失败 toast、截断提示都在这里，页面不再各写一遍。
 *
 * 字段可选（20260930）：调用方传了 `columns` 就会先弹一个勾选框（见
 * components/shared/export-field-picker-dialog.tsx），选完才真正下载/生成 CSV ——
 * 没传 columns 的调用方（多数财务类页面）保持旧行为，点了就直接导出全部列。
 * `dialog` 字段是弹窗本体，调用方必须在自己的 JSX 里渲染它，否则永远弹不出来。
 */
import { useCallback, useState, type ReactNode } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { downloadAuthedFile } from '@/lib/print/open-pdf'
import { buildCsv } from '@/lib/export/csv'
import { downloadCsvLocal } from '@/lib/export/download'
import { exportHeaders, exportRows, filterColumnsByKeys, type ExportColumn } from '@/lib/export/types'
import type { ExportEntityKey } from '@/lib/export/entities'
import ExportFieldPickerDialog from '@/components/shared/export-field-picker-dialog'

type ColumnsOption<T> = readonly ExportColumn<T>[] | ((isEn: boolean) => readonly ExportColumn<T>[])

interface ServerExportOptions<T> {
  entity: ExportEntityKey
  /**
   * 列表当前的筛选参数。传函数而不是值 —— 点按钮的那一刻才求值，
   * 拿到的一定是最新筛选，不会因为闭包捕获了旧值而导出上一次的条件。
   */
  params: () => string | URLSearchParams
  /** 文件名回落值（正常情况下用服务端 Content-Disposition 里的名字） */
  fallbackFilename?: string
  /** 传了才会弹字段勾选框；用来生成勾选项文案，实际过滤在服务端按 ?fields= 做 */
  columns?: ColumnsOption<T>
}

interface LocalExportOptions<T> {
  columns: readonly ExportColumn<T>[]
  /** 屏幕上当前显示（已筛选、已排序）的那批行 */
  rows: () => readonly T[]
  filenameZh: string
  filenameEn: string
  /** 默认 true：本地导出也先弹字段勾选框；传 false 保留旧的"点了就全量导出"行为 */
  pickFields?: boolean
}

export interface ExportAction {
  label: string
  onClick: () => void
  disabled: boolean
  /** 字段勾选弹窗；没有可勾选字段时为 null。调用方需要把它放进自己的 JSX 树里 */
  dialog: ReactNode
}

function isServerMode<T>(o: ServerExportOptions<T> | LocalExportOptions<T>): o is ServerExportOptions<T> {
  return 'entity' in o
}

export function useCsvExport<T>(options: ServerExportOptions<T> | LocalExportOptions<T>): ExportAction {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [exporting, setExporting] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  const rawColumns = options.columns
  const resolvedColumns: readonly ExportColumn<T>[] | null = rawColumns
    ? (typeof rawColumns === 'function' ? rawColumns(isEn) : rawColumns)
    : null

  const runExport = useCallback(async (selectedKeys: string[] | null) => {
    if (exporting) return
    setExporting(true)
    try {
      if (isServerMode(options)) {
        const raw = options.params()
        const qs = typeof raw === 'string' ? raw : raw.toString()
        const sep = qs ? '&' : ''
        let url = `/api/export/${options.entity}?${qs}${sep}locale=${isEn ? 'en' : 'zh'}`
        // 全选等价于不传 fields(服务端默认给全部列)，URL 干净一点
        if (selectedKeys && resolvedColumns && selectedKeys.length < resolvedColumns.length) {
          url += `&fields=${selectedKeys.map(encodeURIComponent).join(',')}`
        }
        const { truncatedTotal } = await downloadAuthedFile(
          url,
          options.fallbackFilename ?? `${options.entity}.csv`,
        )
        if (truncatedTotal !== null) {
          toast.warning(
            isEn
              ? `Result has ${truncatedTotal} rows, only the first 20000 were exported`
              : `符合条件的共 ${truncatedTotal} 行，本次只导出了前 20000 行`,
          )
        }
      } else {
        const rows = options.rows()
        if (rows.length === 0) {
          toast.info(isEn ? 'Nothing to export' : '当前没有可导出的数据')
          return
        }
        const cols = selectedKeys ? filterColumnsByKeys(options.columns, selectedKeys) : options.columns
        const csv = buildCsv(exportHeaders(cols, isEn), exportRows(cols, rows))
        const today = new Date().toISOString().slice(0, 10)
        downloadCsvLocal(`${isEn ? options.filenameEn : options.filenameZh}-${today}.csv`, csv)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Export failed' : '导出失败'))
    } finally {
      setExporting(false)
    }
  }, [exporting, options, isEn, resolvedColumns])

  const wantsPicker = resolvedColumns !== null
    && (isServerMode(options) ? true : (options.pickFields ?? true))

  const onClick = useCallback(() => {
    if (exporting) return
    if (wantsPicker) { setPickerOpen(true); return }
    runExport(null)
  }, [exporting, wantsPicker, runExport])

  const dialog = resolvedColumns ? (
    <ExportFieldPickerDialog
      open={pickerOpen}
      onClose={() => setPickerOpen(false)}
      columns={resolvedColumns}
      isEn={isEn}
      onConfirm={(keys) => { setPickerOpen(false); runExport(keys) }}
    />
  ) : null

  return {
    label: exporting ? (isEn ? 'Exporting…' : '导出中…') : (isEn ? 'Export' : '导出'),
    onClick,
    disabled: exporting,
    dialog,
  }
}
