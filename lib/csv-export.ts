/**
 * lib/csv-export.ts
 * 统一 CSV 导出/解析 —— 导出带 UTF-8 BOM,Excel 双击直接打开不乱码。
 */

/**
 * 解析 CSV/TSV 等分隔文本为行数组(支持引号包裹、内嵌分隔符/换行、CRLF、BOM)。
 * @param sep 字段分隔符，默认逗号；传 '\t'/';' 可解析 TSV / 分号分隔文件
 *   (20261003 收编 lib/import-parser.ts 里裸 split 的那份解析器——那份不认引号包裹的
 *   分隔符，商品名/备注里带逗号会把整行列错位)。
 */
export function parseCsv(text: string, sep = ','): string[][] {
  const s = text.replace(/^\ufeff/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++ } else inQuotes = false
      } else cell += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === sep) {
      row.push(cell); cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cell); cell = ''
      rows.push(row); row = []
    } else {
      cell += ch
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row) }
  // 去掉全空行
  return rows.filter(r => r.some(c => c.trim() !== ''))
}

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
