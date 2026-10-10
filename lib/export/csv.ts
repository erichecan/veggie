/**
 * 共用 CSV 序列化：RFC4180 转义 + UTF-8 BOM（Excel 打开中文字段不乱码，
 * 否则 Excel 会按系统 ANSI 代码页猜编码，中文客户名/产品名会显示成乱码）。
 * 供订单列表导出、日销售中心导出两个入口共用，保证格式口径一致。
 */

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = typeof value === 'number' ? String(value) : String(value)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

const BOM = '﻿'

export function buildCsv(headers: readonly string[], rows: unknown[][]): string {
  const lines = [headers, ...rows].map(row => row.map(escapeCsvField).join(','))
  return BOM + lines.join('\r\n')
}

export function csvResponseHeaders(filename: string): HeadersInit {
  // 中文文件名不能直接塞进 filename="..."：那个参数按 RFC 6266 只认 ISO-8859-1，
  // 浏览器不会把里面的 %E9%87%87... 解码回中文，而是直接拿它当文件名存盘。
  // 真正能让浏览器还原出中文名的是 filename*=UTF-8''<percent-encoded>，
  // 旧版 filename= 留一个去掉非 ASCII 字符的兜底名，双保险。
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'") || 'export.csv'
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  }
}

export function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2)
}
