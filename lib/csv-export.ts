/**
 * lib/csv-export.ts
 * 统一 CSV 导出 —— 带 UTF-8 BOM,Excel 双击直接打开不乱码。
 */

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  // 含逗号/引号/换行的单元格需加引号包裹,内部引号翻倍
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * 下载 CSV 文件。
 * @param filename 文件名(不带扩展名,自动拼 .csv)
 * @param headers  表头行
 * @param rows     数据行(与表头同序)
 */
export function downloadCsv(filename: string, headers: string[], rows: unknown[][]) {
  const lines = [headers, ...rows].map(r => r.map(escapeCell).join(','))
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
