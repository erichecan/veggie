/**
 * lib/xlsx-export.ts
 * 通用 Excel(.xlsx) 导出——扁平表场景用，跟 lib/csv-export.ts 的 downloadCsv 是同一形状，
 * 只是输出格式换成 xlsx（xlsx 库已是项目既有依赖，见 components/reporting/export-excel.ts）。
 */
import * as XLSX from 'xlsx'

export function downloadXlsx(filename: string, headers: string[], rows: unknown[][], sheetName = 'Sheet1') {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  XLSX.writeFile(wb, `${filename}.xlsx`)
}
