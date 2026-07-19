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

export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers, ...rows].map(row => row.map(escapeCsvField).join(','))
  return BOM + lines.join('\r\n')
}

export function csvResponseHeaders(filename: string): HeadersInit {
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
  }
}

export function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2)
}
