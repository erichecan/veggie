/**
 * 浏览器端 CSV 下载 —— 给「数据已经在前端、筛选也在前端做」的列表页用。
 * 这类页面不能走 /api/export/<entity>：服务端不认识那些客户端筛选条件，
 * 结果会是"导出全部"而屏幕只显示一部分。
 */
export function downloadCsvLocal(filename: string, csv: string): void {
  // BOM 已由 buildCsv 加在字符串头部，这里用 charset=utf-8 的 Blob 原样带出去
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
